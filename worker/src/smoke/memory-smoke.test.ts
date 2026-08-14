/**
 * Memory Layer Smoke Test
 *
 * Exercises the REAL memory orchestration end-to-end with only the leaf
 * dependencies (GitHub API, DB, Redis, LLM) mocked. This is the regression
 * suite for the incidents where a `@parakh` CORRECTION comment ("stop flagging
 * EOF newlines") never became a stored rule:
 *
 *   - intent was misclassified as DISMISSAL/GENERAL instead of CORRECTION
 *   - the embedding fell back to a 1024-dim provider while the rules.embedding
 *     column is vector(768), so the insert died inside Neon
 *
 * Chain under test:
 *
 *   webhook issue_comment → handleWebhookEvent → COMMENT_RESPONSE job
 *     → executeCommentResponseJob → classifyIntent=CORRECTION
 *     → saveCorrectionAsRule (embed → priority → mode → insertRule ACTIVE)
 *     → "✅ **Learned:**" reply → WATCHDOG_QUEUE.send(CONTRADICTION)
 *     → executeContradictionJob (findSimilar → classify → supersede/notify)
 *
 * If any link breaks (uncaught throw before enqueue, wrong payload shape,
 * classifier swallowing the request, dimension guard regression), the rule is
 * never saved and these tests fail — so they run on every pre-push.
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
  getRepoSettings: vi.fn(),
  getResumableReview: vi.fn(),
  insertReview: vi.fn(),
  updateReviewShaPin: vi.fn(),
  updateReviewReactions: vi.fn(),
  setTriggerCommentContext: vi.fn(),
  updateTriggerCommentReactionId: vi.fn(),
  updateReviewStatus: vi.fn(),
  updateReviewResults: vi.fn(),
  getLatestReviewByPR: vi.fn(),
  getRecentReviews: vi.fn(),
  getReviewsByPR: vi.fn(),
  getReview: vi.fn(),
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
  insertRule: vi.fn(),
  findSimilarRules: vi.fn(),
  updateRuleStatus: vi.fn(),
  setRuleSupersedes: vi.fn(),
  incrementReinforcementCount: vi.fn(),
  insertRuleRelationship: vi.fn(),
}));

vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
  createRedisSetNX: vi.fn(),
  createRedisDel: vi.fn(),
}));

const {
  classifyIntentMock,
  draftReplyMock,
  reviewDiffMock,
  generateEmbeddingMock,
  classifyPriorityMock,
  classifyRelationshipMock,
} = vi.hoisted(() => ({
  classifyIntentMock: vi.fn(),
  draftReplyMock: vi.fn(),
  reviewDiffMock: vi.fn(),
  generateEmbeddingMock: vi.fn(),
  classifyPriorityMock: vi.fn(),
  classifyRelationshipMock: vi.fn(),
}));

vi.mock('../llm/factory.js', () => ({
  createLLMClients: () => ({
    llm: {
      classifyIntent: classifyIntentMock,
      draftReply: draftReplyMock,
      reviewDiff: reviewDiffMock,
      generateEmbedding: generateEmbeddingMock,
      classifyPriority: classifyPriorityMock,
      classifyRelationship: classifyRelationshipMock,
    },
  }),
}));

// ─── Imports (real orchestration code) ──────────────────────────────────────

import worker from '../index.js';
import { handleQueueBatch } from '../jobs/queue-handler.js';
import { handleWebhookEvent } from '../webhook/handler.js';
import { getCachedToken } from '../github/auth.js';
import { postComment, replyToReviewComment, addCommentReaction } from '../github/api.js';
import { getRepoSettings } from '../db/reviews.js';
import {
  insertRule,
  findSimilarRules,
  updateRuleStatus,
  setRuleSupersedes,
  incrementReinforcementCount,
  insertRuleRelationship,
} from '../db/rules.js';
import { createRedisSetNX, createRedisDel, createRedisGet, createRedisSet } from '../redis.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  postComment: vi.mocked(postComment),
  replyToReviewComment: vi.mocked(replyToReviewComment),
  addCommentReaction: vi.mocked(addCommentReaction),
  getRepoSettings: vi.mocked(getRepoSettings),
  insertRule: vi.mocked(insertRule),
  findSimilarRules: vi.mocked(findSimilarRules),
  updateRuleStatus: vi.mocked(updateRuleStatus),
  setRuleSupersedes: vi.mocked(setRuleSupersedes),
  incrementReinforcementCount: vi.mocked(incrementReinforcementCount),
  insertRuleRelationship: vi.mocked(insertRuleRelationship),
  createRedisSetNX: vi.mocked(createRedisSetNX),
  createRedisDel: vi.mocked(createRedisDel),
  createRedisGet: vi.mocked(createRedisGet),
  createRedisSet: vi.mocked(createRedisSet),
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

function correctionComment(body: string): Record<string, unknown> {
  return {
    action: 'created',
    installation: { id: 1 },
    repository: { full_name: 'acme/app', owner: { login: 'acme' }, name: 'app' },
    issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/7' } },
    comment: { id: 100, body, user: { login: 'dev', id: 555 } },
  };
}

function makeCommentMessage(body: string, commentType: 'issue_comment' | 'pull_request_review_comment' = 'issue_comment') {
  return {
    id: 'm1',
    timestamp: new Date(),
    attempts: 1,
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
      commentType,
      githubDeliveryId: 'del-memory',
    },
  };
}

function makeContradictionMessage() {
  return {
    id: 'm2',
    timestamp: new Date(),
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
    deduplicate: vi.fn(),
    log: vi.fn(),
    body: {
      type: 'CONTRADICTION' as const,
      installationId: 1,
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      ruleId: 'rule-new',
      ruleBody: 'never flag EOF newline issues',
      embedding: Array(768).fill(0.1),
    },
  };
}

function setupRedisMocks() {
  mocked.createRedisSetNX.mockReturnValue((async () => true) as never);
  mocked.createRedisDel.mockReturnValue((async () => undefined) as never);
  mocked.createRedisGet.mockReturnValue((async () => null) as never);
  mocked.createRedisSet.mockReturnValue((async () => undefined) as never);
}

function setupLeaves() {
  mocked.getCachedToken.mockResolvedValue('token');
  mocked.getRepoSettings.mockResolvedValue({ repo: 'acme/app', reply_mode: 'all_comments', stuck_timeout_seconds: null } as never);
  mocked.insertRule.mockResolvedValue({
    id: 'rule-new', body: 'never flag EOF newline issues', priority: 'normal', kind: 'instruction',
  } as never);
}

function setupLLMMocks() {
  classifyIntentMock.mockResolvedValue('CORRECTION');
  generateEmbeddingMock.mockResolvedValue(Array(768).fill(0.1));
  classifyPriorityMock.mockResolvedValue('normal');
  classifyRelationshipMock.mockResolvedValue('UNRELATED');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  for (const fn of [
    classifyIntentMock, draftReplyMock, reviewDiffMock,
    generateEmbeddingMock, classifyPriorityMock, classifyRelationshipMock,
  ]) fn.mockReset();
  setupRedisMocks();
  setupLeaves();
  setupLLMMocks();
});

// ─── HTTP layer: correction comment webhook → COMMENT_RESPONSE job ───────────

describe('memory: webhook HTTP layer (CORRECTION routing)', () => {
  it('accepts a signed CORRECTION comment webhook and dispatches a COMMENT_RESPONSE job', async () => {
    const body = '@parakh never flag EOF newline issues in any future review';
    const payload = JSON.stringify(correctionComment(body));
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
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'COMMENT_RESPONSE', prNumber: 7, commentBody: body });
  });

  it('ignores the bot\'s own comment (self-loop guard)', async () => {
    const event = correctionComment('@parakh review');
    event.comment!.user.id = 999; // the bot itself
    const payload = JSON.stringify(event);
    const signature = await sign(payload, 'webhook-secret');
    const { env, sent } = makeEnv();

    const res = await worker.fetch(new Request('https://worker/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': signature,
        'x-github-delivery': 'del-2',
      },
      body: payload,
    }), env, {} as ExecutionContext);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

// ─── Queue → comment-response → rule save → contradiction enqueue ────────────

describe('memory: queue → comment-response → saveCorrectionAsRule wiring', () => {
  it('saves a CORRECTION as an ACTIVE rule, posts the Noted reply, and enqueues a CONTRADICTION job', async () => {
    const { env, sent } = makeEnv();
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('@parakh never flag EOF newline issues in any future review')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    // The full learn chain must run. Intent is classified on the RAW comment
    // (in comment-response), but the stored rule text has the @parakh command
    // prefix stripped (correction.ts) before embedding/priority. The directive
    // phrasing marks it an 'instruction' rule (suppression), never a standard.
    expect(classifyIntentMock).toHaveBeenCalledWith('@parakh never flag EOF newline issues in any future review', '');
    expect(generateEmbeddingMock).toHaveBeenCalledWith('never flag EOF newline issues in any future review');
    expect(classifyPriorityMock).toHaveBeenCalledWith('never flag EOF newline issues in any future review');
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/app',
        body: 'never flag EOF newline issues in any future review',
        status: 'ACTIVE',
        priority: 'normal',
        kind: 'instruction',
        source_pr: 7,
      }),
      env
    );

    // Confirmation reply — instruction rules get the "Noted" suppression reply.
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Noted'), 'token'
    );

    // Contradiction check enqueued with the rule payload (real installationId).
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'CONTRADICTION',
      installationId: 1,
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      ruleId: 'rule-new',
      ruleBody: 'never flag EOF newline issues in any future review',
    });
    expect((sent[0] as { embedding: number[] }).embedding).toHaveLength(768);

    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it('stores plain corrections (no suppression phrasing) as standard rules', async () => {
    const { env, sent } = makeEnv();
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('use snake_case for database columns')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'standard' }),
      env
    );
    expect(sent).toHaveLength(1);
  });

  it('replies gracefully and acks when saving the correction fails (no uncaught throw)', async () => {
    generateEmbeddingMock.mockRejectedValue(new Error('embedding failed'));
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('never flag EOF newline issues')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining("Couldn't save that right now"), 'token'
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it('replies into the diff thread for pull_request_review_comment corrections', async () => {
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeCommentMessage('never flag EOF newline issues', 'pull_request_review_comment')],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.replyToReviewComment).toHaveBeenCalledWith(
      'acme', 'app', 7, 100, expect.stringContaining('Noted'), 'token'
    );
    expect(mocked.postComment).not.toHaveBeenCalled();
  });
});

// ─── Contradiction job dispatch + supersession ───────────────────────────────

describe('memory: CONTRADICTION job wiring', () => {
  it('routes a CONTRADICTION payload to the contradiction engine and acks', async () => {
    mocked.findSimilarRules.mockResolvedValue([]);
    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeContradictionMessage()],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.findSimilarRules).toHaveBeenCalledWith(
      'acme/app', expect.any(Array), 0.7, 5, env, 'rule-new'
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });

  it('supersedes a contradictory rule and notifies the PR', async () => {
    mocked.findSimilarRules.mockResolvedValue([{
      id: 'rule-old', repo: 'acme/app', body: 'flag EOF newline issues as critical',
      status: 'ACTIVE', scope: {}, priority: 'normal', kind: 'standard',
      supersedes: null, superseded_by: null, source_pr: null, evidence_count: 0,
      reinforcement_count: 0, created_at: '2024-01-01T00:00:00Z', superseded_at: null,
      similarity: 0.9,
    }]);
    classifyRelationshipMock.mockResolvedValue('CONTRADICTION');

    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeContradictionMessage()],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.updateRuleStatus).toHaveBeenCalledWith('rule-old', 'SUPERSEDED', env, 'rule-new');
    expect(mocked.setRuleSupersedes).toHaveBeenCalledWith('rule-new', 'rule-old', env);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Superseded rule'), 'token'
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });

  it('deactivates the new rule and reinforces the existing one on DUPLICATE', async () => {
    mocked.findSimilarRules.mockResolvedValue([{
      id: 'rule-old', repo: 'acme/app', body: 'never flag EOF newline issues',
      status: 'ACTIVE', scope: {}, priority: 'normal', kind: 'instruction',
      supersedes: null, superseded_by: null, source_pr: null, evidence_count: 0,
      reinforcement_count: 0, created_at: '2024-01-01T00:00:00Z', superseded_at: null,
      similarity: 0.9,
    }]);
    classifyRelationshipMock.mockResolvedValue('DUPLICATE');

    const env = makeEnv().env;
    const batch = {
      queue: 'watchdog',
      messages: [makeContradictionMessage()],
    } as never;

    await handleQueueBatch(batch as Parameters<typeof handleQueueBatch>[0], env);

    expect(mocked.updateRuleStatus).toHaveBeenCalledWith('rule-new', 'INACTIVE', env);
    expect(mocked.incrementReinforcementCount).toHaveBeenCalledWith('rule-old', env);
    expect(mocked.insertRuleRelationship).toHaveBeenCalledWith('rule-new', 'rule-old', 'DUPLICATE', env);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Duplicate rule detected'), 'token'
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
  });
});

// ─── Webhook handler dispatch for standalone correction ──────────────────────

describe('memory: handleWebhookEvent dispatch', () => {
  it('dispatches a COMMENT_RESPONSE job for a standalone correction comment', async () => {
    const { env, sent } = makeEnv();
    const result = await handleWebhookEvent(
      correctionComment('never flag EOF newline issues'),
      'issue_comment', 'del-x', env
    );
    expect(result.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'COMMENT_RESPONSE', commentBody: 'never flag EOF newline issues' });
  });
});
