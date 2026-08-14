import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

vi.mock('../db/reviews.js', () => ({ getReview: vi.fn() }));
vi.mock('./review.js', () => ({ triggerReview: vi.fn() }));

import { handleRetryReview } from './retry-api.js';
import { getReview } from '../db/reviews.js';
import { triggerReview } from './review.js';

const mocked = {
  getReview: vi.mocked(getReview),
  triggerReview: vi.mocked(triggerReview),
};

const env = {} as unknown as Env;

function makeCtx() {
  return { waitUntil: vi.fn() } as unknown as ExecutionContext;
}

function failedReview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    repo: 'acme/app',
    pr_number: 7,
    installation_id: 1,
    status: 'FAILED',
    github_delivery_id: 'del',
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocked.getReview.mockReset();
  mocked.triggerReview.mockReset().mockResolvedValue('RESUMED');
});

describe('handleRetryReview', () => {
  it('returns 404 for an unknown review', async () => {
    mocked.getReview.mockResolvedValue(null);
    const res = await handleRetryReview('missing', env);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Review not found' });
  });

  it('refuses to retry reviews that are not in a retryable state', async () => {
    for (const status of ['QUEUED', 'RUNNING', 'COMPLETED']) {
      mocked.getReview.mockResolvedValue(failedReview({ status }));
      const res = await handleRetryReview('r1', env);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain(`cannot retry a review with status ${status}`);
    }
  });

  it('returns 400 when repo details or installation id are missing', async () => {
    mocked.getReview.mockResolvedValue(failedReview({ repo: 'missing-slash', installation_id: 1 }));
    const res = await handleRetryReview('r1', env);
    expect(res.status).toBe(400);

    mocked.getReview.mockResolvedValue(failedReview({ repo: 'acme/app', installation_id: null }));
    const res2 = await handleRetryReview('r1', env);
    expect(res2.status).toBe(400);
  });

  it('resumes the review asynchronously and returns 202', async () => {
    mocked.getReview.mockResolvedValue(failedReview());
    const ctx = makeCtx();
    const res = await handleRetryReview('r1', env, ctx);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ status: 'retry_enqueued' });
    expect(mocked.triggerReview).toHaveBeenCalledWith(
      {
        installationId: 1,
        owner: 'acme',
        repo: 'app',
        prNumber: 7,
        reason: 'manual_mention',
        requestedMode: 'full',
        resumeReviewId: 'r1',
        githubDeliveryId: 'del',
      },
      env
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('returns 202 without triggering when there is no execution context', async () => {
    mocked.getReview.mockResolvedValue(failedReview());
    const res = await handleRetryReview('r1', env);
    expect(res.status).toBe(202);
    expect(mocked.triggerReview).not.toHaveBeenCalled();
  });

  it('surfaces unexpected errors as 500', async () => {
    mocked.getReview.mockRejectedValue(new Error('db down'));
    const res = await handleRetryReview('r1', env);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'db down' });
  });
});
