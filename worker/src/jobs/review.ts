/**
 * Review Job — Core Review Pipeline
 *
 * Orchestrates the review process with batched chunking, resumability, and
 * concurrency-safe API key rotation.
 */

import type { ReviewJobPayload, Finding, Rule, StageReasonCode, ReviewStage, Review } from '@parakh/shared';
import {
  computeScore,
  displayScore,
  resolveSeverityForRuleViolation,
  POSITIVE_THRESHOLD,
  NEGATIVE_THRESHOLD,
  REACTIONS,
  GEMINI_RATE_LIMITS,
  MAX_FILES_PER_BATCH,
  REVIEW_STATE_TTL_SECONDS,
  REVIEW_LOCK_TTL_SECONDS,
} from '@parakh/shared';
import { getCachedToken } from '../github/auth.js';
import {
  fetchDiff,
  postComment,
  addReaction,
  removeReaction,
  replyToReviewComment,
  addCommentReaction,
  removeCommentReaction,
} from '../github/api.js';
import {
  updateReviewStatus,
  updateReviewResults,
  updateReviewReactions,
  getLatestReviewByPR,
  insertReview,
  getReview,
  setTriggerCommentContext,
  updateTriggerCommentReactionId,
} from '../db/reviews.js';
import { getActiveRules, incrementEvidenceCount } from '../db/rules.js';
import { saveReviewReasoning } from '../db/reviews.js';
import { GeminiClient, type ReviewResult } from '../gemini/client.js';
import { AllKeysExhaustedError } from '../gemini/keyPool.js';
import { sanitizeErrorText } from './sanitize.js';
import {
  startStage,
  completeStage,
  failStage,
  updateReason,
  updateReasonDetail,
  heartbeat,
  withTimeout,
  STAGE_TIMEOUTS_MS,
  getReviewingFilesTimeout
} from './stage-tracker.js';
import type { Env } from '../index.js';
import { createRedisGet, createRedisSet, createRedisSetNX, createRedisDel } from '../redis.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_REASONING_RETENTION_DAYS = 14;

function parseRetentionDays(raw?: string): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REASONING_RETENTION_DAYS;
}

function matchesScope(filePath: string, scope: Record<string, unknown>): boolean {
  const patterns = scope.include as string[] | undefined;
  if (!patterns || patterns.length === 0) return true;

  return patterns.some((pattern) => {
    const regex = new RegExp(
      '^' +
      pattern
        .replace(/\*\*/g, '<<<GLOBSTAR>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<GLOBSTAR>>>/g, '.*')
        .replace(/\?/g, '[^/]')
        .replace(/\./g, '\\.') +
      '$'
    );
    return regex.test(filePath);
  });
}

function parseDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const fileDiffs = diff.split(/^diff --git /m).slice(1);
  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');
    const firstLine = lines[0] || '';
    const match = firstLine.match(/b\/(.+)/);
    if (match) files.set(match[1], fileDiff);
  }
  return files;
}

function appendDashboardLink(
  comment: string,
  repo: string,
  prNumber: number,
  dashboardBaseUrl?: string
): string {
  if (!dashboardBaseUrl) return comment;
  const base = dashboardBaseUrl.replace(/\/+$/, '');
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) return comment;
  return `${comment}\n---\n🔍 *Want the model's reasoning? See per-file analysis on the [Parakh dashboard](${base}/pulls/${owner}/${repoName}/${prNumber}).*\n`;
}

function formatReviewComment(
  score: number,
  displayedScore: number,
  findings: Finding[],
  repo: string,
  prNumber: number,
  dashboardBaseUrl?: string
): string {
  const severityEmoji: Record<string, string> = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🔵',
  };

  let comment = `## Parakh Code Review — ${displayedScore}/5\n\n`;

  if (findings.length === 0) {
    comment += '✅ No issues found. Clean code!\n';
    return appendDashboardLink(comment, repo, prNumber, dashboardBaseUrl);
  }

  const grouped: Record<string, Finding[]> = {};
  for (const f of findings) {
    if (!grouped[f.severity]) grouped[f.severity] = [];
    grouped[f.severity].push(f);
  }

  const counts = Object.entries(grouped)
    .map(([sev, items]) => `${severityEmoji[sev]} ${items.length} ${sev}`)
    .join(' · ');
  comment += `**Summary:** ${counts}\n\n`;

  for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const items = grouped[severity];
    if (!items || items.length === 0) continue;

    comment += `### ${severityEmoji[severity]} ${severity}\n\n`;
    for (const f of items) {
      const ruleTag = f.rule_id ? ' *(rule violation)*' : '';
      comment += `- **\`${f.file}:${f.line}\`**${ruleTag}: ${f.body}\n`;
      if (f.suggestion) {
        comment += `  > 💡 ${f.suggestion}\n`;
      }
    }
    comment += '\n';
  }

  return appendDashboardLink(comment, repo, prNumber, dashboardBaseUrl);
}

