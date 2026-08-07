/**
 * Webhook Event Handler
 *
 * Routes GitHub webhook events to the appropriate job queue.
 * This module ONLY handles event routing and the 👀 reaction posting.
 * No review logic, no LLM, no DB queries beyond reaction tracking.
 */

import { REACTIONS, GITHUB_APP_BOT_SUFFIX } from '@parakh/shared';
import type { ReviewJobPayload, CorrectionJobPayload } from '@parakh/shared';
import { addReaction, removeReaction, postComment } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { insertReview, getLatestReviewByPR, updateReviewReactions } from '../db/reviews.js';
import type { Env } from '../index.js';
import { executeReviewJob } from '../jobs/review.js';
import { executeCorrectionJob } from '../jobs/correction.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WebhookEvent {
  action: string;
  installation?: { id: number };
  repository?: { full_name: string; owner: { login: string }; name: string };
  pull_request?: {
    number: number;
    head: { sha: string };
    user: { login: string };
  };
  comment?: {
    id: number;
    body: string;
    user: { login: string };
    in_reply_to_id?: number;
  };
  issue?: {
    number: number;
    pull_request?: { url: string };
  };
  sender?: { login: string };
}

interface HandlerResult {
  status: number;
  body: string;
}

// ─── Main Router ─────────────────────────────────────────────────────────────

/**
 * Route a webhook event to the appropriate handler.
 *
 * @param event - Parsed webhook payload
 * @param eventType - Value of the X-GitHub-Event header
 * @param env - Worker environment bindings
 */
export async function handleWebhookEvent(
  event: WebhookEvent,
  eventType: string,
  env: Env,
  _ctx?: ExecutionContext
): Promise<HandlerResult> {
  switch (eventType) {
    case 'pull_request':
      return handlePullRequest(event, env, _ctx);

    case 'issue_comment':
      return handleIssueComment(event, env, _ctx);

    case 'pull_request_review_comment':
      return handleReviewComment(event, env, _ctx);

    case 'installation':
    case 'installation_repositories':
      console.log(`[webhook] ${eventType}: ${event.action}`);
      return { status: 200, body: 'ok' };

    default:
      return { status: 200, body: `ignored event type: ${eventType}` };
  }
}

// ─── Pull Request Handler ────────────────────────────────────────────────────

/**
 * Handle pull_request events: opened, synchronize, reopened.
 *
 * 1. Post 👀 reaction SYNCHRONOUSLY (within 10s ack window — this is the part users watch for)
 * 2. On synchronize: delete previous verdict reaction (prevent stale 👍 + fresh 👀)
 * 3. Insert new review record with status SEEN
 * 4. Enqueue review job
 */
async function handlePullRequest(event: WebhookEvent, env: Env, _ctx?: ExecutionContext): Promise<HandlerResult> {
  const { action, installation, repository, pull_request } = event;

  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    return { status: 200, body: `ignored PR action: ${action}` };
  }

  if (!installation?.id || !repository || !pull_request) {
    return { status: 400, body: 'missing required fields' };
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const fullRepo = repository.full_name;
  const prNumber = pull_request.number;
  const installationId = installation.id;

  console.log(`[webhook] pull_request.${action}: ${fullRepo}#${prNumber}`);

  // Get installation token
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

  // On synchronize: clean up previous verdict reaction to prevent stale 👍 + fresh 👀
  if (action === 'synchronize') {
    const previousReview = await getLatestReviewByPR(fullRepo, prNumber, env);
    if (previousReview?.verdict_reaction_id) {
      try {
        await removeReaction(owner, repo, prNumber, previousReview.verdict_reaction_id, token);
      } catch (err) {
        console.warn(`[webhook] Failed to remove previous verdict reaction:`, err);
      }
    }
  }

  // Post 👀 reaction SYNCHRONOUSLY — proof the bot noticed, before enqueue
  const seenReactionId = await addReaction(owner, repo, prNumber, REACTIONS.SEEN, token);

  // Post an acknowledgment comment to let the developer know the review is starting
  await postComment(
    owner,
    repo,
    prNumber,
    "Okay, I have seen this PR! Let me review it and get back to you shortly. 🕵️‍♂️",
    token
  );

  // Insert new review record (new row per synchronize — free score history)
  const review = await insertReview(
    {
      repo: fullRepo,
      pr_number: prNumber,
      status: 'SEEN',
      seen_reaction_id: seenReactionId,
    },
    env
  );

  // Enqueue review job
  const payload: ReviewJobPayload = {
    type: 'REVIEW',
    installationId,
    owner,
    repo,
    prNumber,
    reviewId: review.id,
  };

  // Run asynchronously without blocking the webhook response
  if (_ctx) {
    _ctx.waitUntil(executeReviewJob(payload, env).catch(err => {
      console.error('[webhook] Failed to execute review job:', err);
    }));
  }
  console.log(`[webhook] Dispatched review job for ${fullRepo}#${prNumber} (review: ${review.id})`);

  return { status: 200, body: 'review enqueued' };
}

