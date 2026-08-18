import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWebhookEvent } from './handler.js';
import type { Env } from '../index.js';

// ─── Dependency Mocks ────────────────────────────────────────────────────────

vi.mock('../github/api.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  postComment: vi.fn(),
}));

vi.mock('../github/auth.js', () => ({
  getCachedToken: vi.fn(),
}));

vi.mock('../db/reviews.js', () => ({
  insertReview: vi.fn(),
  getLatestReviewByPR: vi.fn(),
  updateReviewReactions: vi.fn(),
}));

vi.mock('../db/installations.js', () => ({
  upsertInstallation: vi.fn(),
  markInstallationRemoved: vi.fn(),
}));

vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
  createRedisDel: vi.fn(),
}));

import { addReaction, postComment } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { insertReview } from '../db/reviews.js';
import { upsertInstallation, markInstallationRemoved } from '../db/installations.js';
import { createRedisDel } from '../redis.js';

const mocked = {
  addReaction: vi.mocked(addReaction),
  postComment: vi.mocked(postComment),
  getCachedToken: vi.mocked(getCachedToken),
  insertReview: vi.mocked(insertReview),
  upsertInstallation: vi.mocked(upsertInstallation),
  markInstallationRemoved: vi.mocked(markInstallationRemoved),
  createRedisDel: vi.mocked(createRedisDel),
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_ENV = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'private-key',
  GITHUB_APP_BOT_USER_ID: '999',
  WATCHDOG_QUEUE: { send: vi.fn() },
} as unknown as Env;

const PR_EVENT = {
  installation: { id: 1 },
  repository: { full_name: 'acme/app', owner: { login: 'acme' }, name: 'app' },
  pull_request: { number: 7, head: { sha: 'abc123' }, user: { login: 'dev' } },
};

const COMMENT_EVENT = {
  action: 'created',
  installation: { id: 1 },
  repository: { full_name: 'acme/app', owner: { login: 'acme' }, name: 'app' },
  comment: { id: 100, body: 'please re-review', user: { login: 'dev', id: 555 } },
  issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/7' } },
};

function queueSend(env: Env): ReturnType<typeof vi.fn> {
  return vi.mocked(env.WATCHDOG_QUEUE.send);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocked.getCachedToken.mockReset().mockResolvedValue('token');
  mocked.addReaction.mockReset().mockResolvedValue(42);
  mocked.postComment.mockReset().mockResolvedValue({ id: 1 });
  mocked.insertReview.mockReset().mockResolvedValue({ id: 'review-1' });
  mocked.upsertInstallation.mockReset().mockResolvedValue({ id: 'inst-1' } as never);
  mocked.markInstallationRemoved.mockReset().mockResolvedValue(undefined);
  mocked.createRedisDel.mockReset().mockReturnValue(vi.fn().mockResolvedValue(undefined));
});

// ─── Routing ─────────────────────────────────────────────────────────────────

