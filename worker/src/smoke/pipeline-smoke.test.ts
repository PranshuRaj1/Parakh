/**
 * Pipeline Smoke Test
 *
 * Exercises the REAL orchestration wiring end-to-end with only the leaf
 * dependencies (GitHub API, DB, Redis, LLM) mocked. This is the regression
 * suite for the incident where a `@parakh review` comment was enqueued as a
 * COMMENT_RESPONSE job but never produced a review:
 *
 *   https://... webhook → handleQueueBatch → executeCommentResponseJob
 *     → triggerReview → WATCHDOG_QUEUE.send(REVIEW payload)
 *
 * If any link in that chain is broken (uncaught throw before enqueue, wrong
 * payload shape, classifier swallowing the request), the review job is never
 * sent and these tests fail — so they run on every pre-push.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobPayload } from '@parakh/shared';
import type { Env } from '../index.js';

// ─── Leaf-dependency mocks (network + DB + LLM) ─────────────────────────────

vi.mock('../github/auth.js', () => ({ getCachedToken: vi.fn() }));

vi.mock('../github/api.js', () => ({
  fetchDiff: vi.fn(),
  fetchDiffPinned: vi.fn(),
  getPRDetails: vi.fn(),
  postComment: vi.fn(),
  postCommentOnce: vi.fn(),
  replyToReviewComment: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  addCommentReaction: vi.fn(),
  removeCommentReaction: vi.fn(),
}));

vi.mock('../db/reviews.js', () => ({
  insertReview: vi.fn(),
  updateReviewShaPin: vi.fn(),
  getRepoSettings: vi.fn(),
  updateReviewReactions: vi.fn(),
  setTriggerCommentContext: vi.fn(),
  updateTriggerCommentReactionId: vi.fn(),
  updateReviewStatus: vi.fn(),
  updateReviewResults: vi.fn(),
  getLatestReviewByPR: vi.fn(),
  getRecentReviews: vi.fn(),
  getReviewsByPR: vi.fn(),
  getReview: vi.fn(),
  getResumableReview: vi.fn(),
  dbStartStage: vi.fn(),
  dbCompleteStage: vi.fn(),
  dbFailStage: vi.fn(),
  dbMarkDailyQuotaPaused: vi.fn(),
  dbFindResumableDailyQuotaReviews: vi.fn(),
  recordReviewFileEvent: vi.fn(),
  dbTimeoutStage: vi.fn(),
  dbUpdateReason: vi.fn(),
  dbUpdateReasonDetail: vi.fn(),
  dbUpdateHeartbeat: vi.fn(),
  dbIncrementRetryCount: vi.fn(),
  dbSweepStalledReviews: vi.fn(),
  getRepoSettingsByReviewId: vi.fn(),
  getMatchingStartedEvent: vi.fn(),
  countCompletedReviews: vi.fn(),
  getAvgDurationByStep: vi.fn(),
  getAvgMsPerFile: vi.fn(),
  getCompletedStepsForReview: vi.fn(),
  getLatestReviewingFilesDetail: vi.fn(),
  getStepEventsForReview: vi.fn(),
  saveReviewReasoning: vi.fn(),
  getReviewReasoningForReview: vi.fn(),
  saveReviewReasonings: vi.fn(),
  pruneExpiredReasoning: vi.fn(),
}));

vi.mock('../db/rules.js', () => ({
  getActiveRules: vi.fn(),
  incrementEvidenceCount: vi.fn(),
}));

vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
  createRedisSetNX: vi.fn(),
  createRedisDel: vi.fn(),
  createRedisIncr: vi.fn(),
  createRedisExpire: vi.fn(),
}));

const { classifyIntentMock, draftReplyMock, reviewDiffMock } = vi.hoisted(() => ({
  classifyIntentMock: vi.fn(),
  draftReplyMock: vi.fn(),
  reviewDiffMock: vi.fn(),
}));

vi.mock('../llm/factory.js', () => ({
  createLLMClients: () => ({
    llm: {
      classifyIntent: classifyIntentMock,
      draftReply: draftReplyMock,
      reviewDiff: reviewDiffMock,
    },
  }),
}));

// ─── Imports (real orchestration code) ──────────────────────────────────────

import worker from '../index.js';
import { handleQueueBatch } from '../jobs/queue-handler.js';
import { handleWebhookEvent } from '../webhook/handler.js';
import { buildIntentPrompt } from '../gemini/prompts.js';
import { getCachedToken } from '../github/auth.js';
import { postComment, addReaction, getPRDetails, addCommentReaction } from '../github/api.js';
import { insertReview, getLatestReviewByPR, getResumableReview, getRepoSettings } from '../db/reviews.js';
import { createRedisSetNX, createRedisDel, createRedisGet, createRedisSet, createRedisIncr, createRedisExpire } from '../redis.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  postComment: vi.mocked(postComment),
  addReaction: vi.mocked(addReaction),
  getPRDetails: vi.mocked(getPRDetails),
  addCommentReaction: vi.mocked(addCommentReaction),
  insertReview: vi.mocked(insertReview),
  getLatestReviewByPR: vi.mocked(getLatestReviewByPR),
  getResumableReview: vi.mocked(getResumableReview),
  getRepoSettings: vi.mocked(getRepoSettings),
  createRedisSetNX: vi.mocked(createRedisSetNX),
  createRedisDel: vi.mocked(createRedisDel),
  createRedisGet: vi.mocked(createRedisGet),
  createRedisSet: vi.mocked(createRedisSet),
  createRedisIncr: vi.mocked(createRedisIncr),
  createRedisExpire: vi.mocked(createRedisExpire),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** HMAC-SHA256 signature generator (Web Crypto — same as GitHub sends). */