// ─── Issue Comment Handler ───────────────────────────────────────────────────

/**
 * Handle issue_comment events (on PRs).
 * Only processes comments that are replies to bot comments.
 */
async function handleIssueComment(event: WebhookEvent, env: Env, _ctx?: ExecutionContext): Promise<HandlerResult> {
  const { action, installation, repository, comment, issue } = event;

  if (action !== 'created') {
    return { status: 200, body: `ignored comment action: ${action}` };
  }

  // Only care about comments on PRs (issue_comment fires for both issues and PRs)
  if (!issue?.pull_request) {
    return { status: 200, body: 'not a PR comment' };
  }

  if (!installation?.id || !repository || !comment) {
    return { status: 400, body: 'missing required fields' };
  }

  // Don't process our own comments
  if (comment.user.login.endsWith(GITHUB_APP_BOT_SUFFIX)) {
    return { status: 200, body: 'ignoring bot comment' };
  }

  // For issue comments, we check if this is a reply to a bot comment
  // by looking for a bot mention or by context. In practice, GitHub doesn't
  // have native threading for issue comments, so we'll process all comments
  // on PRs where the bot has commented and let the intent classifier decide.
  const owner = repository.owner.login;
  const repo = repository.name;
  const fullRepo = repository.full_name;
  const prNumber = issue.number;

  console.log(`[webhook] issue_comment.created on ${fullRepo}#${prNumber} by ${comment.user.login}`);

  const payload: CorrectionJobPayload = {
    type: 'CORRECTION',
    installationId: installation.id,
    owner,
    repo,
    prNumber,
    commentId: comment.id,
    commentBody: comment.body,
    parentCommentBody: '', // Will be resolved in the correction job
  };

  if (_ctx) {
    _ctx.waitUntil(executeCorrectionJob(payload, env).catch(err => {
      console.error('[webhook] Failed to execute correction job:', err);
    }));
  }
  return { status: 200, body: 'correction check dispatched' };
}

// ─── Review Comment Handler ──────────────────────────────────────────────────

/**
 * Handle pull_request_review_comment events.
 * Only processes comments that reply to a bot review comment.
 */
async function handleReviewComment(event: WebhookEvent, env: Env, _ctx?: ExecutionContext): Promise<HandlerResult> {
  const { action, installation, repository, comment, pull_request } = event;

  if (action !== 'created') {
    return { status: 200, body: `ignored review comment action: ${action}` };
  }

  if (!installation?.id || !repository || !comment || !pull_request) {
    return { status: 400, body: 'missing required fields' };
  }

  // Don't process our own comments
  if (comment.user.login.endsWith(GITHUB_APP_BOT_SUFFIX)) {
    return { status: 200, body: 'ignoring bot comment' };
  }

  // Only process replies to bot comments (in_reply_to_id present)
  if (!comment.in_reply_to_id) {
    return { status: 200, body: 'not a reply' };
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const fullRepo = repository.full_name;
  const prNumber = pull_request.number;

  console.log(`[webhook] review_comment.created on ${fullRepo}#${prNumber} by ${comment.user.login}`);

  const payload: CorrectionJobPayload = {
    type: 'CORRECTION',
    installationId: installation.id,
    owner,
    repo,
    prNumber,
    commentId: comment.id,
    commentBody: comment.body,
    parentCommentBody: '', // Will be resolved in the correction job
  };

  if (_ctx) {
    _ctx.waitUntil(executeCorrectionJob(payload, env).catch(err => {
      console.error('[webhook] Failed to execute correction job:', err);
    }));
  }
  return { status: 200, body: 'correction check dispatched' };
}

// ─── Redis Helpers ───────────────────────────────────────────────────────────

function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    const data = (await response.json()) as { result: string | null };
    return data.result;
  };
}

function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${key}/${value}/EX/${opts.ex}` : `/${key}/${value}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    return response.json();
  };
}
