import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, } from '../index.js';

vi.mock('../github/auth.js', () => ({ getCachedToken: vi.fn() }));
vi.mock('../github/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github/api.js')>()),
  getPRDetails: vi.fn(),
  removeReaction: vi.fn(),
  addReaction: vi.fn(),
  postComment: vi.fn(),
  addCommentReaction: vi.fn(),
}));
vi.mock('../db/reviews.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/reviews.js')>()),
  getActiveReviewByPR: vi.fn(),
  getLatestReviewByPR: vi.fn(),
  getReview: vi.fn(),
  insertReview: vi.fn(),
  updateReviewStatus: vi.fn(),
  setTriggerCommentContext: vi.fn(),
}));
vi.mock('../redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../redis.js')>()),
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
  createRedisSetNX: vi.fn(),
  createRedisDel: vi.fn(),
}));

import { triggerReview } from './review.js';
import { getCachedToken } from '../github/auth.js';
import { getPRDetails, addReaction, addCommentReaction } from '../github/api.js';
import {
  getActiveReviewByPR,
  getLatestReviewByPR,
  getReview,
  insertReview,
  updateReviewStatus,
} from '../db/reviews.js';
import { createRedisGet, createRedisSet, createRedisSetNX, createRedisDel } from '../redis.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  getPRDetails: vi.mocked(getPRDetails),
  addReaction: vi.mocked(addReaction),
  addCommentReaction: vi.mocked(addCommentReaction),
  getActiveReviewByPR: vi.mocked(getActiveReviewByPR),
  getLatestReviewByPR: vi.mocked(getLatestReviewByPR),
  getReview: vi.mocked(getReview),
  insertReview: vi.mocked(insertReview),
  updateReviewStatus: vi.mocked(updateReviewStatus),
  createRedisGet: vi.mocked(createRedisGet),
  createRedisSet: vi.mocked(createRedisSet),
  createRedisSetNX: vi.mocked(createRedisSetNX),
  createRedisDel: vi.mocked(createRedisDel),
};

function makeEnv() {
  const send = vi.fn().mockResolvedValue(undefined);
  return {
    env: {
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'key',
      WATCHDOG_QUEUE: { send },
    } as unknown as Env,
    send,
  };
}

const baseInput = {
  installationId: 1,
  owner: 'acme',
  repo: 'app',
  prNumber: 7,
  reason: 'manual_mention' as const,
  requestedMode: 'incremental' as const,
  githubDeliveryId: 'delivery',
  commentId: 100,
  commentType: 'issue_comment' as const,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.getCachedToken.mockResolvedValue('token');
  mocked.getPRDetails.mockResolvedValue({
    head: { sha: 'head-2' }, base: { sha: 'base-1' }, user: { login: 'dev' },
  });
  mocked.getActiveReviewByPR.mockResolvedValue(null);
  mocked.getLatestReviewByPR.mockResolvedValue(null);
  mocked.insertReview.mockResolvedValue({ id: 'review-2' } as never);
  mocked.addReaction.mockResolvedValue(41);
  mocked.addCommentReaction.mockResolvedValue(42);
  mocked.createRedisGet.mockReturnValue((async () => null) as never);
  mocked.createRedisSet.mockReturnValue((async () => undefined) as never);
  mocked.createRedisSetNX.mockReturnValue((async () => true) as never);
  mocked.createRedisDel.mockReturnValue((async () => undefined) as never);
});

describe('triggerReview modes and concurrency', () => {
  it('pins an incremental request as a disabled full-review fallback', async () => {
    const { env, send } = makeEnv();
    await expect(triggerReview(baseInput, env)).resolves.toBe('ENQUEUED');

    expect(mocked.insertReview).toHaveBeenCalledWith(expect.objectContaining({
      head_sha: 'head-2',
      base_sha: 'base-1',
      requested_review_mode: 'incremental',
      effective_review_mode: 'full',
      fallback_reason: 'incremental_disabled',
    }), env);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: 'review-2', requestedMode: 'incremental', effectiveMode: 'full',
    }));
  });

  it('does not duplicate an identical queued request', async () => {
    mocked.getActiveReviewByPR.mockResolvedValue({
      id: 'review-1', status: 'QUEUED', head_sha: 'head-2', requested_review_mode: 'incremental',
    } as never);
    const { env, send } = makeEnv();

    await expect(triggerReview(baseInput, env)).resolves.toBe('ALREADY_ACTIVE');
    expect(mocked.insertReview).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('identifies an identical request while its enqueue lock is still held', async () => {
    mocked.createRedisSetNX.mockReturnValue((async () => false) as never);
    mocked.createRedisGet.mockReturnValue((async () => JSON.stringify({
      headSha: 'head-2', requestedMode: 'incremental',
    })) as never);
    const { env, send } = makeEnv();

    await expect(triggerReview(baseInput, env)).resolves.toBe('ALREADY_ACTIVE');
    expect(mocked.getActiveReviewByPR).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { head_sha: 'head-1', requested_review_mode: 'incremental' },
    { head_sha: 'head-2', requested_review_mode: 'full' },
  ])('returns BUSY for a different active commit or mode', async (active) => {
    mocked.getActiveReviewByPR.mockResolvedValue({ id: 'review-1', status: 'RUNNING', ...active } as never);
    const { env, send } = makeEnv();

    await expect(triggerReview(baseInput, env)).resolves.toBe('BUSY');
    expect(send).not.toHaveBeenCalled();
  });

  it('resumes the same request only when its heartbeat is stale', async () => {
    mocked.getActiveReviewByPR.mockResolvedValue({
      id: 'review-1', status: 'RUNNING', head_sha: 'head-2', requested_review_mode: 'incremental',
      worker_heartbeat_at: new Date(0).toISOString(),
    } as never);
    const { env, send } = makeEnv();

    await expect(triggerReview(baseInput, env)).resolves.toBe('RESUMED');
    expect(mocked.updateReviewStatus).toHaveBeenCalledWith('review-1', 'QUEUED', env, 'delivery');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'review-1' }));
  });

  it('never resumes a pinned review after the head moves', async () => {
    mocked.getReview.mockResolvedValue({
      id: 'review-1', status: 'FAILED', head_sha: 'head-1', requested_review_mode: 'incremental',
    } as never);
    const { env, send } = makeEnv();

    await expect(triggerReview({ ...baseInput, resumeReviewId: 'review-1' }, env)).resolves.toBe('BUSY');
    expect(send).not.toHaveBeenCalled();
  });
});
