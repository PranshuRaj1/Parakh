import { afterEach, describe, expect, it, vi } from 'vitest';
import { replyToIssueComment } from './reply-comment.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('replyToIssueComment', () => {
  it('resolves the parent comment node_id then posts a threaded reply via GraphQL addCommentReply', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 100,
        node_id: 'IC_abc123',
        issue_url: 'https://api.github.com/repos/acme/app/issues/7',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { addCommentReply: { reply: { databaseId: 512 } } },
      }), { status: 200 }));

    const result = await replyToIssueComment('acme', 'app', 100, 'threaded reply', 'token');

    expect(result).toEqual({ id: 512 });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [getUrl, getInit] = fetchMock.mock.calls[0];
    expect(String(getUrl)).toBe('https://api.github.com/repos/acme/app/issues/comments/100');

    const [gqlUrl, gqlInit] = fetchMock.mock.calls[1];
    expect(String(gqlUrl)).toBe('https://api.github.com/graphql');
    expect(gqlInit?.method).toBe('POST');
    const body = JSON.parse(String(gqlInit?.body));
    expect(body.variables).toEqual({ cid: 'IC_abc123', replyBody: 'threaded reply' });
    expect(body.query).toContain('addCommentReply');
  });

  it('throws when the parent comment has no node_id', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 100, issue_url: 'https://api.github.com/repos/acme/app/issues/7' }), { status: 200 }));

    await expect(replyToIssueComment('acme', 'app', 100, 'body', 'token')).rejects.toThrow('missing node_id or issue_url');
  });

  it('falls back to a flat issue comment when addCommentReply is unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 100,
        node_id: 'IC_abc123',
        issue_url: 'https://api.github.com/repos/acme/app/issues/7',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errors: [{ message: "Field 'addCommentReply' doesn't exist on type 'Mutation'" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 513 }), { status: 201 }));

    const result = await replyToIssueComment('acme', 'app', 100, 'fallback body', 'token');

    expect(result).toEqual({ id: 513 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [fallbackUrl, fallbackInit] = fetchMock.mock.calls[2];
    expect(String(fallbackUrl)).toBe('https://api.github.com/repos/acme/app/issues/7/comments');
    expect(fallbackInit?.method).toBe('POST');
    expect(JSON.parse(String(fallbackInit?.body))).toEqual({ body: 'fallback body' });
  });

  it('throws on a non-OK parent GET response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 404 }));

    await expect(replyToIssueComment('acme', 'app', 404, 'body', 'token')).rejects.toThrow('GitHub API error (404)');
  });
});