// ─── Redis State Types & Helpers ─────────────────────────────────────────────

const REVIEW_STATE_KEY = (repo: string, pr: number) => `pr_review_state:${repo}:${pr}`;
const REVIEW_LOCK_KEY  = (repo: string, pr: number) => `pr_review_lock:${repo}:${pr}`;

interface ReviewState {
  reviewId: string;
  allFiles: string[];
  completedFiles: string[];
  accumulatedFindings: Finding[];
  batchIndex: number;
  diffHash: string;
  attemptCounter: number;
}

async function loadReviewState(repo: string, prNumber: number, redisGet: (key: string) => Promise<string | null>): Promise<ReviewState | null> {
  const raw = await redisGet(REVIEW_STATE_KEY(repo, prNumber));
  return raw ? JSON.parse(raw) as ReviewState : null;
}

async function saveReviewState(repo: string, prNumber: number, state: ReviewState, redisSet: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>): Promise<void> {
  await redisSet(REVIEW_STATE_KEY(repo, prNumber), JSON.stringify(state), { ex: REVIEW_STATE_TTL_SECONDS });
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function acquireReviewLock(repo: string, prNumber: number, env: Env): Promise<boolean> {
  const setNX = createRedisSetNX(env);
  return setNX(REVIEW_LOCK_KEY(repo, prNumber), '1', REVIEW_LOCK_TTL_SECONDS);
}

async function releaseReviewLock(repo: string, prNumber: number, env: Env): Promise<void> {
  const del = createRedisDel(env);
  await del(REVIEW_LOCK_KEY(repo, prNumber));
}

// ─── Single File Review Logic ────────────────────────────────────────────────

async function reviewSingleFile(
  gemini: GeminiClient,
  fileName: string,
  fileChunks: Map<string, string>,
  activeRules: Rule[],
  env: Env,
  signal: AbortSignal,
  reviewId: string,
  fileIndex: number,
  totalFiles: number,
  captureReasoning: boolean,
  retentionDays: number
): Promise<Finding[]> {
  const fileDiff = fileChunks.get(fileName);
  if (!fileDiff) return [];

  const applicableRules = activeRules.filter(r =>
    matchesScope(fileName, r.scope as Record<string, unknown>)
  );

  // Live per-file progress: "file 3/8: src/foo.ts" on the reviews row.
  // Uses the light update so we don't append a reason_transitions per file.
  await updateReasonDetail(reviewId, 'PROCESSING', `file ${fileIndex}/${totalFiles}: ${fileName}`, env);

  let result: ReviewResult;
  try {
    result = await gemini.reviewDiff(fileName, fileDiff, applicableRules);
  } catch (err) {
    if (err instanceof AllKeysExhaustedError) throw err;
    // Non-rate-limit per-file failure: persist it so the dashboard can show
    // exactly which file broke and why (failure-mode tie-in).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[review] Error reviewing ${fileName}:`, err);
    if (captureReasoning) {
      await saveReviewReasoning(reviewId, fileName, {
        model: 'gemini-2.5-flash',
        errorMessage: sanitizeErrorText(message),
        retentionDays,
      }, env).catch(e => console.warn('[review] Failed to save per-file reasoning:', e));
    }
    return [];
  }

  if (captureReasoning && result.thinking) {
    await saveReviewReasoning(reviewId, fileName, {
      model: 'gemini-2.5-flash',
      thinking: result.thinking,
      retentionDays,
    }, env).catch(e => console.warn('[review] Failed to save reasoning:', e));
  }

  const findings: Finding[] = [];

  for (const gf of result.genericFindings) {
    findings.push({
      severity: gf.severity,
      file: gf.file || fileName,
      line: gf.line,
      body: gf.body,
      suggestion: gf.suggestion || null,
      rule_id: null,
    });
  }

  for (const rf of result.ruleFindings) {
    const rule = applicableRules.find(r => r.id === rf.rule_id);
    const priority = rule?.priority || 'normal';
    findings.push({
      severity: resolveSeverityForRuleViolation(priority),
      file: rf.file || fileName,
      line: rf.line,
      body: rf.body,
      suggestion: rf.suggestion || null,
      rule_id: rf.rule_id,
    });
    
    // Increment evidence_count per violation instance
    if (rule) {
      await incrementEvidenceCount(rule.id, env);
    }
  }

  return findings;
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

export async function triggerReview(
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  reason: 'opened' | 'synchronize' | 'manual_mention' | 'auto_retry',
  env: Env,
  resumeReviewId?: string,
  skipLock?: boolean,
  githubDeliveryId?: string,
  commentId?: number,
  commentType?: 'issue_comment' | 'pull_request_review_comment',
  commentReactionId?: number
): Promise<void> {
  const fullRepo = `${owner}/${repo}`;

  if (!skipLock) {
    const locked = await acquireReviewLock(fullRepo, prNumber, env);
    if (!locked) {
      console.log(`[review] Skipping — review already in-flight for ${fullRepo}#${prNumber}`);
      return;
    }
  }

  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

  // Clean up previous verdict reaction ONLY on genuinely fresh triggers.
  if (!resumeReviewId) {
    const previousReview = await getLatestReviewByPR(fullRepo, prNumber, env);
    if (previousReview?.verdict_reaction_id) {
      try {
        await removeReaction(owner, repo, prNumber, previousReview.verdict_reaction_id, token);
      } catch (err) {
        console.warn(`[review] Failed to remove previous verdict reaction:`, err);
      }
    }
  }

  let reviewId: string;
  if (resumeReviewId) {
    reviewId = resumeReviewId;
    await updateReviewStatus(reviewId, 'QUEUED', env, githubDeliveryId);
  } else {
    const seenReactionId = await addReaction(owner, repo, prNumber, REACTIONS.SEEN, token);

    if (reason !== 'manual_mention') {
      await postComment(owner, repo, prNumber,
        "Okay, I have seen this PR! Let me review it and get back to you shortly. 🕵️‍♂️",
        token
      );
    }

    const review = await insertReview({
      repo: fullRepo,
      pr_number: prNumber,
      installation_id: installationId,
      status: 'QUEUED',
      seen_reaction_id: seenReactionId,
      trigger_reason: reason,
      github_delivery_id: githubDeliveryId,
    }, env);
    reviewId = review.id;

    // manual_mention fresh starts carry the trigger comment (+ its 👀 reaction
    // id when it was added). Persist so finalizeReview/swap can find them on
    // the same row.
    if (commentId !== undefined && commentType !== undefined) {
      await setTriggerCommentContext(reviewId, commentId, commentType, commentReactionId ?? null, env);
    }
  }

  const payload: ReviewJobPayload = {
    type: 'REVIEW',
    installationId,
    owner,
    repo,
    prNumber,
    reviewId,
  };

  // We push this to the Queue so it runs asynchronously with proper timeouts!
  await env.WATCHDOG_QUEUE.send(payload);
}

// ─── Trigger Comment Reactions & Reply ───────────────────────────────────────

/**
 * Swap the reaction currently live on a review's trigger comment.
 * GitHub reactions can't be edited in place, only added or removed, so the
 * existing one (tracked in trigger_comment_reaction_id) is removed first.
 *
 * content = null means "remove the live reaction, add nothing" — used for the
 * middle-band score that, per PR-level logic, gets no 👍/👎 verdict.
 */
export async function swapCommentReaction(
  review: Review,
  content: '+1' | '-1' | 'confused' | 'eyes' | null,
  owner: string,
  repo: string,
  token: string,
  env: Env
): Promise<void> {
  if (!review.trigger_comment_id || !review.trigger_comment_type) return;

  if (review.trigger_comment_reaction_id) {
    try {
      await removeCommentReaction(
        owner, repo, review.trigger_comment_id, review.trigger_comment_type,
        review.trigger_comment_reaction_id, token
      );
    } catch (err) {
      console.warn(`[review] Failed to remove previous trigger-comment reaction:`, err);
    }
  }

  if (content === null) {
    await updateTriggerCommentReactionId(review.id, null, env);
    return;
  }

  const newReactionId = await addCommentReaction(
    owner, repo, review.trigger_comment_id, review.trigger_comment_type, content, token
  );
  await updateTriggerCommentReactionId(review.id, newReactionId, env);
}

/**
 * Post a threaded "Review done" reply on the trigger comment, so it lands in
 * the same conversation thread the `@parakh review` was posted in.
 */
async function postCommentReply(
  review: Review,
  score: number,
  owner: string,
  repo: string,
  prNumber: number,
  env: Env,
  token: string
): Promise<void> {
  if (!review.trigger_comment_id || !review.trigger_comment_type) return;

  const emoji = score >= POSITIVE_THRESHOLD ? '✅' : '⚠️';
  const base = env.DASHBOARD_BASE_URL ? env.DASHBOARD_BASE_URL.replace(/\/+$/, '') : '';
  const dashboardLink = base
    ? ` Full breakdown on the [dashboard](${base}/pulls/${owner}/${repo}/${prNumber}).`
    : '';
  const body = `${emoji} Review done! Score: **${score}/5**.${dashboardLink}`;

  if (review.trigger_comment_type === 'pull_request_review_comment') {
    await replyToReviewComment(owner, repo, prNumber, review.trigger_comment_id, body, token);
  } else {
    await postComment(owner, repo, prNumber, body, token);
  }
}

export async function executeReviewJob(
  payload: ReviewJobPayload,
  env: Env
): Promise<void> {
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(payload.installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);
  await executeReviewJobInternal(payload, env, token);
}

async function executeReviewJobInternal(
  payload: ReviewJobPayload,
  env: Env,
  token: string
): Promise<void> {
  const { reviewId, owner, repo, prNumber } = payload;
  const fullRepo = `${owner}/${repo}`;
  const redisGet = createRedisGet(env);
  const redisSet = createRedisSet(env);

  // Tracked in function scope so the catch can attribute failures accurately.
  let currentStage: ReviewStage = 'FETCHING_DIFF';
  let stageAttempt = 1;
  let lastReasonCode: StageReasonCode | null = null;
  let lastReasonDetail: string | null = null;

  try {
    // Redelivery guard: if a previous delivery already finished this review,
    // don't re-run the pipeline (avoids duplicate Gemini work + double post).
    const dbReview = await getReview(reviewId, env);
    if (!dbReview) {
      console.error(`[review] No review row found for ${reviewId} — skipping`);
      return;
    }
    if (dbReview.status === 'COMPLETED') {
      console.log(`[review] Review ${reviewId} already COMPLETED — skipping redelivery`);
      return;
    }
    stageAttempt = dbReview.stage_attempt || 1;

    let state = await loadReviewState(fullRepo, prNumber, redisGet);

    currentStage = 'FETCHING_DIFF';
    await startStage(reviewId, 'FETCHING_DIFF', stageAttempt, env);
    const diff = await withTimeout('FETCHING_DIFF', STAGE_TIMEOUTS_MS.FETCHING_DIFF, async (signal) => {
      const res = await fetchDiff(owner, repo, prNumber, token);
      return res;
    });
    const fileChunks = parseDiffByFile(diff);
    const currentDiffHash = await sha256(diff);
    await completeStage(reviewId, 'FETCHING_DIFF', stageAttempt, env);

    if (state && state.diffHash !== currentDiffHash) {
      console.warn(`[review] Diff hash mismatch on resume — starting fresh`);
      state = null;
    }

    if (!state) {
      state = {
        reviewId,
        allFiles: Array.from(fileChunks.keys()),
        completedFiles: [],
        accumulatedFindings: [],
        batchIndex: 0,
        diffHash: currentDiffHash,
        attemptCounter: stageAttempt,
      };
    }

    await saveReviewState(fullRepo, prNumber, state, redisSet);

    const remainingFiles = state.allFiles.filter(f => !state.completedFiles.includes(f));

    if (remainingFiles.length === 0) {
      await finalizeReview(reviewId, state.accumulatedFindings, owner, repo, prNumber, token, env, stageAttempt);
      return;
    }

    currentStage = 'LOADING_RULES';
    await startStage(reviewId, 'LOADING_RULES', stageAttempt, env);
    const activeRules = await withTimeout('LOADING_RULES', STAGE_TIMEOUTS_MS.LOADING_RULES, async () => {
       return getActiveRules(fullRepo, env);
    });
    await completeStage(reviewId, 'LOADING_RULES', stageAttempt, env);

    const gemini = new GeminiClient(env);
    const allFindings = [...state.accumulatedFindings];
    const filesToProcess = [...remainingFiles];

    const captureReasoning = env.REASONING_CAPTURE_ENABLED !== 'false';
    const retentionDays = parseRetentionDays(env.REASONING_RETENTION_DAYS);
    let filesProcessedInThisAttempt = 0;

    currentStage = 'REVIEWING_FILES';
    await startStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
      batchIndex: state.batchIndex,
      fileNames: filesToProcess.slice(0, MAX_FILES_PER_BATCH),
    });
    const filesTimeout = getReviewingFilesTimeout(filesToProcess.length);
    
    await withTimeout('REVIEWING_FILES', filesTimeout, async (signal) => {
      while (filesToProcess.length > 0) {
        if (signal.aborted) break;

        const batch = filesToProcess.splice(0, MAX_FILES_PER_BATCH);

        // Keep lease alive
        await heartbeat(reviewId, env);

        lastReasonCode = 'PROCESSING';
        lastReasonDetail = `Reviewing batch ${state!.batchIndex} (${state!.completedFiles.length}/${state!.allFiles.length} files done)`;
        await updateReason(reviewId, 'PROCESSING', lastReasonDetail, env);

        // Files are processed SEQUENTIALLY within a batch. Concurrent batches
        // used to burst 5 generations at once against free-tier keys, tripping
        // the per-minute ceiling and discarding the whole batch on a 429 —
        // which looped in backoff until the stage timed out with 0 files done.
        let exhaustedAllKeys = false;

        for (let i = 0; i < batch.length; i++) {
          if (signal.aborted) {
            filesToProcess.unshift(...batch.slice(i));
            break;
          }
          const fileName = batch[i];
          try {
            const findings = await reviewSingleFile(
              gemini, fileName, fileChunks, activeRules, env, signal,
              reviewId, state!.completedFiles.length + 1, state!.allFiles.length,
              captureReasoning, retentionDays
            );
            allFindings.push(...findings);
            state!.completedFiles.push(fileName);
            filesProcessedInThisAttempt++;
            lastReasonCode = 'PROCESSING';
            lastReasonDetail = `file ${state!.completedFiles.length}/${state!.allFiles.length}: ${fileName}`;
          } catch (err) {
            if (err instanceof AllKeysExhaustedError) {
              // This file + the rest of the batch go back for the retry pass.
              exhaustedAllKeys = true;
              filesToProcess.unshift(...batch.slice(i));
              break;
            }
            // Non-rate-limit failure: keep existing resume semantics (mark
            // done, no findings); reviewSingleFile already persisted the error.
            console.error(`[review] Error reviewing ${fileName}:`, err);
            state!.completedFiles.push(fileName);
            filesProcessedInThisAttempt++;
            lastReasonCode = 'RETRYING_AFTER_FAILURE';
            lastReasonDetail = `file ${fileName} failed: ${err instanceof Error ? sanitizeErrorText(err.message) : String(err)}`;
          }
        }

        if (exhaustedAllKeys) {
          state!.accumulatedFindings = allFindings;
          await saveReviewState(fullRepo, prNumber, state!, redisSet);

          // Backoff within the same attempt row
          const backoffDuration = 60 * 1000; // 1 minute
          const backoffUntil = new Date(Date.now() + backoffDuration).toISOString();
          lastReasonCode = 'RATE_LIMITED_BACKOFF';
          lastReasonDetail = `backoff until ${backoffUntil}`;
          await updateReason(reviewId, 'RATE_LIMITED_BACKOFF', lastReasonDetail, env);

          await delay(backoffDuration);
          continue;
        }

        state!.batchIndex++;
        state!.accumulatedFindings = allFindings;
        await saveReviewState(fullRepo, prNumber, state!, redisSet);

        if (filesToProcess.length > 0) {
          await delay(GEMINI_RATE_LIMITS.PER_FILE_DELAY_MS);
        }
      }
    });
    
    await completeStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
      batchIndex: state.batchIndex,
      filesProcessed: filesProcessedInThisAttempt,
      completedCount: state.completedFiles.length,
      totalCount: state.allFiles.length,
    });

    await finalizeReview(reviewId, allFindings, owner, repo, prNumber, token, env, stageAttempt);

  } catch (err) {
    const errorCode = err instanceof Error && err.name === 'StageTimeoutError' ? 'STAGE_TIMEOUT' : 'UNKNOWN';
    // Attribute the failure to the real stage and explain WHY (e.g. the
    // rate-limit backoff loop) instead of a generic "Stage timed out".
    const failureMessage =
      lastReasonCode === 'RATE_LIMITED_BACKOFF'
        ? `Every Gemini API key is rate-limited. Last state: ${lastReasonDetail ?? 'n/a'}`
        : (err instanceof Error ? err.message : String(err));
    await failStage(reviewId, currentStage, stageAttempt, errorCode, new Error(failureMessage), false, env);
    throw err; // allow Cloudflare Queue to retry
  } finally {
    await releaseReviewLock(fullRepo, prNumber, env).catch(err =>
      console.warn('[review] Failed to release lock:', err)
    );

    try {
      const review = await getReview(reviewId, env);
      if (review?.status === 'COMPLETED') {
        const redisDel = createRedisDel(env);
        await redisDel(REVIEW_STATE_KEY(fullRepo, prNumber));
      }
    } catch (err) {
      console.warn('[review] Failed to check/clean review state:', err);
    }
  }
}