describe('routing', () => {
  it('ignores unknown event types without side effects', async () => {
    const env = { ...BASE_ENV };
    const result = await handleWebhookEvent({}, 'some_unknown_event', 'd', env);
    expect(result.status).toBe(200);
    expect(result.body).toContain('ignored event type');
    expect(queueSend(env)).not.toHaveBeenCalled();
  });

  it('acks installation lifecycle events', async () => {
    for (const eventType of ['installation', 'installation_repositories']) {
      const result = await handleWebhookEvent({ action: 'created' }, eventType, 'd', { ...BASE_ENV });
      expect(result.status).toBe(200);
      expect(result.body).toBe('ok');
    }
  });

  it('tracks a github app installation with the repos it can see', async () => {
    const env = { ...BASE_ENV };
    const payload = {
      action: 'created',
      installation: { id: 42, account: { login: 'acme' } },
      repositories: [{ full_name: 'acme/app' }, { full_name: 'acme/lib' }],
      sender: { login: 'dev' },
    };
    const result = await handleWebhookEvent(payload, 'installation', 'del-i1', env);
    expect(result.status).toBe(200);
    expect(mocked.upsertInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        owner: 'acme',
        installationId: 42,
        repos: ['acme/app', 'acme/lib'],
        installedBy: 'dev',
      }),
      env
    );
    expect(mocked.markInstallationRemoved).not.toHaveBeenCalled();
  });

  it('marks the installation removed on uninstall', async () => {
    const env = { ...BASE_ENV };
    const payload = {
      action: 'deleted',
      installation: { id: 42, account: { login: 'acme' } },
    };
    const result = await handleWebhookEvent(payload, 'installation', 'del-i2', env);
    expect(result.status).toBe(200);
    expect(mocked.markInstallationRemoved).toHaveBeenCalledWith('github', 'acme', env);
    expect(mocked.upsertInstallation).not.toHaveBeenCalled();
  });

  it('returns 500 when tracking fails so GitHub redelivers the delivery', async () => {
    mocked.upsertInstallation.mockRejectedValueOnce(new Error('db down'));
    const env = { ...BASE_ENV };
    const payload = {
      action: 'created',
      installation: { id: 42, account: { login: 'acme' } },
      repositories: [],
    };
    const result = await handleWebhookEvent(payload, 'installation', 'del-i3', env);
    expect(result.status).toBe(500);
    expect(result.body).toBe('installation tracking failed');
  });
});

// ─── pull_request ────────────────────────────────────────────────────────────

describe('pull_request events', () => {
  it('enqueues a review for opened/reopened PRs with the full ack flow', async () => {
    for (const action of ['opened', 'reopened']) {
      const env = { ...BASE_ENV };
      const result = await handleWebhookEvent(
        { action, ...PR_EVENT },
        'pull_request',
        'del-1',
        env
      );

      expect(result.status).toBe(200);
      expect(result.body).toBe('review enqueued');

      expect(mocked.getCachedToken).toHaveBeenCalledWith(1, '123', 'private-key', expect.anything());
      expect(mocked.addReaction).toHaveBeenCalledWith('acme', 'app', 7, 'eyes', 'token');
      expect(mocked.postComment).toHaveBeenCalledWith(
        'acme', 'app', 7,
        expect.stringContaining('seen this PR'),
        'token'
      );
      expect(mocked.insertReview).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: 'acme/app',
          pr_number: 7,
          installation_id: 1,
          status: 'QUEUED',
          trigger_reason: 'opened',
          github_delivery_id: 'del-1',
        }),
        env
      );
      expect(queueSend(env)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'REVIEW',
          installationId: 1,
          owner: 'acme',
          repo: 'app',
          prNumber: 7,
          reviewId: 'review-1',
        })
      );
    }
  });

  it('clears stale review state on synchronize without enqueueing', async () => {
    const env = { ...BASE_ENV };
    const result = await handleWebhookEvent(
      { action: 'synchronize', ...PR_EVENT },
      'pull_request',
      'del-2',
      env
    );

    expect(result.status).toBe(200);
    expect(result.body).toBe('cleared stale review state');
    expect(mocked.createRedisDel).toHaveBeenCalledWith(env);
    const del = mocked.createRedisDel.mock.results[0].value;
    expect(del).toHaveBeenCalledWith('pr_review_state:acme/app:7');
    expect(queueSend(env)).not.toHaveBeenCalled();
  });

  it('ignores other PR actions', async () => {
    const env = { ...BASE_ENV };
    const result = await handleWebhookEvent({ action: 'closed', ...PR_EVENT }, 'pull_request', 'd', env);
    expect(result.status).toBe(200);
    expect(result.body).toBe('ignored PR action: closed');
    expect(queueSend(env)).not.toHaveBeenCalled();
  });

  it('rejects PR events missing required fields', async () => {
    for (const action of ['opened', 'synchronize']) {
      const result = await handleWebhookEvent({ action }, 'pull_request', 'd', { ...BASE_ENV });
      expect(result.status).toBe(400);
      expect(result.body).toBe('missing required fields');
    }
  });
});

// ─── comment events ──────────────────────────────────────────────────────────

