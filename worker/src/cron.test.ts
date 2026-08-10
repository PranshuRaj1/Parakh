import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

vi.mock('./db/reviews.js', () => ({
  pruneExpiredReasoning: vi.fn(),
  dbSweepStalledReviews: vi.fn(),
  dbTimeoutStage: vi.fn(),
  getReview: vi.fn(),
  dbFindResumableDailyQuotaReviews: vi.fn(),
}));

vi.mock('./github/auth.js', () => ({ getCachedToken: vi.fn() }));
vi.mock('./github/api.js', () => ({ postComment: vi.fn() }));
vi.mock('./redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
}));
vi.mock('./jobs/review.js', () => ({
  swapCommentReaction: vi.fn(),
  releaseReviewLock: vi.fn(),
  triggerReview: vi.fn(),
}));

import { handleCronTrigger } from './cron.js';
import {
  pruneExpiredReasoning,
  dbSweepStalledReviews,
  dbTimeoutStage,
  getReview,
  dbFindResumableDailyQuotaReviews,
} from './db/reviews.js';
import { getCachedToken } from './github/auth.js';
import { postComment } from './github/api.js';
import {
  swapCommentReaction,
  releaseReviewLock,
  triggerReview,
} from './jobs/review.js';

const mocked = {
  pruneExpiredReasoning: vi.mocked(pruneExpiredReasoning),
  dbSweepStalledReviews: vi.mocked(dbSweepStalledReviews),
  dbTimeoutStage: vi.mocked(dbTimeoutStage),
  getReview: vi.mocked(getReview),
  dbFindResumableDailyQuotaReviews: vi.mocked(dbFindResumableDailyQuotaReviews),
  getCachedToken: vi.mocked(getCachedToken),
  postComment: vi.mocked(postComment),
  swapCommentReaction: vi.mocked(swapCommentReaction),
  releaseReviewLock: vi.mocked(releaseReviewLock),
  triggerReview: vi.mocked(triggerReview),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
} as unknown as Env;

function stalledReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    repo: 'acme/app',
    pr_number: 7,
    installation_id: 1,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.pruneExpiredReasoning.mockResolvedValue(0);
  mocked.dbSweepStalledReviews.mockResolvedValue([]);
  mocked.dbTimeoutStage.mockResolvedValue(undefined);
  mocked.getCachedToken.mockResolvedValue('token');
  mocked.postComment.mockResolvedValue({ id: 1 } as never);
});

describe('handleCronTrigger', () => {
  it('marks stalled reviews as timed out and posts a recovery comment per stalled review', async () => {
    mocked.dbSweepStalledReviews.mockResolvedValue([
      { reviewId: 'r1', stage: 'FETCHING_DIFF', attempt: 2 },
      { reviewId: 'r2', stage: 'REVIEWING_FILES', attempt: 1 },
    ]);
    mocked.getReview
      .mockResolvedValueOnce(stalledReview())
      .mockResolvedValueOnce(stalledReview({ id: 'r2' }));

    await handleCronTrigger(env);

    expect(mocked.dbTimeoutStage).toHaveBeenNthCalledWith(1, 'r1', 'FETCHING_DIFF', 2, env);
    expect(mocked.dbTimeoutStage).toHaveBeenNthCalledWith(2, 'r2', 'REVIEWING_FILES', 1, env);
    expect(mocked.postComment).toHaveBeenCalledTimes(2);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('Review stuck at **FETCHING_DIFF**'),
      'token'
    );
  });

  it('skips stalled records whose review no longer exists or has no installation', async () => {
    mocked.dbSweepStalledReviews.mockResolvedValue([
      { reviewId: 'r1', stage: 'SCORING', attempt: 1 },
      { reviewId: 'r2', stage: 'SCORING', attempt: 1 },
    ]);
    mocked.getReview
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stalledReview({ installation_id: null }));

    await handleCronTrigger(env);

    expect(mocked.postComment).not.toHaveBeenCalled();
    // both records still get marked timed out
    expect(mocked.dbTimeoutStage).toHaveBeenCalledTimes(2);
  });

  it('continues the sweep even when pruning expired reasoning fails', async () => {
    mocked.pruneExpiredReasoning.mockRejectedValue(new Error('db error'));
    mocked.dbSweepStalledReviews.mockResolvedValue([
      { reviewId: 'r1', stage: 'REACTING', attempt: 1 },
    ]);
    mocked.getReview.mockResolvedValue(stalledReview());

    await handleCronTrigger(env);

    expect(mocked.dbTimeoutStage).toHaveBeenCalledTimes(1);
    expect(mocked.postComment).toHaveBeenCalledTimes(1);
  });

  it('swaps the trigger-comment reaction to confused when a comment-triggered review stalls', async () => {
    mocked.dbSweepStalledReviews.mockResolvedValue([
      { reviewId: 'r1', stage: 'FETCHING_DIFF', attempt: 1 },
    ]);
    const triggerReview = stalledReview({
      trigger_comment_id: 100,
      trigger_comment_type: 'issue_comment',
    });
    mocked.getReview.mockResolvedValue(triggerReview);

    await handleCronTrigger(env);

    expect(mocked.swapCommentReaction).toHaveBeenCalledWith(
      triggerReview, 'confused', 'acme', 'app', 'token', env
    );
  });
});
