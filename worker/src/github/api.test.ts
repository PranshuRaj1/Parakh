import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveReviewCommentRoot } from './api.js';

/**
 * Regression: GitHub OMITS `in_reply_to_id` on root review comments (the field
 * is absent from the JSON, not null). The old strict `=== null` check never
 * fired, so resolving a reply's thread root walked into a fetch of
 * /pulls/comments/undefined and 404'd — silently killing every diff-thread
 * reply from the comment-response pipeline.
 */

interface FakeComment {
  id: number;
  in_reply_to_id?: number | null;
}

function stubComments(comments: FakeComment[]): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const id = Number(url.match(/pulls\/comments\/(\d+)/)?.[1]);
    const comment = comments.find((c) => c.id === id);
    if (!comment) return new Response('Not Found', { status: 404 });
    // Mirror GitHub: omit the field entirely when there is no parent.
    const body: Record<string, unknown> = { id: comment.id };
    if (comment.in_reply_to_id != null) body.in_reply_to_id = comment.in_reply_to_id;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return { urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveReviewCommentRoot', () => {
  it('resolves a reply on a root comment without fetching an undefined id', async () => {
    const { urls } = stubComments([{ id: 100 }]);

    const root = await resolveReviewCommentRoot('acme', 'app', 200, 100, 'token');

    expect(root).toBe(100);
    expect(urls.some((url) => url.includes('undefined'))).toBe(false);
  });

  it('climbs a nested chain back to the root', async () => {
    const { urls } = stubComments([
      { id: 100 },
      { id: 101, in_reply_to_id: 100 },
    ]);

    const root = await resolveReviewCommentRoot('acme', 'app', 102, 101, 'token');

    expect(root).toBe(100);
    expect(urls.some((url) => url.includes('undefined'))).toBe(false);
  });

  it('returns the comment itself when it has no known parent', async () => {
    const { urls } = stubComments([{ id: 300 }]);

    const root = await resolveReviewCommentRoot('acme', 'app', 300, undefined, 'token');

    expect(root).toBe(300);
    expect(urls).toHaveLength(1);
  });
});
