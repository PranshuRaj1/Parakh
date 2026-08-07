/**
 * Cron sweeps for stalled reviews
 */

import { dbSweepStalledReviews, dbTimeoutStage, getReview, pruneExpiredReasoning } from './db/reviews.js';
import { getCachedToken } from './github/auth.js';
import { postComment } from './github/api.js';
import { swapCommentReaction } from './jobs/review.js';
import { createRedisGet, createRedisSet } from './redis.js';
import type { Env } from './index.js';

const STALL_TIMEOUT_SECONDS = 5 * 60; // 5 minutes

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

  const stalled = await dbSweepStalledReviews(STALL_TIMEOUT_SECONDS, env);

  for (const record of stalled) {
    const { reviewId, stage, attempt } = record;
    
    // Mark as TIMED_OUT in db
    await dbTimeoutStage(reviewId, stage, attempt, env);

    const review = await getReview(reviewId, env);
    if (!review) continue;

    const [owner, repo] = review.repo.split('/');
    const redis = { get: createRedisGet(env), set: createRedisSet(env) };

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
