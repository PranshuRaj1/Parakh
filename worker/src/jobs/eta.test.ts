import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

vi.mock('../db/reviews.js', () => ({
  getReview: vi.fn(),
  countCompletedReviews: vi.fn(),
  getAvgDurationByStep: vi.fn(),
  getAvgMsPerFile: vi.fn(),
  getCompletedStepsForReview: vi.fn(),
  getLatestReviewingFilesDetail: vi.fn(),
}));

import { computeEta } from './eta.js';
import {
  getReview,
  countCompletedReviews,
  getAvgDurationByStep,
  getAvgMsPerFile,
  getCompletedStepsForReview,
  getLatestReviewingFilesDetail,
} from '../db/reviews.js';

const mocked = {
  getReview: vi.mocked(getReview),
  countCompletedReviews: vi.mocked(countCompletedReviews),
  getAvgDurationByStep: vi.mocked(getAvgDurationByStep),
  getAvgMsPerFile: vi.mocked(getAvgMsPerFile),
  getCompletedStepsForReview: vi.mocked(getCompletedStepsForReview),
  getLatestReviewingFilesDetail: vi.mocked(getLatestReviewingFilesDetail),
};

const env = {} as unknown as Env;

function defaultAverages(): Map<string, number> {
  return new Map([
    ['AUTHENTICATING', 1000],
    ['FETCHING_DIFF', 2000],
    ['LOADING_RULES', 300],
    ['SCORING', 500],
    ['POSTING_COMMENT', 1500],
    ['REACTING', 800],
  ]);
}

describe('computeEta', () => {
  it('returns insufficient data when the review does not exist', async () => {
    mocked.getReview.mockResolvedValue(null);
    await expect(computeEta('r1', 'acme/app', env)).resolves.toEqual({
      totalMs: null,
      basis: 'insufficient_data',
      sampleCount: 0,
    });
  });

  it('returns insufficient data when there are not enough completed samples', async () => {
    mocked.getReview.mockResolvedValue({ id: 'r1' } as never);
    mocked.countCompletedReviews.mockImplementation(async (repo: string | null) => (repo ? 2 : 4));
    await expect(computeEta('r1', 'acme/app', env)).resolves.toEqual({
      totalMs: null,
      basis: 'insufficient_data',
      sampleCount: 4,
    });
  });

  it('uses repo-specific averages when the repo has enough samples and sums elapsed + remaining', async () => {
    mocked.getReview.mockResolvedValue({ id: 'r1' } as never);
    mocked.countCompletedReviews.mockImplementation(async (repo: string | null) => (repo ? 5 : 100));
    mocked.getAvgDurationByStep.mockResolvedValue(defaultAverages());
    mocked.getAvgMsPerFile.mockResolvedValue(4000);
    mocked.getCompletedStepsForReview.mockResolvedValue([
      { step: 'FETCHING_DIFF', duration_ms: 2000 },
    ]);
    mocked.getLatestReviewingFilesDetail.mockResolvedValue({ completedCount: 2, totalCount: 5 });

    const result = await computeEta('r1', 'acme/app', env);

    // remaining fixed steps (FETCHING_DIFF done, REVIEWING_FILES excluded):
    // 1000 + 300 + 500 + 1500 + 800 = 4100
    // remaining files: 3 × 4000 = 12000 → total remaining 16100
    // elapsed 2000 → total 18100
    expect(result).toEqual({
      totalMs: 18100,
      basis: 'repo',
      sampleCount: 5,
    });
    expect(mocked.getAvgDurationByStep).toHaveBeenCalledWith('acme/app', env);
  });

  it('falls back to global averages when the repo has too few samples', async () => {
    mocked.getReview.mockResolvedValue({ id: 'r1' } as never);
    mocked.countCompletedReviews.mockImplementation(async (repo: string | null) => (repo ? 3 : 8));
    mocked.getAvgDurationByStep.mockResolvedValue(new Map());
    mocked.getAvgMsPerFile.mockResolvedValue(0);
    mocked.getCompletedStepsForReview.mockResolvedValue([]);
    mocked.getLatestReviewingFilesDetail.mockResolvedValue(null);

    const result = await computeEta('r1', 'acme/app', env);
    expect(result.basis).toBe('global');
    expect(result.sampleCount).toBe(8);
    expect(mocked.getAvgDurationByStep).toHaveBeenCalledWith(null, env);
  });
});
