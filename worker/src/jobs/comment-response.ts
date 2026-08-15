import type { CommentJobPayload, GitHubAuthorAssociation } from '@parakh/shared';
import { REACTIONS } from '@parakh/shared';
import type { Env } from '../index.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings, getResumableReview } from '../db/reviews.js';
import { postComment as postIssueComment, replyToReviewComment, addCommentReaction } from '../github/api.js';
import { createLLMClients } from '../llm/factory.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule, isInstructionRule } from './correction.js';
import { createRedisGet, createRedisSet } from '../redis.js';

// ─── Authorization Helpers ─────────────────────────────────────────────────────

type TrustLevel = 'admin' | 'write' | 'read' | 'none';

function resolveTrustLevel(association: GitHubAuthorAssociation): TrustLevel {
  switch (association) {
    case 'OWNER':
    case 'MEMBER':
      return 'admin';
    case 'COLLABORATOR':
      return 'write';
    case 'CONTRIBUTOR':
      return 'read';
    default:
      return 'none';
  }
}

const RATE_LIMITS: Record<string, { max: number; windowSeconds: number }> = {
  REVIEW_REQUEST: { max: 10, windowSeconds: 3600 },
  CORRECTION: { max: 5, windowSeconds: 3600 },
};

async function checkRateLimit(
  intent: string,
  authorLogin: string,
  fullRepo: string,
  env: Env
): Promise<{ allowed: boolean; remaining: number }> {
  const limit = RATE_LIMITS[intent];
  if (!limit) return { allowed: true, remaining: Infinity };

  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const key = `ratelimit:${intent}:${fullRepo}:${authorLogin}`;
  const current = parseInt((await redis.get(key)) ?? '0', 10);

  if (current >= limit.max) {
    return { allowed: false, remaining: 0 };
  }

  await redis.set(key, String(current + 1), { ex: limit.windowSeconds });
  return { allowed: true, remaining: limit.max - current - 1 };
}

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
    authorAssociation,
    authorLogin,
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

  // Helper to abstract the reply endpoint selection. issue_comment replies are
  // nested under the tagged comment (in_reply_to_id) so they stay in its thread
  // instead of becoming a new top-level comment; review comments already reply
  // into the diff thread via /replies.
  const postReply = async (body: string) => {
    if (commentType === 'pull_request_review_comment') {
      await replyToReviewComment(owner, repo, prNumber, commentId, body, token);
    } else {
      await postIssueComment(owner, repo, prNumber, body, token, commentId);
    }
  };

  const { llm } = createLLMClients(env);

  // For issue comments (top-level), there is no parentBotComment context passed directly.
  // We can pass an empty string to the LLM classifier for now, or fetch the parent if needed.
  // The classifier handles empty parentBotComment properly via the prompt update.
  const parentBotComment = ''; 
  const intent = await llm.classifyIntent(commentBody, parentBotComment);

  console.log(`[comment-response] Classified intent: ${intent}`);

  // ── Rate limit check ──
  const { allowed } = await checkRateLimit(intent, authorLogin, fullRepo, env);
  if (!allowed) {
    console.log(`[comment-response] Rate limited: ${authorLogin} on ${fullRepo}`);
    await postReply(`⚠️ Rate limit reached for ${intent.replace('_', ' ').toLowerCase()} commands. Try again later.`);
    return;
  }

  // ── Authorization gate ──
  const trust = resolveTrustLevel(authorAssociation);

  if (intent === 'REVIEW_REQUEST' && trust === 'none') {
    await postReply(
      "⚠️ You need repository write access to trigger a review. " +
      "Only repository owners, members, and collaborators can request reviews."
    );
    return;
  }

  if (intent === 'CORRECTION') {
    if (trust === 'none' || trust === 'read') {
      await postReply(
        "⚠️ You need repository write access to create rules. " +
        "Only repository owners, members, and collaborators can persist corrections."
      );
      return;
    }

    if (trust === 'write' && isInstructionRule(commentBody)) {
      await postReply(
        "⚠️ Only repository **owners** and **members** can create suppression rules. " +
        "Your correction has been noted but not persisted as a rule."
      );
      return;
    }
  }

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
        const initialStatus = trust === 'write' ? 'PENDING' : 'ACTIVE';
        const rule = await saveCorrectionAsRule(
          { installationId, owner, repo, prNumber, commentBody, createdBy: authorLogin, initialStatus },
          env
        );
        if (rule.kind === 'instruction') {
          await postReply(
            `✅ **Noted** — I won't raise *${rule.body}* issues in future reviews of this repo.`
          );
        } else if (rule.status === 'PENDING') {
          await postReply(
            `⏳ **Saved as pending** — your rule *${rule.body}* needs approval from a repository owner/member before it takes effect.`
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
