/**
 * Cron sweeps for stalled reviews
 */

import { dbSweepStalledReviews, dbTimeoutStage, getReview, pruneExpiredReasoning, dbFindResumableDailyQuotaReviews } from './db/reviews.js';
import { withDbRetry, isTransientDbError } from './db/db-retry.js';
import { triggerReview } from './jobs/review.js';
import { getCachedToken } from './github/auth.js';
import { postComment } from './github/api.js';
import { swapCommentReaction, releaseReviewLock } from './jobs/review.js';
import { createRedisGet, createRedisSet } from './redis.js';
import { getDb } from './db/client.js';
import type { Env } from './index.js';

// Watchdog stall window. Must EXCEED the longest internal timeout: a large PR
// can legitimately spend up to ~5s + 30s/file in REVIEWING_FILES (uncapped),
// and NO_PROGRESS_STALL_MS gives 10 minutes before a delivery fails fast. A
// 5-minute sweep could kill a review still inside that window, so this sits
// above both (12 min) — the cron is a last-resort backstop, not the first judge.
const STALL_TIMEOUT_SECONDS = 12 * 60; // 12 minutes

// The watchdog must outlast a Neon cold start / brief connection blip.
// Short backoffs: the 45s per-request DB budget (db/client.ts) dominates;
// the retry exists only to ride out a resume that lands between attempts.
const CRON_DB_RETRY_OPTS = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2000,
  isRetryable: isTransientDbError,
  label: 'cron-db',
};

export async function handleCronTrigger(env: Env): Promise<void> {
  // Prune captured reasoning past its retention window (keeps storage ~zero).
  // Cheap indexed DELETE — only writes when there is something to remove.
  try {
    const pruned = await withDbRetry(() => pruneExpiredReasoning(env), CRON_DB_RETRY_OPTS);
    if (pruned > 0) {
      console.log(`[cron] Pruned ${pruned} expired reasoning row(s)`);
    }
  } catch (err) {
    console.error(`[cron] Failed to prune expired reasoning:`, err);
  }

  // Auto-expire PENDING rules older than 7 days (unapproved collaborator rules).
  try {
    const expired = await withDbRetry(() => expirePendingRules(env), CRON_DB_RETRY_OPTS);
    if (expired > 0) {
      console.log(`[cron] Expired ${expired} unapproved PENDING rule(s)`);
    }
  } catch (err) {
    console.error(`[cron] Failed to expire pending rules:`, err);
  }

  // Auto-resume reviews paused for DAILY quota once their resume window has
  // elapsed. Re-enqueuing a REVIEW job picks up from the per-file Redis state.
  try {
    const paused = await withDbRetry(() => dbFindResumableDailyQuotaReviews(env), CRON_DB_RETRY_OPTS);
    for (const review of paused) {
      const [owner, repo] = review.repo.split('/');
      if (!owner || !repo || !review.installation_id) {
        console.warn(`[cron] Skipping resumable review ${review.id} — missing repo/installation`);
        continue;
      }
      try {
        await triggerReview(
          review.installation_id,
          owner,
          repo,
          review.pr_number,
          'auto_retry',
          env,
          review.id,
          review.github_delivery_id ?? undefined
        );
        console.log(`[cron] Re-enqueued daily-quota-paused review ${review.repo}#${review.pr_number}`);
      } catch (err) {
        console.error(`[cron] Failed to resume daily-quota review ${review.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[cron] Failed to find daily-quota resumes:`, err);
  }

  const stalled = await withDbRetry(() => dbSweepStalledReviews(STALL_TIMEOUT_SECONDS, env), CRON_DB_RETRY_OPTS);

  for (const record of stalled) {
    const { reviewId, stage, attempt } = record;
    
    // Mark as TIMED_OUT in db
    await withDbRetry(() => dbTimeoutStage(reviewId, stage, attempt, env), CRON_DB_RETRY_OPTS);

    const review = await withDbRetry(() => getReview(reviewId, env), CRON_DB_RETRY_OPTS);
    if (!review) continue;

    const [owner, repo] = review.repo.split('/');
    if (!owner || !repo) {
      console.error(`[cron] Cannot notify stalled review ${reviewId}: invalid repository ${review.repo}`);
      continue;
    }
    const redis = { get: createRedisGet(env), set: createRedisSet(env) };

    // Also release the Redis lock so new triggers can proceed immediately.
    try {
      await releaseReviewLock(review.repo, review.pr_number, env);
    } catch (err) {
      console.warn(`[cron] Failed to release lock for stalled review ${reviewId}:`, err);
    }

    if (review.installation_id) {
      try {
        const token = await getCachedToken(
          review.installation_id,
          env.GITHUB_APP_ID,
          env.GITHUB_APP_PRIVATE_KEY,
          redis
        );

        await postComment(
          owner,
          repo,
          review.pr_number,
          `🛑 Review stuck at **${stage}** and timed out. ` +
          `Reply \`@parakh review\` to try again, or check the dashboard.`,
          token
        );
        console.log(`[cron] Swept and failed stalled review ${review.repo}#${review.pr_number} at stage ${stage}`);

        // The review is now FAILED. If it was triggered by a comment, replace
        // the in-progress 👀 on that comment with 😕 (no ❌ reaction exists on
        // GitHub; -1 is reserved for the low-score verdict).
        if (review.trigger_comment_id) {
          try {
            await swapCommentReaction(review, 'confused', owner, repo, token, env);
          } catch (err) {
            console.error(`[cron] Failed to swap trigger-comment reaction for ${reviewId}:`, err);
          }
        }
      } catch (err) {
        console.error(`[cron] Failed to post timeout comment for ${reviewId}:`, err);
      }
    }
  }
}

/**
 * Expire PENDING rules older than 7 days (unapproved collaborator rules).
 */
async function expirePendingRules(env: Env): Promise<number> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    UPDATE rules
    SET status = 'INACTIVE'
    WHERE status = 'PENDING'
      AND created_at < now() - interval '7 days'
    RETURNING id
  `;
  return rows.length;
}
