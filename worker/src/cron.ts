/**
 * Cron sweeps for stalled reviews
 */

import { dbSweepStalledReviews, dbTimeoutStage, getReview, pruneExpiredReasoning, dbFindResumableDailyQuotaReviews } from './db/reviews.js';
import { triggerReview } from './jobs/review.js';
import { getCachedToken } from './github/auth.js';
import { postComment } from './github/api.js';
import { swapCommentReaction, releaseReviewLock } from './jobs/review.js';
import { createRedisGet, createRedisSet } from './redis.js';
import type { Env } from './index.js';

// Watchdog stall window. Must EXCEED the longest internal timeout: a large PR
// can legitimately spend up to ~5s + 30s/file in REVIEWING_FILES (uncapped),
// and NO_PROGRESS_STALL_MS gives 10 minutes before a delivery fails fast. A
// 5-minute sweep could kill a review still inside that window, so this sits
// above both (12 min) — the cron is a last-resort backstop, not the first judge.
const STALL_TIMEOUT_SECONDS = 12 * 60; // 12 minutes

export async function handleCronTrigger(env: Env): Promise<void> {
  // Prune captured reasoning past its retention window (keeps storage ~zero).
  // Cheap indexed DELETE — only writes when there is something to remove.
  try {
    const pruned = await pruneExpiredReasoning(env);
    if (pruned > 0) {
      console.log(`[cron] Pruned ${pruned} expired reasoning row(s)`);
    }
  } catch (err) {
    console.error(`[cron] Failed to prune expired reasoning:`, err);
  }

  // Auto-resume reviews paused for DAILY quota once their resume window has
  // elapsed. Re-enqueuing a REVIEW job picks up from the per-file Redis state.
  try {
    const paused = await dbFindResumableDailyQuotaReviews(env);
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

  const stalled = await dbSweepStalledReviews(STALL_TIMEOUT_SECONDS, env);

  for (const record of stalled) {
    const { reviewId, stage, attempt } = record;
    
    // Mark as TIMED_OUT in db
    await dbTimeoutStage(reviewId, stage, attempt, env);

    const review = await getReview(reviewId, env);
    if (!review) continue;

    const [owner, repo] = review.repo.split('/');
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
