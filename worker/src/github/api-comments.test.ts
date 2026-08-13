import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCommentOnce } from './api.js';

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
