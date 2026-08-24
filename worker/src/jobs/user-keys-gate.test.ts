import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { mockResolveUserCreds } = vi.hoisted(() => ({ mockResolveUserCreds: vi.fn() }));

vi.mock('../llm/user-creds.js', () => ({
  resolveUserCreds: mockResolveUserCreds,
}));
vi.mock('../github/api.js', () => ({ postCommentOnce: vi.fn() }));
vi.mock('../db/reviews.js', () => ({ updateReviewStatus: vi.fn() }));

import { applyUserKeysGate } from './review.js';
import { postCommentOnce } from '../github/api.js';
import { updateReviewStatus } from '../db/reviews.js';

const mocked = {
  postCommentOnce: vi.mocked(postCommentOnce),
  updateReviewStatus: vi.mocked(updateReviewStatus),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  DATABASE_URL: 'postgres://x',
  DASHBOARD_BASE_URL: 'https://parakh.example',
} as unknown as Env;

const WITH_KEYS = {
  githubLogin: 'installer-user',
  geminiKeys: ['fake-gemini-key'],
  groqKeys: [],
  cfaiAccountId: null,
  cfaiToken: null,
  openrouterKey: null,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
});

describe('applyUserKeysGate', () => {
  it('uses saved keys for standard users', async () => {
    mockResolveUserCreds.mockResolvedValue(WITH_KEYS);

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toEqual(WITH_KEYS);
    expect(mocked.postCommentOnce).not.toHaveBeenCalled();
    expect(mocked.updateReviewStatus).not.toHaveBeenCalled();
  });

  it('blocks users with no saved keys', async () => {
    mockResolveUserCreds.mockResolvedValue(null);

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toBeNull();
  });

  it('uses saved keys for PranshuRaj1', async () => {
    mockResolveUserCreds.mockResolvedValue({ ...WITH_KEYS, githubLogin: 'PranshuRaj1' });

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toEqual({ ...WITH_KEYS, githubLogin: 'PranshuRaj1' });
  });

  it('still FAILs the review when the PR comment cannot be posted', async () => {
    mockResolveUserCreds.mockResolvedValue({ ...WITH_KEYS, githubLogin: 'PranshuRaj1', geminiKeys: [] });
    mocked.postCommentOnce.mockRejectedValue(new Error('github down'));

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toBeNull();
    expect(mocked.updateReviewStatus).toHaveBeenCalledWith('review-1', 'FAILED', env);
  });
});