describe('comment events (issue_comment + pull_request_review_comment)', () => {
  const commentShapes: Array<{ eventType: string; event: Record<string, unknown>; commentType: string }> = [
    {
      eventType: 'issue_comment',
      event: COMMENT_EVENT,
      commentType: 'issue_comment',
    },
    {
      eventType: 'pull_request_review_comment',
      event: { ...COMMENT_EVENT, pull_request: PR_EVENT.pull_request },
      commentType: 'pull_request_review_comment',
    },
  ];

  it('dispatches a COMMENT_RESPONSE job for human comments on a PR', async () => {
    for (const { eventType, event, commentType } of commentShapes) {
      const env = { ...BASE_ENV };
      const result = await handleWebhookEvent(event, eventType, 'del-3', env);

      expect(result.status).toBe(200);
      expect(result.body).toBe('comment response dispatched');
      expect(queueSend(env)).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'COMMENT_RESPONSE',
          installationId: 1,
          owner: 'acme',
          repo: 'app',
          prNumber: 7,
          commentId: 100,
          commentBody: 'please re-review',
          commentType,
          githubDeliveryId: 'del-3',
          commenterLogin: 'dev',
        })
      );
    }
  });

  it('propagates the comment in_reply_to_id so replies can anchor at the thread root', async () => {
    const event = {
      ...COMMENT_EVENT,
      comment: { ...COMMENT_EVENT.comment, in_reply_to_id: 250 },
      pull_request: PR_EVENT.pull_request,
    };
    const env = { ...BASE_ENV };

    await handleWebhookEvent(event, 'pull_request_review_comment', 'del-4', env);

    expect(queueSend(env)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'COMMENT_RESPONSE', inReplyToCommentId: 250 })
    );
  });

  it('ignores comments posted by the bot itself (self-loop prevention)', async () => {
    for (const { eventType, event } of commentShapes) {
      const selfEvent = {
        ...event,
        comment: { ...event.comment, user: { login: 'parakh[bot]', id: 999 } },
      };
      const env = { ...BASE_ENV };
      const result = await handleWebhookEvent(selfEvent, eventType, 'd', env);
      expect(result.status).toBe(200);
      expect(result.body).toBe('ignoring self comment');
      expect(queueSend(env)).not.toHaveBeenCalled();
    }
  });

  it('ignores non-created comment actions', async () => {
    const result = await handleWebhookEvent(
      { ...COMMENT_EVENT, action: 'edited' },
      'issue_comment',
      'd',
      { ...BASE_ENV }
    );
    expect(result.status).toBe(200);
    expect(result.body).toBe('ignored comment action: edited');
  });

  it('ignores issue comments that are not on a pull request', async () => {
    const plainIssueEvent = {
      ...COMMENT_EVENT,
      issue: { number: 5 }, // no pull_request marker
    };
    const result = await handleWebhookEvent(plainIssueEvent, 'issue_comment', 'd', { ...BASE_ENV });
    expect(result.status).toBe(200);
    expect(result.body).toBe('not a PR comment');
  });

  it('rejects comment events missing required fields', async () => {
    const missingFieldEvents: Array<{ eventType: string; event: Record<string, unknown> }> = [
      {
        eventType: 'issue_comment',
        event: {
          action: 'created',
          installation: { id: 1 },
          repository: PR_EVENT.repository,
          issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/7' } },
        },
      },
      {
        eventType: 'pull_request_review_comment',
        event: {
          action: 'created',
          installation: { id: 1 },
          repository: PR_EVENT.repository,
          pull_request: PR_EVENT.pull_request,
        },
      },
    ];
    for (const { eventType, event } of missingFieldEvents) {
      const result = await handleWebhookEvent(event, eventType, 'd', { ...BASE_ENV });
      expect(result.status).toBe(400);
      expect(result.body).toBe('missing required fields');
    }
  });

  it('throws when the bot user id is not configured', async () => {
    const env = { ...BASE_ENV, GITHUB_APP_BOT_USER_ID: '' } as unknown as Env;
    await expect(handleWebhookEvent(COMMENT_EVENT, 'issue_comment', 'd', env)).rejects.toThrow(
      'GITHUB_APP_BOT_USER_ID not configured'
    );
  });
});
