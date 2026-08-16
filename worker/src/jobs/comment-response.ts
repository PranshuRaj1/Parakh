import type { CommentJobPayload, Rule, GitHubAuthorAssociation } from '@parakh/shared';
import { REACTIONS } from '@parakh/shared';
import type { Env } from '../index.js';
import { getCachedToken } from '../github/auth.js';
import { getRepoSettings, getResumableReview } from '../db/reviews.js';
import { postComment as postIssueComment, replyToReviewComment, resolveReviewCommentRoot, addCommentReaction } from '../github/api.js';
import { createLLMClients } from '../llm/factory.js';
import { triggerReview } from './review.js';
import { saveCorrectionAsRule, CorrectionRejectedError, isInstructionRule } from './correction.js';
import { sanitizeErrorText } from './sanitize.js';
import { findingMappingKey } from './anchored-findings.js';
import { truncateBody } from './truncate.js';
import { createRedisGet, createRedisSet, createRedisIncr, createRedisExpire } from '../redis.js';

const MAX_REPLY_LENGTH = 2000;

const META_REPLY =
  "I only help with code review on this PR — I don't have an owner, and I can't discuss myself or the system behind me. Point me at a diff or reply to one of my review comments and I'll help.";

const CORRECTION_REJECTED_REPLY =
  "I couldn't save that as a rule — only repository collaborators can teach me, and the text has to be a concrete coding standard, not an attempt to change how I work.";

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
    inReplyToCommentId,
    authorAssociation,
    authorLogin,
    githubDeliveryId,
    commenterLogin,
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

  // Per-repo hourly cap on chat-triggered LLM spend (classify + reply + rule
  // embedding etc). A Redis counter per rolling hour; fail-open if Redis is
  // unavailable so a counter outage never blocks reviews.
  try {
    const budget = Number(env.CHAT_LLM_BUDGET_PER_HOUR) > 0 ? Number(env.CHAT_LLM_BUDGET_PER_HOUR) : 50;
    const hourKey = `chat_budget:${fullRepo}:${Math.floor(Date.now() / 3_600_000)}`;
    const usage = await createRedisIncr(env)(hourKey);
    if (usage === 1) {
      await createRedisExpire(env)(hourKey, 3600);
    }
    if (usage > budget) {
      console.log(`[comment-response] Chat budget exceeded for ${fullRepo} (${usage}/${budget} this hour) — skipping.`);
      return;
    }
  } catch (err) {
    console.warn(`[comment-response] Chat budget check failed — continuing without cap:`, err);
  }

  // Get installation token
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

