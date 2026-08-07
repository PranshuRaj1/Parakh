import type { CommentJobPayload } from '@parakh/shared';
import type { Env } from '../index.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings, getResumableReview } from '../db/reviews.js';
import { postComment as postIssueComment, replyToReviewComment } from '../github/api.js';
import { GeminiClient } from '../gemini/client.js';
import { triggerReview } from './review.js';
import { createRedisGet, createRedisSet } from '../redis.js';

export async function executeCommentResponseJob(
  payload: CommentJobPayload,
  env: Env
): Promise<void> {
  const {
    installationId,
    owner,
    repo,
    prNumber,
    commentId,
    commentBody,
    commentType,
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

  const gemini = new GeminiClient(env);

  // For issue comments (top-level), there is no parentBotComment context passed directly.
  // We can pass an empty string to the LLM classifier for now, or fetch the parent if needed.
  // The classifier handles empty parentBotComment properly via the prompt update.
  const parentBotComment = ''; 
  const intent = await gemini.classifyIntent(commentBody, parentBotComment);

  console.log(`[comment-response] Classified intent: ${intent}`);

  switch (intent) {
    case 'REVIEW_REQUEST': {
      // Check for an existing resumable review before creating a new one
      const existingReview = await getResumableReview(fullRepo, prNumber, env);

      if (existingReview) {
        await postReply("On it — resuming the previous review 👀");
        await triggerReview(
          installationId, owner, repo, prNumber,
          'manual_mention', env,
          existingReview.id  // resumeReviewId — reuses existing row
        );
      } else {
        await postReply("On it — re-reviewing 👀");
        await triggerReview(
          installationId, owner, repo, prNumber,
          'manual_mention', env
        );
      }
      break;
    }

    case 'CORRECTION':
      // TODO: wire to correction.ts once memory write is re-enabled
      await postReply("Got it — noted. (Not saved to memory yet — that's next.)");
      break;

    case 'EXPLANATION':
    case 'DISMISSAL':
      await postReply("👍 Noted.");
      break;

    case 'QUESTION':
      const replyBody = await gemini.draftReply(parentBotComment, commentBody);
      await postReply(replyBody);
      break;

    case 'GENERAL':
      // Deliberately silent to avoid being a "try-hard" bot.
      console.log(`[comment-response] Skipped reply for GENERAL intent.`);
      break;
  }
}
