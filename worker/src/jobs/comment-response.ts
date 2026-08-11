import type { CommentJobPayload } from '@parakh/shared';
import { REACTIONS } from '@parakh/shared';
import type { Env } from '../index.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings, getResumableReview } from '../db/reviews.js';
import { postComment as postIssueComment, replyToReviewComment, addCommentReaction } from '../github/api.js';
import { createLLMClients } from '../llm/factory.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule } from './correction.js';
import { createRedisGet, createRedisSet } from '../redis.js';

/**
 * Handle a comment-triggered job (REVIEW_REQUEST / CORRECTION / etc.).
 *
 * @param attempts Queue delivery count. Kept for a uniform executor signature —
 *   queue-handler passes message.attempts to every handler so the delivery
 *   metadata is available if a redelivery ever needs different behavior.
 */
export async function executeCommentResponseJob(
  payload: CommentJobPayload,
  env: Env,
  attempts = 1
): Promise<void> {
  const {
    installationId,
    owner,
    repo,
    prNumber,
    commentId,
    commentBody,
    commentType,
    githubDeliveryId,
  } = payload;

  const fullRepo = `${owner}/${repo}`;
  console.log(`[comment-response] Processing comment on ${fullRepo}#${prNumber}`);

  // Fetch repo settings
  const settings = await getRepoSettings(fullRepo, env);
  const replyMode = settings?.reply_mode ?? 'mentioned_only';

  // Pre-LLM Mention Check (case-insensitive)
  if (replyMode === 'mentioned_only' && !commentBody.toLowerCase().includes('@parakh')) {
    console.log(`[comment-response] Skipped: no mention in mentioned_only mode.`);
    return;
  }

  // Get installation token
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

  // Helper to abstract the reply endpoint selection
  const postReply = async (body: string) => {
    if (commentType === 'pull_request_review_comment') {
      await replyToReviewComment(owner, repo, prNumber, commentId, body, token);
    } else {
      await postIssueComment(owner, repo, prNumber, body, token);
    }
  };

  const { llm } = createLLMClients(env);

  // For issue comments (top-level), there is no parentBotComment context passed directly.
  // We can pass an empty string to the LLM classifier for now, or fetch the parent if needed.
  // The classifier handles empty parentBotComment properly via the prompt update.
  const parentBotComment = ''; 
  const intent = await llm.classifyIntent(commentBody, parentBotComment);

  console.log(`[comment-response] Classified intent: ${intent}`);

  switch (intent) {
    case 'REVIEW_REQUEST': {
      // Check for an existing resumable review before creating a new one
      const existingReview = await getResumableReview(fullRepo, prNumber, env);

      if (existingReview) {
        const enqueued = await triggerReview(
          installationId, owner, repo, prNumber,
          'manual_mention', env,
          existingReview.id,  // resumeReviewId — reuses existing row
          githubDeliveryId    // githubDeliveryId
        );
        if (enqueued) {
          await postReply("On it — resuming the previous review 👀");
        } else {
          await postReply("⚠️ A review is already in progress, please wait and try again.");
        }
      } else {
        // Mark the trigger comment with SEEN while the review runs, then pass the
        // reaction through so triggerReview can persist it on the new row.
        // Best-effort: a reaction failure must not block the review itself.
        let reactionId: number | undefined;
        try {
          reactionId = await addCommentReaction(owner, repo, commentId, commentType, REACTIONS.SEEN, token);
        } catch (err) {
          console.warn(`[comment-response] Failed to add SEEN reaction on trigger comment:`, err);
        }
        const enqueued = await triggerReview(
          installationId, owner, repo, prNumber,
          'manual_mention', env,
          undefined,          // resumeReviewId
          githubDeliveryId,   // githubDeliveryId
          commentId,          // commentId
          commentType,        // commentType
          reactionId          // commentReactionId
        );
        if (enqueued) {
          await postReply("On it — re-reviewing 👀");
        } else {
          await postReply("⚠️ A review is already in progress, please wait and try again.");
        }
      }
      break;
    }

    case 'CORRECTION': {
      try {
        const rule = await saveCorrectionAsRule(
          { installationId, owner, repo, prNumber, commentBody },
          env
        );
        const priorityLabel = rule.priority === 'high' ? '🔴 high' : '🟢 normal';
        await postReply(
          `✅ **Learned:** *${rule.body}*\n\nPriority: ${priorityLabel} · Status: **ACTIVE** — applied to future reviews in this repo.`
        );
      } catch (err) {
        console.error('[comment-response] Failed to save CORRECTION as rule:', err);
        await postReply("Couldn't save that right now — please try again.");
      }
      break;
    }

    case 'EXPLANATION':
    case 'DISMISSAL':
      await postReply("👍 Noted.");
      break;

    case 'QUESTION':
      const replyBody = await llm.draftReply(parentBotComment, commentBody);
      await postReply(replyBody);
      break;

    case 'GENERAL':
      // Deliberately silent to avoid being a "try-hard" bot.
      console.log(`[comment-response] Skipped reply for GENERAL intent.`);
      break;
  }
}