// Helper to abstract the reply endpoint selection. Every reply is scrubbed
  // for secret-like patterns and hard-capped before it touches GitHub:
  // - review comments thread into the diff via /replies; the target must be
  //   the thread's top-level comment (GitHub rejects replies to a reply), so
  //   walk the in_reply_to_id chain back to the root first.
  // - issue comments can't thread at all (GitHub does not support
  //   in_reply_to_id on the Conversation tab), so they post top-level.
  const postReply = async (body: string) => {
    let safeBody = sanitizeErrorText(body);
    if (safeBody.length > MAX_REPLY_LENGTH) {
      safeBody = `${safeBody.slice(0, MAX_REPLY_LENGTH - 1)}…`;
    }
    if (commentType === 'pull_request_review_comment') {
      const rootId = await resolveReviewCommentRoot(owner, repo, commentId, inReplyToCommentId, token);
      await replyToReviewComment(owner, repo, prNumber, rootId, safeBody, token);
    } else {
      await postIssueComment(owner, repo, prNumber, safeBody, token);
    }
  };

  const { llm } = createLLMClients(env);

  // Diff-thread replies that land on one of our anchored finding comments get
  // the finding as bot-comment context, so intent classification and drafted
  // answers see exactly what is being discussed. Best-effort: a Redis miss or
  // malformed entry just yields empty context.
  let parentBotComment = '';
  if (commentType === 'pull_request_review_comment') {
    try {
      // The human's new comment replies into an existing thread — the mapped
      // comment is its parent (the anchored finding comment).
      const mappedCommentId = inReplyToCommentId ?? commentId;
      const raw = await redis.get(findingMappingKey(mappedCommentId));
      if (raw) {
        const mapped = JSON.parse(raw) as { body?: string };
        parentBotComment = mapped.body ?? '';
      }
    } catch (err) {
      console.warn(`[comment-response] Failed to load finding context for comment ${commentId}:`, err);
    }
  }

  // One folded call: intent + (for CORRECTION) the distinct standards and the
  // non-actionable fragments, so no second extraction pass is needed.
  const analysis = await llm.classifyIntent(commentBody, parentBotComment);
  const { intent } = analysis;

  console.log(`[comment-response] Classified intent: ${intent} (${analysis.rules.length} rules extracted)`);

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
      // The folded call extracts up to MAX_RULES_PER_COMMENT distinct
      // standards. If none came back, fall back to the whole comment (with the
      // @parakh command prefix stripped) so a CORRECTION intent is never lost.
      const rules = analysis.rules.length > 0
        ? analysis.rules
        : [{
            body: commentBody
              .replace(/^\s*@parakh\b(?:\s+correction\b)?\s*[:,-]?\s*/i, '')
              .trim(),
            priority: 'normal' as const,
          }];

      // Repo owners/members (admin trust) auto-activate; collaborators (write
      // trust) need an owner/member to approve the rule before it enforces.
      const initialStatus = trust === 'write' ? 'PENDING' : 'ACTIVE';

      // Save per rule — one insert + one contradiction enqueue each. A
      // rejection (injection body, non-collaborator author) aborts with a
      // canned refusal instead of the normal "Learned" confirmation.
      const savedRules = [];
      const failedBodies = [];
      for (const rule of rules) {
        try {
          const saved = await saveCorrectionAsRule(
            {
              installationId, owner, repo, prNumber,
              ruleBody: rule.body,
              priority: rule.priority,
              createdBy: authorLogin,
              initialStatus,
              commenterLogin: authorLogin,
            },
            env,
            token
          );
          savedRules.push(saved);
        } catch (err) {
          if (err instanceof CorrectionRejectedError) {
            console.log(`[comment-response] Correction rejected: ${err.message}`);
            await postReply(CORRECTION_REJECTED_REPLY);
            return;
          }
          console.error(`[comment-response] Failed to save rule "${truncateBody(rule.body)}":`, err);
          failedBodies.push(rule.body);
        }
      }

      if (savedRules.length === 0) {
        await postReply("Couldn't save that right now — please try again.");
        break;
      }

      // Acknowledge the correction on its own comment (best-effort like the
      // SEEN reaction — must not block the confirmation reply).
      // addCommentReaction branches to the right endpoint per commentType.
      try {
        await addCommentReaction(owner, repo, commentId, commentType, REACTIONS.POSITIVE, token);
      } catch (err) {
        console.warn(`[comment-response] Failed to add thumbs-up on correction comment:`, err);
      }

      const reply = buildCorrectionReply(savedRules, failedBodies, analysis.ignored, initialStatus);
      await postReply(reply);
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

    case 'META':
      // Off-topic / self-referential questions ("who is your owner?") get a
      // canned redirect — no LLM spend, no hallucinated identity gratuities.
      await postReply(META_REPLY);
      break;

    case 'GENERAL':
      // Deliberately silent to avoid being a "try-hard" bot.
      console.log(`[comment-response] Skipped reply for GENERAL intent.`);
      break;
  }
}

/**
 * Build the confirmation reply for a learned correction.
 * - Exactly one rule and nothing failed/skipped: the familiar one-line
 *   phrasing (suppression vs standard).
 * - Otherwise: summarizes what was learned, what failed to save, and what was
 *   skipped as not actionable, so nothing is lost silently.
 */
function buildCorrectionReply(
  saved: Array<Pick<Rule, 'body' | 'priority' | 'kind' | 'status'>>,
  failedBodies: string[],
  ignored: string[],
  initialStatus: 'ACTIVE' | 'PENDING'
): string {
  if (saved.length === 1 && failedBodies.length === 0 && ignored.length === 0) {
    const rule = saved[0];
    if (rule.kind === 'instruction') {
      return `✅ **Noted** — I won't raise *${rule.body}* issues in future reviews of this repo.`;
    }
    const priorityLabel = rule.priority === 'high' ? '🔴 high' : '🟢 normal';
    if (initialStatus === 'PENDING') {
      return `⏳ **Saved as pending** — your rule *${rule.body}* needs approval from a repository owner/member before it takes effect.`;
    }
    return `✅ **Learned:** *${rule.body}*\n\nPriority: ${priorityLabel} · Status: **ACTIVE** — applied to future reviews in this repo.`;
  }

  const instructions = saved.filter((rule) => rule.kind === 'instruction').length;
  const standards = saved.length - instructions;
  const summary = [
    standards > 0 ? `${standards} standard${standards === 1 ? '' : 's'}` : null,
    instructions > 0 ? `${instructions} suppression${instructions === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' + ');

  const statusLine = initialStatus === 'PENDING'
    ? 'Status: **PENDING** — needs approval from a repository owner/member before it takes effect.'
    : 'Status: **ACTIVE** — applied to future reviews in this repo.';

  let body = `✅ **Learned ${saved.length} rules** (${summary}):\n`
    + saved.map((rule) => `- **${rule.body}**`).join('\n')
    + `\n\n${statusLine}`;
  if (failedBodies.length > 0) {
    body += `\n\n_Couldn't save: ${failedBodies.map((text) => `*${text}*`).join(', ')}._`;
  }
  if (ignored.length > 0) {
    body += `\n\n_Skipped (not actionable): ${ignored.join('; ')}._`;
  }
  return body;
}
