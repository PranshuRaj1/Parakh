import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

vi.mock('../github/auth.js', () => ({ getCachedToken: vi.fn() }));

vi.mock('../github/api.js', () => ({
  fetchDiff: vi.fn(),
  fetchDiffPinned: vi.fn(),
  getPRDetails: vi.fn(),
  postComment: vi.fn(),
  postCommentOnce: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  replyToReviewComment: vi.fn(),
  addCommentReaction: vi.fn(),
  removeCommentReaction: vi.fn(),
}));

vi.mock('../db/reviews.js', () => ({
  getReview: vi.fn(),
  dbStartStage: vi.fn(),
  dbCompleteStage: vi.fn(),
  dbFailStage: vi.fn(),
  dbUpdateReason: vi.fn(),
  dbUpdateReasonDetail: vi.fn(),
  dbUpdateHeartbeat: vi.fn(),
  dbTimeoutStage: vi.fn(),
}));

vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
  createRedisSetNX: vi.fn(),
  createRedisDel: vi.fn(),
}));

import { executeReviewJob } from './review.js';
import { getCachedToken } from '../github/auth.js';
import { fetchDiff, fetchDiffPinned } from '../github/api.js';
import { getReview } from '../db/reviews.js';
import { createRedisGet, createRedisSet, createRedisSetNX, createRedisDel } from '../redis.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  fetchDiff: vi.mocked(fetchDiff),
  fetchDiffPinned: vi.mocked(fetchDiffPinned),
  getReview: vi.mocked(getReview),
  createRedisGet: vi.mocked(createRedisGet),
  createRedisSet: vi.mocked(createRedisSet),
  createRedisSetNX: vi.mocked(createRedisSetNX),
  createRedisDel: vi.mocked(createRedisDel),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  DATABASE_URL: 'postgres://x',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 'token',
} as unknown as Env;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();

  mocked.getCachedToken.mockResolvedValue('token');
  mocked.getReview.mockResolvedValue({
    id: 'review-1',
    status: 'RUNNING',
    stage_attempt: 1,
    worker_heartbeat_at: new Date().toISOString(),
    head_sha: 'head',
    base_sha: 'base',
  } as never);
  mocked.createRedisGet.mockReturnValue((async () => null) as never);
  mocked.createRedisSet.mockReturnValue((async () => undefined) as never);
  mocked.createRedisSetNX.mockReturnValue((async () => false) as never);
  mocked.createRedisDel.mockReturnValue((async () => undefined) as never);
  mocked.fetchDiffPinned.mockRejectedValue(new Error('duplicate execution reached the pipeline'));
});

describe('review queue redelivery', () => {
  it('does not steal a live execution lock on a redelivery with a fresh heartbeat', async () => {
    await expect(executeReviewJob({
      type: 'REVIEW',
      installationId: 1,
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      reviewId: 'review-1',
      requestedMode: 'full',
      effectiveMode: 'full',
    }, env, 2)).rejects.toThrow('review execution is still active');

    expect(mocked.fetchDiff).not.toHaveBeenCalled();
    expect(mocked.fetchDiffPinned).not.toHaveBeenCalled();
  });

  it('resumes when the lock holder heartbeat is stale', async () => {
    mocked.getReview.mockResolvedValue({
      id: 'review-1',
      status: 'RUNNING',
      stage_attempt: 1,
      worker_heartbeat_at: new Date(0).toISOString(),
      head_sha: 'head',
      base_sha: 'base',
    } as never);

    await expect(executeReviewJob({
      type: 'REVIEW',
      installationId: 1,
      owner: 'acme',
      repo: 'app',
      prNumber: 7,
      reviewId: 'review-1',
      requestedMode: 'full',
      effectiveMode: 'full',
    }, env, 2)).rejects.toThrow('duplicate execution reached the pipeline');

    expect(mocked.fetchDiffPinned).toHaveBeenCalledTimes(1);
  });
});