async function finalizeReview(
  reviewId: string,
  findings: Finding[],
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  env: Env,
  stageAttempt: number
): Promise<void> {
  const fullRepo = `${owner}/${repo}`;

  // Idempotency guard: if another delivery already finalized this review
  // (double completion from a redelivery), bail before posting anything again.
  const current = await getReview(reviewId, env);
  if (current?.status === 'COMPLETED') {
    console.log(`[review] finalize skipped — review ${reviewId} already COMPLETED`);
    return;
  }

  await startStage(reviewId, 'SCORING', stageAttempt, env);
  const rawScore = computeScore(findings);
  const score = displayScore(rawScore);
  await updateReviewResults(reviewId, score, findings, env);
  await completeStage(reviewId, 'SCORING', stageAttempt, env);

  const review = await import('../db/reviews.js').then((m) => m.getLatestReviewByPR(fullRepo, prNumber, env));
  
  await startStage(reviewId, 'REACTING', stageAttempt, env);
  await withTimeout('REACTING', STAGE_TIMEOUTS_MS.REACTING, async () => {
    if (review?.seen_reaction_id) {
      try {
        await removeReaction(owner, repo, prNumber, review.seen_reaction_id, token);
      } catch (err) {
        console.warn(`[review] Failed to remove 👀 reaction:`, err);
      }
    }
  });
  await completeStage(reviewId, 'REACTING', stageAttempt, env);

  await startStage(reviewId, 'POSTING_COMMENT', stageAttempt, env);
  await withTimeout('POSTING_COMMENT', STAGE_TIMEOUTS_MS.POSTING_COMMENT, async () => {
    const comment = formatReviewComment(
      rawScore,
      score,
      findings,
      fullRepo,
      prNumber,
      env.DASHBOARD_BASE_URL
    );
    await postComment(owner, repo, prNumber, comment, token);
  });
  await completeStage(reviewId, 'POSTING_COMMENT', stageAttempt, env);

  let verdictReactionId: number | null = null;
  if (score >= POSITIVE_THRESHOLD) {
    verdictReactionId = await addReaction(owner, repo, prNumber, REACTIONS.POSITIVE, token);
  } else if (score < NEGATIVE_THRESHOLD) {
    verdictReactionId = await addReaction(owner, repo, prNumber, REACTIONS.NEGATIVE, token);
  }

  if (verdictReactionId !== null) {
    await updateReviewReactions(reviewId, env, undefined, verdictReactionId);
  }

  // Comment-triggered reviews (manual_mention): swap 👀 → 👍/👎 on the trigger
  // comment using the same verdict logic as the PR-level reaction (middle band
  // gets no reaction), then post a threaded "Review done" reply. A failure here
  // must never fail an already-completed review.
  try {
    const currentReview = await getReview(reviewId, env);
    if (currentReview?.trigger_comment_id) {
      const verdictContent: '+1' | '-1' | null =
        score >= POSITIVE_THRESHOLD ? '+1' : score < NEGATIVE_THRESHOLD ? '-1' : null;
      await swapCommentReaction(currentReview, verdictContent, owner, repo, token, env);
      await postCommentReply(currentReview, score, owner, repo, prNumber, env, token);
    }
  } catch (err) {
    console.warn(`[review] Failed to update trigger-comment reaction/reply:`, err);
  }

  await updateReviewStatus(reviewId, 'COMPLETED', env);

  console.log(`[review] Completed review for ${fullRepo}#${prNumber}: ${score}/5`);
}
