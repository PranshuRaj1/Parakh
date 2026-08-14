import type { CommentJobPayload } from '@parakh/shared';
import type { Env } from '../index.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings } from '../db/reviews.js';
import { postComment as postIssueComment, replyToReviewComment } from '../github/api.js';
import { createLLMClients } from '../llm/factory.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule } from './correction.js';
import { createRedisGet, createRedisSet } from '../redis.js';
import { parseReviewCommand } from '../review/review-command.js';

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

  const commandMode = parseReviewCommand(commentBody);
  const { llm } = createLLMClients(env);

  // For issue comments (top-level), there is no parentBotComment context passed directly.
  // We can pass an empty string to the LLM classifier for now, or fetch the parent if needed.
  // The classifier handles empty parentBotComment properly via the prompt update.
  const parentBotComment = ''; 
  const intent = commandMode
    ? 'REVIEW_REQUEST'
    : await llm.classifyIntent(commentBody, parentBotComment);

  console.log(`[comment-response] Classified intent: ${intent}`);

  switch (intent) {
    case 'REVIEW_REQUEST': {
      const requestedMode = commandMode ?? 'incremental';
      const result = await triggerReview({
        installationId,
        owner,
        repo,
        prNumber,
        reason: 'manual_mention',
        requestedMode,
        githubDeliveryId,
        commentId,
        commentType,
      }, env);

      if (result === 'ENQUEUED') {
        const article = requestedMode === 'incremental' ? 'an' : 'a';
        await postReply(`On it — starting ${article} ${requestedMode} review 👀`);
      } else if (result === 'RESUMED') {
        await postReply(`On it — resuming the matching ${requestedMode} review 👀`);
      } else if (result === 'ALREADY_ACTIVE') {
        await postReply('A review for this commit and mode is already in progress.');
      } else {
        await postReply(
          'A review is already in progress for a different commit or review mode. ' +
          'Wait for it to finish, then run `@parakh review` or `@parakh full review` again.'
        );
      }
      break;
    }

    case 'CORRECTION': {
      try {
        const rule = await saveCorrectionAsRule(
          { installationId, owner, repo, prNumber, commentBody },
          env
        );
        if (rule.kind === 'instruction') {
          await postReply(
            `✅ **Noted** — I won't raise *${rule.body}* issues in future reviews of this repo.`
          );
        } else {
          const priorityLabel = rule.priority === 'high' ? '🔴 high' : '🟢 normal';
          await postReply(
            `✅ **Learned:** *${rule.body}*\n\nPriority: ${priorityLabel} · Status: **ACTIVE** — applied to future reviews in this repo.`
          );
        }
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
