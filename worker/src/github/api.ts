/**
 * GitHub REST API Client
 *
 * Thin wrappers around the GitHub REST API endpoints used by Parakh.
 * This module ONLY makes HTTP calls. No business logic, no LLM, no DB.
 */

import { createRequestSignal } from '../request-timeout.js';

const GITHUB_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'Parakh-Bot';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PRFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function headers(token: string, accept?: string): Headers {
  return new Headers({
    Authorization: `token ${token}`,
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  });
}

async function githubFetch<T>(url: string, token: string, options: RequestInit = {}): Promise<T> {
  const requestHeaders = headers(token);
  new Headers(options.headers).forEach((value, key) => requestHeaders.set(key, value));
  const response = await fetch(url, {
    ...options,
    headers: requestHeaders,
    signal: options.signal ?? createRequestSignal(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error (${response.status}) ${url}: ${body}`);
  }

  return response.json() as Promise<T>;
}

// ─── PR Data ─────────────────────────────────────────────────────────────────

/**
 * Fetch the raw diff for a pull request.
 * Returns the diff as a string (unified diff format).
 */
export async function fetchDiff(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
  const response = await fetch(url, {
    headers: headers(token, 'application/vnd.github.diff'),
    signal: createRequestSignal(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch diff (${response.status}): ${body}`);
  }

  return response.text();
}

/**
 * Fetch the raw diff BETWEEN two pinned refs (base...head).
 * The PR's live diff endpoint always reflects the latest head; pinning the
 * SHA pair at review-start makes the diff immutable for the whole run.
 */
export async function fetchDiffPinned(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token: string
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`;
  const response = await fetch(url, {
    headers: headers(token, 'application/vnd.github.diff'),
    signal: createRequestSignal(),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch pinned diff (${response.status}): ${body}`);
  }

  return response.text();
}

/**
 * Get the list of files changed in a pull request.
 */
export async function getPRFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<PRFile[]> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
  return githubFetch<PRFile[]>(url, token);
}

/**
 * Get file content from a repo (for injecting full file context into review).
 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token: string
): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const data = await githubFetch<{ content: string; encoding: string }>(url, token);

  if (data.encoding === 'base64') {
    return atob(data.content.replace(/\n/g, ''));
  }
  return data.content;
}

// ─── Comments ────────────────────────────────────────────────────────────────

/**
* Post a comment on a PR (Conversation tab).
 * (PRs are issues — uses the Issues API.)
 *
 * NB: GitHub does not support threading on issue comments (the REST API has
 * no `in_reply_to_id`), so this always creates a top-level comment. Only
 * diff review comments support replies, via `replyToReviewComment`.
 *
 * @param owner - Repository owner (e.g. "acme").
 * @param repo - Repository name (e.g. "app").
 * @param prNumber - Pull request number.
 * @param body - Markdown comment body.
 * @param token - GitHub installation access token.
 */
export async function postComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string
): Promise<{ id: number }> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  return githubFetch<{ id: number }>(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

/** Check whether `headSha` descends from `baseSha` without downloading a diff. */
export async function getCompareStatus(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token: string
): Promise<'ahead' | 'behind' | 'diverged' | 'identical'> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`;
  const result = await githubFetch<{ status: 'ahead' | 'behind' | 'diverged' | 'identical' }>(url, token);
  return result.status;
}

export async function postCommentOnce(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  marker: string,
  token: string
): Promise<{ id: number }> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&sort=created&direction=desc`;
  const comments = await githubFetch<Array<{ id: number; body: string | null }>>(url, token);
  const existing = comments.find((comment) => comment.body?.includes(marker));
  if (existing) return { id: existing.id };
  return postComment(owner, repo, prNumber, `${body}\n\n${marker}`, token);
}

/**
 * Post a review comment on a specific line in a PR diff.
 */
export async function postReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  path: string,
  line: number,
  body: string,
  token: string
): Promise<{ id: number }> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  return githubFetch<{ id: number }>(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, commit_id: commitId, path, line, side: 'RIGHT' }),
  });
}

/**
 * Reply to a review comment in a PR diff thread.
 * Target must be the top-level comment of the thread — GitHub rejects
 * replies to a nested reply — see `resolveReviewCommentRoot`.
 */
export async function replyToReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
  token: string
): Promise<{ id: number }> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`;
  return githubFetch<{ id: number }>(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

/**
 * Get a single pull request review comment (diff thread).
 */
export async function getReviewComment(
  owner: string,
  repo: string,
  commentId: number,
  token: string
): Promise<{ id: number; in_reply_to_id: number | null }> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/comments/${commentId}`;
  return githubFetch<{ id: number; in_reply_to_id: number | null }>(url, token);
}

