import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { mockResolveUserCreds } = vi.hoisted(() => ({ mockResolveUserCreds: vi.fn() }));

vi.mock('../llm/user-creds.js', () => ({ resolveUserCreds: mockResolveUserCreds }));
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
  it('passes when the installing user has Gemini keys', async () => {
    mockResolveUserCreds.mockResolvedValue(WITH_KEYS);

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toEqual(WITH_KEYS);
    expect(mocked.postCommentOnce).not.toHaveBeenCalled();
    expect(mocked.updateReviewStatus).not.toHaveBeenCalled();
  });

  it('blocks with a PR comment + FAILED when no installer exists', async () => {
    mockResolveUserCreds.mockResolvedValue(null);

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toBeNull();
    expect(mocked.postCommentOnce).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('no LLM API keys configured'),
      expect.stringContaining('parakh-no-keys-gate'),
      'token'
    );
    expect(mocked.updateReviewStatus).toHaveBeenCalledWith('review-1', 'FAILED', env);
  });

  it('blocks with a PR comment + FAILED when the installer has no Gemini keys', async () => {
    mockResolveUserCreds.mockResolvedValue({ ...WITH_KEYS, geminiKeys: [] });

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toBeNull();
    expect(mocked.postCommentOnce).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('**installer-user**'),
      expect.any(String),
      'token'
    );
    expect(mocked.updateReviewStatus).toHaveBeenCalledWith('review-1', 'FAILED', env);
  });

  it('still FAILs the review when the PR comment cannot be posted', async () => {
    mockResolveUserCreds.mockResolvedValue(null);
    mocked.postCommentOnce.mockRejectedValue(new Error('github down'));

    const creds = await applyUserKeysGate('acme', 'app', 7, 'token', 'review-1', env);

    expect(creds).toBeNull();
    expect(mocked.updateReviewStatus).toHaveBeenCalledWith('review-1', 'FAILED', env);
  });
});