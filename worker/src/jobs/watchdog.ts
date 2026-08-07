/**
 * Watchdog Consumer
 *
 * Processes delayed queue messages to detect stuck reviews.
 * Each watchdog message carries the review ID, current step, and the
 * event ID that was current when the message was scheduled.
 *
 * Freshness check: if the latest event for the review doesn't match
 * the expected ID, the review has made progress and this firing is stale.
 *
 * Retry logic:
 * - First stall → increment retry_count, re-trigger via auto_retry
 *   (reuses the same review row via resumeReviewId)
 * - Second stall → mark FAILED, post PR comment
 */

import type { WatchdogPayload } from '@parakh/shared';
import { MAX_REVIEW_RETRIES } from '@parakh/shared';
import {
  getReview,
  getLatestStepEvent,
  incrementRetryCount,
  markReviewFailed,
} from '../db/reviews.js';
import { postComment } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import { triggerReview } from './review.js';
import { createRedisGet, createRedisSet } from '../redis.js';
import type { Env } from '../index.js';

// ─── Main Handler ────────────────────────────────────────────────────────────

export async function handleWatchdog(msg: WatchdogPayload, env: Env): Promise<void> {
  const review = await getReview(msg.reviewId, env);

  // Guard: review doesn't exist or is already terminal/paused
  if (!review
    || review.status === 'COMPLETED'
    || review.status === 'FAILED'
    || review.status === 'PAUSED_RATE_LIMITED') {
    return;
  }

  // Freshness check: has the review made progress since this watchdog was scheduled?
  const latestEvent = await getLatestStepEvent(msg.reviewId, env);
  if (!latestEvent || latestEvent.id !== msg.expectedEventId) {
    // A newer event exists — step moved on, this watchdog is stale
    return;
  }

  // Still stuck at the same step.

  // Parse owner/repo from the combined "owner/repo" field
  const [owner, repo] = review.repo.split('/');

  if (review.retry_count >= MAX_REVIEW_RETRIES) {
    // Already retried once — give up
    await markReviewFailed(msg.reviewId, msg.step,
      `Stuck at ${msg.step} with no progress after ${MAX_REVIEW_RETRIES} retry(s)`,
      null, env);

    const redis = { get: createRedisGet(env), set: createRedisSet(env) };
    const token = await getCachedToken(
      review.installation_id!, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis
    );

    await postComment(owner, repo, review.pr_number,
      `🛑 Review stuck at **${msg.step}** and failed after a retry. ` +
      `Reply \`@parakh review\` to try again, or check the dashboard.`,
      token
    );
    return;
  }

  // First stall — retry once, reusing the SAME review row
  await incrementRetryCount(msg.reviewId, env);

  await triggerReview(
    review.installation_id!, // stored on the row since insertReview
    owner,                   // parsed from review.repo
    repo,                    // parsed from review.repo
    review.pr_number,
    'auto_retry',
    env,
    msg.reviewId,            // resumeReviewId — keeps retry_count intact
    true                     // skipLock — dead invocation's lock may still be alive
  );
}
