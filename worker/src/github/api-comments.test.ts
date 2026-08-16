import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCommentOnce, resolveReviewCommentRoot } from './api.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postCommentOnce', () => {
  it('does not publish the same marked review twice across retries', async () => {
    const marker = '<!-- parakh-review:review-1 -->';
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 101 }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 101, body: `Review body\n\n${marker}` }]), { status: 200 }));

    await postCommentOnce('acme', 'app', 7, 'Review body', marker, 'token');
    await postCommentOnce('acme', 'app', 7, 'Review body', marker, 'token');

    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(postCalls).toHaveLength(1);
  });
});

describe('resolveReviewCommentRoot', () => {
  it('returns a top-level comment as-is when its parent is unknown (single fetch)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 100, in_reply_to_id: null }), { status: 200 }));

    await expect(resolveReviewCommentRoot('acme', 'app', 100, undefined, 'token')).resolves.toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/pulls/comments/100');
  });

  it('walks the in_reply_to_id chain to the thread root when the parent is known', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 200, in_reply_to_id: null }), { status: 200 }));

    await expect(resolveReviewCommentRoot('acme', 'app', 100, 200, 'token')).resolves.toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('walks a multi-hop chain back to the top-level comment', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 200, in_reply_to_id: 300 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 300, in_reply_to_id: null }), { status: 200 }));

    await expect(resolveReviewCommentRoot('acme', 'app', 100, 200, 'token')).resolves.toBe(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a self-fetch when the parent is unknown', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 100, in_reply_to_id: 200 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 200, in_reply_to_id: null }), { status: 200 }));

    await expect(resolveReviewCommentRoot('acme', 'app', 100, undefined, 'token')).resolves.toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps the walk depth and returns the deepest comment reached', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 200, in_reply_to_id: 300 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 300, in_reply_to_id: 400 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 400, in_reply_to_id: 500 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 500, in_reply_to_id: null }), { status: 200 }));

    await expect(resolveReviewCommentRoot('acme', 'app', 100, 200, 'token')).resolves.toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