const MAX_REPLY_DEPTH = 3;

/**
 * Resolve the top-level comment of a diff thread for replying.
 *
 * A webhook can fire for a reply inside an existing thread (e.g. the bot's
 * own nested reply). `/replies` only accepts the thread's root comment, so
 * walk the `in_reply_to_id` chain back to the top. The chain is capped at
 * `MAX_REPLY_DEPTH` hops; on cap, the deepest comment reached is returned
 * (defensive only — GitHub threads never go deeper than one reply).
 *
 * @param inReplyToId - Known parent from the webhook payload, when available.
 *   When omitted, the comment is fetched to read its own `in_reply_to_id`.
 */
export async function resolveReviewCommentRoot(
  owner: string,
  repo: string,
  commentId: number,
  inReplyToId: number | undefined,
  token: string
): Promise<number> {
  let parentId = inReplyToId;
  if (parentId === undefined) {
    const self = await getReviewComment(owner, repo, commentId, token);
    parentId = self.in_reply_to_id ?? undefined;
  }
  if (parentId === undefined) return commentId;

  let rootId = commentId;
  for (let depth = 0; depth < MAX_REPLY_DEPTH; depth += 1) {
    const parent = await getReviewComment(owner, repo, parentId, token);
    rootId = parentId;
    if (parent.in_reply_to_id === null) return rootId;
    parentId = parent.in_reply_to_id;
  }
  return rootId;
}

// ─── Reactions (Emoji State Machine) ─────────────────────────────────────────

/**
 * Add a reaction to a PR (via Issues API, since a PR is an issue).
 * Returns the reaction ID (needed for later removal).
 *
 * @param content - One of: 'eyes', '+1', '-1'
 */
export async function addReaction(
  owner: string,
  repo: string,
  issueNumber: number,
  content: string,
  token: string
): Promise<number> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/reactions`;
  const data = await githubFetch<{ id: number }>(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return data.id;
}

/**
 * Remove a reaction from a PR.
 * Requires the reaction's own ID (returned by addReaction).
 */
export async function removeReaction(
  owner: string,
  repo: string,
  issueNumber: number,
  reactionId: number,
  token: string
): Promise<void> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${issueNumber}/reactions/${reactionId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: headers(token),
    signal: createRequestSignal(),
  });

  // 204 No Content is success for DELETE
  if (!response.ok && response.status !== 204) {
    const body = await response.text();
    throw new Error(`Failed to remove reaction (${response.status}): ${body}`);
  }
}

/**
 * Add a reaction to a specific comment (top-level issue comment or inline
 * review comment). Returns the reaction ID (needed for later removal).
 *
 * Same issue_comment vs pull_request_review_comment branch used by
 * postComment/replyToReviewComment — reactions can't be edited in place on
 * GitHub, only added or removed, so the current id is tracked for the swap.
 */
export async function addCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  commentType: 'issue_comment' | 'pull_request_review_comment',
  reactionContent: '+1' | '-1' | 'eyes' | 'confused',
  token: string
): Promise<number> {
  const path = commentType === 'pull_request_review_comment'
    ? `pulls/comments/${commentId}/reactions`
    : `issues/comments/${commentId}/reactions`;
  try {
    const data = await githubFetch<{ id: number }>(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/${path}`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: reactionContent }),
      }
    );
    return data.id;
  } catch (err) {
    throw new Error(`Failed to add comment reaction to ${commentType} ${commentId}`, { cause: err });
  }
}

/**
 * Remove a reaction from a specific comment.
 * Requires the reaction's own ID (returned by addCommentReaction).
 */
export async function removeCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  commentType: 'issue_comment' | 'pull_request_review_comment',
  reactionId: number,
  token: string
): Promise<void> {
  const path = commentType === 'pull_request_review_comment'
    ? `pulls/comments/${commentId}/reactions/${reactionId}`
    : `issues/comments/${commentId}/reactions/${reactionId}`;
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${owner}/${repo}/${path}`,
    {
      method: 'DELETE',
      headers: headers(token),
      signal: createRequestSignal(),
    }
  );

  // 204 No Content is success for DELETE
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to remove comment reaction (${response.status}): ${body}`);
  }
}

/**
 * Get PR details (for head SHA, etc.).
 */
export async function getPRDetails(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<{ head: { sha: string }; base: { sha: string }; user: { login: string } }> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${prNumber}`;
  return githubFetch<{ head: { sha: string }; base: { sha: string }; user: { login: string } }>(url, token);
}
