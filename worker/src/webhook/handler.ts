/**
 * Webhook Event Handler
 *
 * Routes GitHub webhook events to the appropriate job queue.
 * This module ONLY handles event routing and the 👀 reaction posting.
 * No review logic, no LLM, no DB queries beyond reaction tracking.
 */

import { REACTIONS, GITHUB_APP_BOT_SUFFIX } from '@parakh/shared';
import type { ReviewJobPayload, CommentJobPayload } from '@parakh/shared';
import { addReaction, removeReaction, postComment } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { insertReview, getLatestReviewByPR, updateReviewReactions } from '../db/reviews.js';
import type { Env } from '../index.js';
import { executeReviewJob } from '../jobs/review.js';
import { executeCommentResponseJob } from '../jobs/comment-response.js';
import { createRedisGet, createRedisSet, createRedisDel } from '../redis.js';

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
    user: { login: string; id: number };
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
  deliveryId: string,
  env: Env,
  _ctx?: ExecutionContext
): Promise<HandlerResult> {
  switch (eventType) {
    case 'pull_request':
      return handlePullRequest(event, deliveryId, env, _ctx);

    case 'issue_comment':
      return handleIssueComment(event, deliveryId, env, _ctx);

    case 'pull_request_review_comment':
      return handleReviewComment(event, deliveryId, env, _ctx);

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
async function handlePullRequest(event: WebhookEvent, deliveryId: string, env: Env, _ctx?: ExecutionContext): Promise<HandlerResult> {
  const { action, installation, repository, pull_request } = event;

  // Handle synchronize separately — clear stale state but don't auto-review
  if (action === 'synchronize') {
    if (!installation?.id || !repository || !pull_request) {
      return { status: 400, body: 'missing required fields' };
    }
    const fullRepo = repository.full_name;
    const redisDel = createRedisDel(env);
    await redisDel(`pr_review_state:${fullRepo}:${pull_request.number}`);
    console.log(`[webhook] synchronize: cleared stale review state for ${fullRepo}#${pull_request.number}`);
    return { status: 200, body: 'cleared stale review state' };
  }

  if (!['opened', 'reopened'].includes(action)) {
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

  // Insert new review record
  const review = await insertReview(
    {
      repo: fullRepo,
      pr_number: prNumber,
      installation_id: installationId,
      status: 'SEEN',
      seen_reaction_id: seenReactionId,
      github_delivery_id: deliveryId,
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
async function handleIssueComment(event: WebhookEvent, deliveryId: string, env: Env, _ctx?: ExecutionContext): Promise<HandlerResult> {
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

  // Step 0 Guard: Self-Loop Prevention
  if (!env.GITHUB_APP_BOT_USER_ID) {
    throw new Error('GITHUB_APP_BOT_USER_ID not configured, refusing to process comment webhooks');
  }
  if (comment.user.id.toString() === env.GITHUB_APP_BOT_USER_ID) {
    return { status: 200, body: 'ignoring self comment' };
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const fullRepo = repository.full_name;
  const prNumber = issue.number;

  console.log(`[webhook] issue_comment.created on ${fullRepo}#${prNumber} by ${comment.user.login}`);

  const payload: CommentJobPayload = {
    type: 'COMMENT_RESPONSE',
    installationId: installation.id,
    owner,
    repo,
    prNumber,
    commentId: comment.id,
    commentBody: comment.body,
    commentType: 'issue_comment',
    githubDeliveryId: deliveryId,
  };

  if (_ctx) {
    _ctx.waitUntil(executeCommentResponseJob(payload, env).catch(err => {
      console.error('[webhook] Failed to execute comment response job:', err);
    }));
  }
  return { status: 200, body: 'comment response dispatched' };
}

// ─── Review Comment Handler ──────────────────────────────────────────────────

/**
 * Handle pull_request_review_comment events.
 * Only processes comments that reply to a bot review comment.
 */
async function handleReviewComment(event: WebhookEvent, deliveryId: string, env: Env, _ctx?: ExecutionContext): Promise<HandlerResult> {
  const { action, installation, repository, comment, pull_request } = event;

  if (action !== 'created') {
    return { status: 200, body: `ignored review comment action: ${action}` };
  }

  if (!installation?.id || !repository || !comment || !pull_request) {
    return { status: 400, body: 'missing required fields' };
  }

  // Step 0 Guard: Self-Loop Prevention
  if (!env.GITHUB_APP_BOT_USER_ID) {
    throw new Error('GITHUB_APP_BOT_USER_ID not configured, refusing to process comment webhooks');
  }
  if (comment.user.id.toString() === env.GITHUB_APP_BOT_USER_ID) {
    return { status: 200, body: 'ignoring self comment' };
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const fullRepo = repository.full_name;
  const prNumber = pull_request.number;

  console.log(`[webhook] review_comment.created on ${fullRepo}#${prNumber} by ${comment.user.login}`);

  const payload: CommentJobPayload = {
    type: 'COMMENT_RESPONSE',
    installationId: installation.id,
    owner,
    repo,
    prNumber,
    commentId: comment.id,
    commentBody: comment.body,
    commentType: 'pull_request_review_comment',
    githubDeliveryId: deliveryId,
  };

  if (_ctx) {
    _ctx.waitUntil(executeCommentResponseJob(payload, env).catch(err => {
      console.error('[webhook] Failed to execute comment response job:', err);
    }));
  }
  return { status: 200, body: 'comment response dispatched' };
}
