import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeCommentReaction } from './api.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('removeCommentReaction', () => {
  it.each([
    ['issue_comment', 'issues/comments/100/reactions/55'],
    ['pull_request_review_comment', 'pulls/comments/100/reactions/55'],
  ] as const)('uses the scoped GitHub endpoint for %s', async (commentType, path) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 })
    );

    await removeCommentReaction('acme', 'app', 100, commentType, 55, 'token');

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/acme/app/${path}`,
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