async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `sha256=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
}

function makeEnv(): { env: Env; sent: JobPayload[] } {
  const sent: JobPayload[] = [];
  const env = {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: 'private-key',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    GITHUB_APP_BOT_USER_ID: '999',
    DATABASE_URL: 'postgres://x',
    UPSTASH_REDIS_URL: 'https://redis',
    UPSTASH_REDIS_TOKEN: 't',
    WORKER_API_SECRET: 'secret',
    WATCHDOG_QUEUE: {
      send: (p: JobPayload) => { sent.push(p); return Promise.resolve(); },
    },
  } as unknown as Env;
  return { env, sent };
}

function commentEvent(body: string): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: 1 },
    repository: { full_name: 'acme/app', owner: { login: 'acme' }, name: 'app' },
    issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/7' } },
    comment: { id: 100, body, user: { login: 'dev', id: 555 } },
  };
}

function prOpenedEvent(): Record<string, unknown> {
  return {
    action: 'opened',
    installation: { id: 1 },
    repository: { full_name: 'acme/app', owner: { login: 'acme' }, name: 'app' },
    pull_request: { number: 7, head: { sha: 'abc123' }, base: { sha: 'def456' }, user: { login: 'dev' } },
  };
}

function makeCommentMessage(body: string, attempts = 1) {
  return {
    id: 'm1',
    timestamp: new Date(),
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
    deduplicate: vi.fn(),
    log: vi.fn(),
    body: {
      type: 'COMMENT_RESPONSE' as const,
      installationId: 1,
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      commentId: 100,
      commentBody: body,
      commentType: 'issue_comment' as const,
      githubDeliveryId: 'del-comment',
      commenterLogin: 'dev',
    },
  };
}

function setupRedisMocks() {
  mocked.createRedisSetNX.mockReturnValue((async () => true) as never);
  mocked.createRedisDel.mockReturnValue((async () => undefined) as never);
  mocked.createRedisGet.mockReturnValue((async () => null) as never);
  mocked.createRedisSet.mockReturnValue((async () => undefined) as never);
  mocked.createRedisIncr.mockReturnValue((async () => 1) as never);
  mocked.createRedisExpire.mockReturnValue((async () => undefined) as never);
}

function setupReviewLeaves() {
  mocked.getCachedToken.mockResolvedValue('token');
  mocked.getPRDetails.mockResolvedValue({
    head: { sha: 'abc123' },
    base: { sha: 'def456' },
  } as never);
  mocked.getLatestReviewByPR.mockResolvedValue(null as never);
  mocked.insertReview.mockResolvedValue({ id: 'review-1' } as never);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  for (const fn of [classifyIntentMock, draftReplyMock, reviewDiffMock]) fn.mockReset();
  setupRedisMocks();
  setupReviewLeaves();
  mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'all_comments', stuck_timeout_seconds: null } as never);
  classifiedAs('REVIEW_REQUEST');
});

function classifiedAs(intent: string) {
  classifyIntentMock.mockResolvedValue(intent);
}

// ─── HTTP layer ─────────────────────────────────────────────────────────────

describe('webhook HTTP layer (signature + routing)', () => {
  it('accepts a correctly signed comment webhook and dispatches a COMMENT_RESPONSE job', async () => {
    const payload = JSON.stringify(commentEvent('@parakh review'));
    const signature = await sign(payload, 'webhook-secret');
    const { env, sent } = makeEnv();

    const res = await worker.fetch(new Request('https://worker/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'del-1',
      },
      body: payload,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('comment response dispatched');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'COMMENT_RESPONSE', prNumber: 7, commentBody: '@parakh review' });
  });

  it('rejects a webhook with a bad signature (401) and does not enqueue', async () => {
    const payload = JSON.stringify(commentEvent('@parakh review'));
    const signature = await sign(payload, 'WRONG-secret');
    const { env, sent } = makeEnv();

    const res = await worker.fetch(new Request('https://worker/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'del-1',
      },
      body: payload,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('allows a PR-opened webhook through to enqueue a REVIEW job', async () => {
    const payload = JSON.stringify(prOpenedEvent());
    const signature = await sign(payload, 'webhook-secret');
    mocked.addReaction.mockResolvedValue(42);
    const { env, sent } = makeEnv();

    const res = await worker.fetch(new Request('https://worker/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'del-2',
      },
      body: payload,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'REVIEW', prNumber: 7, reviewId: 'review-1' });
  });
});

// ─── Queue wiring ────────────────────────────────────────────────────────────

describe('queue → comment-response → triggerReview wiring', () => {
  it('dispatches a COMMENT_RESPONSE job and posts a review reply', async () => {
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('@parakh review')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(classifyIntentMock).toHaveBeenCalledWith('@parakh review', '');
    // triggerReview must have actually enqueued a REVIEW job.
    expect(mocked.insertReview).toHaveBeenCalled();
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, 'On it — re-reviewing 👀', 'token'
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it('CLASSIFIES AS REVIEW_REQUEST: enqueues a REVIEW job even when the PR-level 👀 reaction fails', async () => {
    // ── THE REGRESSION ───────────────────────────────────────────────────
    // addReaction throwing must NOT abort triggerReview before enqueueing.
    // (Previously this crashed triggerReview → queue job retried forever →
    //  no review ever sent, no reply ever posted.)
    mocked.addReaction.mockRejectedValue(new Error('github hiccup'));
    const { env, sent } = makeEnv();

    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('@parakh review')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.insertReview).toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'REVIEW', prNumber: 7, reviewId: 'review-1' });
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, 'On it — re-reviewing 👀', 'token'
    );
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalled();
  });

  it('still enqueues the review when the trigger-comment 👀 reaction fails (best-effort)', async () => {
    mocked.addCommentReaction.mockRejectedValue(new Error('reaction failed'));
    const { env, sent } = makeEnv();

    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('@parakh re-review')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.insertReview).toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'REVIEW' });
    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, 'On it — re-reviewing 👀', 'token');
  });

  it('does NOT trigger or reply for GENERAL intent (silent by design)', async () => {
    classifiedAs('GENERAL');
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('lol nice')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.insertReview).not.toHaveBeenCalled();
    expect(mocked.postComment).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });

  it('skips a comment that does not mention @parakh in mentioned_only mode', async () => {
    mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'mentioned_only', stuck_timeout_seconds: null } as never);
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('just chatting')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(classifyIntentMock).not.toHaveBeenCalled();
    expect(mocked.insertReview).not.toHaveBeenCalled();
    expect(mocked.postComment).not.toHaveBeenCalled();
  });
});

// ─── Re-requesting a review ─────────────────────────────────────────────────

describe('re-request path (@parakh review on an existing review)', () => {
  it('resumes a resumable review rather than starting a new one', async () => {
    mocked.getResumableReview.mockResolvedValue({ id: 'existing-review' } as never);
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('please review again')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.insertReview).not.toHaveBeenCalled();
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, 'On it — resuming the previous review 👀', 'token'
    );
  });
});

// ─── Classifier prompt guard ────────────────────────────────────────────────

describe('intent prompt hardening (regression guard)', () => {
  it('guarantees that mention + the word "review" is always a REVIEW_REQUEST', () => {
    const prompt = buildIntentPrompt('@parakh review', '');
    expect(prompt).toContain('ALWAYS a REVIEW_REQUEST');
    expect(prompt).toContain('@parakh');
  });

  it('sends the request through handleWebhookEvent for a standalone @parakh review comment', async () => {
    const { env, sent } = makeEnv();
    const result = await handleWebhookEvent(commentEvent('@parakh review'), 'issue_comment', 'del-x', env);
    expect(result.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'COMMENT_RESPONSE', commentBody: '@parakh review' });
  });
});
