/**
 * Threaded reply to a plain PR/issue conversation comment.
 *
 * Preferred: GraphQL addCommentReply (threads the reply under the parent
 * comment). REST Create-issue-comment in_reply_to_id was removed by GitHub,
 * so REST replies land flat. addCommentReply itself was briefly available and
 * then rolled back (Aug 2026); when the mutation is absent this module falls
 * back to a flat issue comment so the bot never loses a reply.
 *
 * This module is self-contained (duplicate fetch/signal logic from api.ts)
 * so it stays independent of the REST client module.
 */

import { createRequestSignal } from '../request-timeout.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'Parakh-Bot';

function headers(token: string, extra?: Record<string, string>): Headers {
  const h = new Headers({
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  });
  if (extra) new Headers(extra).forEach((v, k) => h.set(k, v));
  return h;
}

/**
 * Post a threaded reply under an existing issue comment on a PR.
 *
 * @returns the created reply comment's REST database id.
 */
export async function replyToIssueComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  token: string
): Promise<{ id: number }> {
  // 1. Resolve the parent comment's GraphQL node id (REST GET returns node_id).
  const parentRes = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    { headers: headers(token), signal: createRequestSignal() }
  );
  if (!parentRes.ok) {
    throw new Error(`GitHub API error (${parentRes.status}) GET comment ${commentId}: ${await parentRes.text()}`);
  }
  const parent = (await parentRes.json()) as { node_id?: string; issue_url?: string };
  const parentIssueNumber = Number(parent.issue_url?.split('/').pop() ?? '');
  if (!parent.node_id || Number.isNaN(parentIssueNumber)) {
    throw new Error(`GitHub API error: comment ${commentId} is missing node_id or issue_url`);
  }

  // 2. Create the threaded reply via GraphQL addCommentReply.
  const query = `mutation($cid: ID!, $replyBody: String!) {
    addCommentReply(input: { replyToCommentId: $cid, replyBody: $replyBody }) {
      reply { databaseId }
    }
  }`;
  const replyRes = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables: { cid: parent.node_id, replyBody: body } }),
    signal: createRequestSignal(),
  });
  const payload = (await replyRes.json()) as {
    data?: { addCommentReply?: { reply?: { databaseId?: number } } };
    errors?: Array<{ message?: string }>;
  };
  const replyId = payload.data?.addCommentReply?.reply?.databaseId;
  if (replyRes.ok && replyId) {
    return { id: replyId };
  }

  // Fallback: GitHub occasionally removes/rolls back the addCommentReply
  // mutation (it did in Aug 2026, taking IssueComment.isReply/replyTo with it).
  // Rather than losing the reply entirely, post a flat issue comment. When the
  // mutation is available again the reply automatically nests under the parent.
  const flatRes = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${parentIssueNumber}/comments`,
    {
      method: 'POST',
      headers: headers(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ body }),
      signal: createRequestSignal(),
    }
  );
  if (!flatRes.ok) {
    throw new Error(`GitHub API error (${flatRes.status}) POST flat reply: ${await flatRes.text()}`);
  }
  return (await flatRes.json()) as { id: number };
}
