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
  fetchDiffPinned,
  getPRDetails,
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
  updateReviewShaPin,
  dbMarkDailyQuotaPaused,
  recordReviewFileEvent,
} from '../db/reviews.js';
import { getActiveRules, incrementEvidenceCount } from '../db/rules.js';
import { saveReviewReasonings } from '../db/reviews.js';
import { type ReviewResult } from '../gemini/client.js';
import { AllKeysExhaustedError, DailyQuotaExhaustedError, DAILY_QUOTA_PAUSE_AFTER_MS } from '../gemini/keyPool.js';
import type { LLMClient } from '../llm/provider.js';
import { createLLMClients } from '../llm/factory.js';
import {
  SubrequestBudget,
  SubrequestBudgetExceededError,
  SUBREQUEST_BUDGET_LIMIT,
  FINALIZE_BUDGET_RESERVE,
} from './subrequest-budget.js';
import { sanitizeErrorText } from './sanitize.js';
import {
  startStage,
  completeStage,
  failStage,
  updateReason,
  updateReasonDetail,
  heartbeat,
  withTimeout,
  StageTimeoutError,
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

/** If no file completes within this window, the attempt is considered stalled
 *  (e.g. every key rate-limited) and fails fast so the queue can resume. */
const NO_PROGRESS_STALL_MS = 10 * 60_000;

/** Concurrent files reviewed within a batch (env FILE_CONCURRENCY overrides). */
const DEFAULT_FILE_CONCURRENCY = 2;

/**
 * Fixed subrequests spent before the file loop (acquire lock, getReview,
 * getCachedToken, fetchDiff, loadRules, stage start/completes). Conservative
 * upper bound so the per-file budget accounting has accurate headroom.
 */
const STARTUP_SUBREQUESTS_ESTIMATE = 12;

export function parseRetentionDays(raw?: string): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REASONING_RETENTION_DAYS;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // Globstar matches zero or more path segments.
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i++;
        }
      } else {
        // Bare * never crosses a path separator.
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else if ('.+()[]{}$^|\\'.includes(ch)) {
      source += '\\' + ch;
    } else {
      source += ch;
    }
  }
  return new RegExp(source + '$');
}

export function matchesScope(filePath: string, scope: Record<string, unknown>): boolean {
  const patterns = scope.include as string[] | undefined;
  if (!patterns || patterns.length === 0) return true;

  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern);
    return regex.test(filePath);
  });
}

export function parseDiffByFile(diff: string): Map<string, string> {
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

/**
 * Generated lockfiles can be thousands of lines (and are machine-generated,
 * so review them anyway), so skip them. Reviewing them burns dozens of Gemini
 * subrequests and can trip the Worker subrequest limit on large diffs.
 */
const IGNORED_LOCKFILE_NAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
];

export function isIgnoredLockfile(filePath: string): boolean {
  return IGNORED_LOCKFILE_NAMES.some(
    (name) => filePath === name || filePath.endsWith(`/${name}`)
  );
}

export function appendDashboardLink(
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

export function formatReviewComment(
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

/** Extend the lock TTL so long reviews keep their exclusive hold. */
async function refreshReviewLock(repo: string, prNumber: number, env: Env): Promise<void> {
  const set = createRedisSet(env);
  await set(REVIEW_LOCK_KEY(repo, prNumber), '1', { ex: REVIEW_LOCK_TTL_SECONDS });
}

export async function releaseReviewLock(repo: string, prNumber: number, env: Env): Promise<void> {
  const del = createRedisDel(env);
  await del(REVIEW_LOCK_KEY(repo, prNumber));
}

// ─── Single File Review Logic ────────────────────────────────────────────────

interface ReasoningEntry {
  file: string;
  model?: string | null;
  thinking?: string | null;
  errorMessage?: string | null;
  retentionDays?: number;
}

/** Throttle live per-file progress writes to every N files to save subrequests. */
const DETAIL_UPDATE_EVERY = 5;

async function reviewSingleFile(
  llm: LLMClient,
  fileName: string,
  fileChunks: Map<string, string>,
  activeRules: Rule[],
  env: Env,
  signal: AbortSignal,
  reviewId: string,
  fileIndex: number,
  totalFiles: number,
  captureReasoning: boolean,
  retentionDays: number,
  reasoningBuffer: ReasoningEntry[],
  budget: SubrequestBudget
): Promise<Finding[]> {
  const fileDiff = fileChunks.get(fileName);
  if (!fileDiff) return [];

  const applicableRules = activeRules.filter(r =>
    matchesScope(fileName, r.scope as Record<string, unknown>)
  );

  // Live per-file progress: "file 3/8: src/foo.ts" on the reviews row.
  // Uses the light update so we don't append a reason_transitions per file.
  // Throttled to every DETAIL_UPDATE_EVERY files + the last file so a large PR
  // doesn't burn one DB subrequest per file (13 files → ~3 writes).
  if (fileIndex % DETAIL_UPDATE_EVERY === 0 || fileIndex === totalFiles) {
    await updateReasonDetail(reviewId, 'PROCESSING', `file ${fileIndex}/${totalFiles}: ${fileName}`, env);
    budget.spend(1);
  }

  let result: ReviewResult;
  try {
    // The real Gemini/Groq calls happen inside the provider's key rotation,
    // which spends from the budget per actual attempt — so no spend here.
    result = await llm.reviewDiff(fileName, fileDiff, applicableRules);
  } catch (err) {
    if (err instanceof AllKeysExhaustedError) throw err;
    if (err instanceof SubrequestBudgetExceededError) throw err;
    // Non-rate-limit per-file failure: persist it so the dashboard can show
    // exactly which file broke and why (failure-mode tie-in).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[review] Error reviewing ${fileName}:`, err);
    // Per-file telemetry row — FAILED, best-effort (a DB failure here must not
    // mask the original per-file error).
    try {
      budget.spend(1);
      await recordReviewFileEvent({
        reviewId,
        file: fileName,
        status: 'FAILED',
        provider: llm.servedProvider,
        model: llm.modelName,
        findingsCount: 0,
        errorMessage: sanitizeErrorText(message),
      }, env);
    } catch (telemetryErr) {
      console.warn(`[review] Failed to record file event for ${fileName}:`, telemetryErr);
    }
    if (captureReasoning) {
      reasoningBuffer.push({
        file: fileName,
        model: llm.modelName,
        errorMessage: sanitizeErrorText(message),
        retentionDays,
      });
    }
    return [];
  }

  if (captureReasoning && result.thinking) {
    reasoningBuffer.push({
      file: fileName,
      model: llm.modelName,
      thinking: result.thinking,
      retentionDays,
    });
  }

  // Per-file telemetry row — COMPLETED, with the provider that served it and
  // the finding count so large-PR progress is pixel-verifiable.
  try {
    budget.spend(1);
    await recordReviewFileEvent({
      reviewId,
      file: fileName,
      status: 'COMPLETED',
      provider: llm.servedProvider,
      model: llm.modelName,
      findingsCount: result.genericFindings.length + result.ruleFindings.length,
    }, env);
  } catch (telemetryErr) {
    console.warn(`[review] Failed to record file event for ${fileName}:`, telemetryErr);
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
      budget.spend(1); // DB write
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
  githubDeliveryId?: string,
  commentId?: number,
  commentType?: 'issue_comment' | 'pull_request_review_comment',
  commentReactionId?: number
): Promise<boolean> {
  const fullRepo = `${owner}/${repo}`;

  // Pre-enqueue dedupe: never create two REVIEW jobs for the same PR at once.
  // The authoritative guard lives in executeReviewJobInternal (execution-time
  // acquire), so this lock is held only until the message is enqueued.
  const locked = await acquireReviewLock(fullRepo, prNumber, env);
  if (!locked) {
    console.log(`[review] Skipping — review already in-flight for ${fullRepo}#${prNumber}`);
    return false;
  }

  let reviewId: string;
  try {
    const redis = { get: createRedisGet(env), set: createRedisSet(env) };
    const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

    // Capture the SHA pin (head/base) so the reviewed diff is immutable for
    // the whole run, regardless of later pushes. Best-effort: if this fails,
    // executeReviewJobInternal re-captures it as a fallback.
    let headSha: string | null = null;
    let baseSha: string | null = null;
    if (!resumeReviewId) {
      try {
        const details = await getPRDetails(owner, repo, prNumber, token);
        headSha = details.head?.sha ?? null;
        baseSha = details.base?.sha ?? null;
      } catch (err) {
        console.warn(`[review] Failed to capture SHA pin for ${fullRepo}#${prNumber}:`, err);
      }
    }

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

    if (resumeReviewId) {
      reviewId = resumeReviewId;
      await updateReviewStatus(reviewId, 'QUEUED', env, githubDeliveryId);
    } else {
      // Best-effort: a reaction failure must NOT crash triggerReview — the
      // queue job would retry endlessly without ever enqueueing the review.
      let seenReactionId: number | null = null;
      try {
        seenReactionId = await addReaction(owner, repo, prNumber, REACTIONS.SEEN, token);
      } catch (err) {
        console.warn(`[review] Failed to add seen reaction for ${fullRepo}#${prNumber}:`, err);
      }

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
        seen_reaction_id: seenReactionId ?? undefined,
        trigger_reason: reason,
        github_delivery_id: githubDeliveryId,
        head_sha: headSha,
        base_sha: baseSha,
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
    return true;
  } finally {
    // The execution acquires the lock again as its authoritative guard, so we
    // can release immediately after enqueueing.
    await releaseReviewLock(fullRepo, prNumber, env).catch(() => {});
  }
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
        owner, repo, review.trigger_comment_reaction_id, token
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
  env: Env,
  attempts = 1
): Promise<void> {
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(payload.installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);
  await executeReviewJobInternal(payload, env, token, attempts);
}

async function executeReviewJobInternal(
  payload: ReviewJobPayload,
  env: Env,
  token: string,
  attempts = 1
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
  let lockHeld = false;

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
    if (dbReview.status === 'FAILED') {
      console.log(`[review] Review ${reviewId} already FAILED — skipping redelivery`);
      return;
    }
    // attempt number = the queue delivery count (1 = first delivery, 2+ =
    // redelivery). Using it as the stage attempt gives each delivery its own
    // attempt_number in review_step_events, which the unique index
    // (review_id, stage, attempt_number WHERE ended_at IS NULL) requires when
    // a previous crashed delivery left an open event row.
    stageAttempt = attempts > 1 ? attempts : (dbReview.stage_attempt || 1);

    // Execution-time lock: the authoritative guard for one active execution per
    // PR. triggerReview only held the lock around enqueueing; here we acquire it
    // so a redelivered/racing job SKIPS when another execution is provably alive
    // (fresh heartbeat) instead of running the pipeline twice.
    const lockAcquired = await acquireReviewLock(fullRepo, prNumber, env);
    if (!lockAcquired) {
      if (attempts > 1) {
        // Redelivery: Queues only delivers a message to one consumer at a time,
        // so a redelivery means the previous execution has ended (retry/timeout).
        // Its heartbeat may still look fresh (it wrote one right before dying in
        // a subrequest-limit crash), so trust the delivery count, not the
        // heartbeat, and steal the lock to resume instead of silently dropping.
        await refreshReviewLock(fullRepo, prNumber, env);
        console.warn(`[review] Redelivery #${attempts} — stole lock for ${fullRepo}#${prNumber}`);
      } else {
        const heartbeatAge = dbReview.worker_heartbeat_at
          ? Date.now() - new Date(dbReview.worker_heartbeat_at).getTime()
          : Number.POSITIVE_INFINITY;
        if (heartbeatAge < REVIEW_LOCK_TTL_SECONDS * 1000) {
          console.log(`[review] Skipping ${reviewId} — lock held, heartbeat ${Math.round(heartbeatAge / 1000)}s fresh`);
          return;
        }
        // Lock survived its TTL with no fresh heartbeat → previous execution is
        // dead. Steal the lock so this run proceeds.
        await refreshReviewLock(fullRepo, prNumber, env);
        console.warn(`[review] Stole stale lock for ${fullRepo}#${prNumber}`);
      }
    }
    lockHeld = true;

    // Diff SHA pin (immutable target): capture at review-start in triggerReview,
    // fall back to fetching here. Keeps the reviewed diff stable across retries
    // even if the branch moves.
    let headSha: string | null = dbReview.head_sha ?? null;
    let baseSha: string | null = dbReview.base_sha ?? null;
    if (!headSha || !baseSha) {
      try {
        const details = await getPRDetails(owner, repo, prNumber, token);
        headSha = details.head?.sha ?? headSha;
        baseSha = details.base?.sha ?? baseSha;
        if (headSha) {
          await updateReviewShaPin(reviewId, headSha, baseSha, env);
        }
      } catch (err) {
        console.warn(`[review] Failed to capture SHA pin fallback for ${fullRepo}#${prNumber}:`, err);
      }
    }

    let state = await loadReviewState(fullRepo, prNumber, redisGet);

    currentStage = 'FETCHING_DIFF';
    await startStage(reviewId, 'FETCHING_DIFF', stageAttempt, env);
    const diff = await withTimeout('FETCHING_DIFF', STAGE_TIMEOUTS_MS.FETCHING_DIFF, async () => {
      // Compare pinned base…head when available; otherwise fall back to the PR
      // diff (unpinned, but still correct for a fresh single-shot review).
      return headSha && baseSha
        ? fetchDiffPinned(owner, repo, baseSha, headSha, token)
        : fetchDiff(owner, repo, prNumber, token);
    });
    const fileChunks = parseDiffByFile(diff);
    const currentDiffHash = await sha256(diff);
    await completeStage(reviewId, 'FETCHING_DIFF', stageAttempt, env);

    if (state && state.diffHash !== currentDiffHash) {
      console.warn(`[review] Diff hash mismatch on resume — starting fresh`);
      state = null;
    }

    if (!state) {
      const allFiles = Array.from(fileChunks.keys()).filter((f) => !isIgnoredLockfile(f));
      state = {
        reviewId,
        allFiles,
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

    // Budget guard: counts the subrequests we control (DB, Redis, GitHub,
    // Gemini, Groq). Free plan caps an invocation at 50 total; this stops us
    // well under that and lets the queue redelivery resume from per-file state
    // instead of dying with "Too many subrequests".
    const budget = new SubrequestBudget(SUBREQUEST_BUDGET_LIMIT);
    // Startup overhead (token, lock, getReview, fetchDiff, rules, stages) that
    // happens before the loop — conservative estimate so the loop doesn't
    // exceed the real cap even if our counting misses an edge.
    budget.spend(STARTUP_SUBREQUESTS_ESTIMATE);

    // Provider stack: Gemini primary, Groq fallback (configurable). The budget
    // is attached so every REAL key attempt (incl. rotation retries + fallback)
    // counts against the guard — the key to not undercounting during storms.
    const { llm } = createLLMClients(env, budget);
    const allFindings = [...state.accumulatedFindings];
    const filesToProcess = [...remainingFiles];

    const captureReasoning = env.REASONING_CAPTURE_ENABLED === 'true';
    const retentionDays = parseRetentionDays(env.REASONING_RETENTION_DAYS);
    const reasoningBuffer: ReasoningEntry[] = [];
    let filesProcessedInThisAttempt = 0;

    currentStage = 'REVIEWING_FILES';
    await startStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
      batchIndex: state.batchIndex,
      fileNames: filesToProcess.slice(0, MAX_FILES_PER_BATCH),
    });
    const filesTimeout = getReviewingFilesTimeout(filesToProcess.length);

    const stageStartedAt = Date.now();

    await withTimeout('REVIEWING_FILES', filesTimeout, async (signal) => {
      while (filesToProcess.length > 0) {
        if (signal.aborted) break;

        // Fail fast if no file completed within the stall budget (e.g. every
        // Gemini key rate-limited for minutes): end the attempt so a fresh
        // delivery resumes instead of idling until the stage times out.
        if (filesProcessedInThisAttempt === 0 && Date.now() - stageStartedAt > NO_PROGRESS_STALL_MS) {
          const err = new Error(`No file completed within ${Math.round(NO_PROGRESS_STALL_MS / 60000)}m — every Gemini key rate-limited?`);
          err.name = 'StageTimeoutError';
          throw err;
        }

        const batch = filesToProcess.splice(0, MAX_FILES_PER_BATCH);

        // Keep lease alive and extend the execution lock.
        budget.spend(2); // heartbeat + refreshReviewLock
        await heartbeat(reviewId, env);
        await refreshReviewLock(fullRepo, prNumber, env);

        lastReasonCode = 'PROCESSING';
        lastReasonDetail = `Reviewing batch ${state!.batchIndex} (${state!.completedFiles.length}/${state!.allFiles.length} files done)`;
        budget.spend(1); // updateReason
        await updateReason(reviewId, 'PROCESSING', lastReasonDetail, env);

        // Small bounded concurrency (default 2) to make progress under modest
        // key pools without bursting all generations at once. A full burst used
        // to trip the per-minute ceiling and discard the whole batch on a 429 —
        // which looped in backoff until the stage timed out with 0 files done.
        const concurrency = Math.min(DEFAULT_FILE_CONCURRENCY, batch.length);
        let cursor = 0;
        let exhaustedAllKeys = false;
        const exhaustedIndices: number[] = [];

        const reviewWorker = async () => {
          while (!exhaustedAllKeys && !signal.aborted) {
            const i = cursor++;
            if (i >= batch.length) return;
            const fileName = batch[i];
            try {
              const findings = await reviewSingleFile(
                llm, fileName, fileChunks, activeRules, env, signal,
                reviewId, state!.completedFiles.length + 1, state!.allFiles.length,
                captureReasoning, retentionDays, reasoningBuffer, budget
              );
              allFindings.push(...findings);
              state!.completedFiles.push(fileName);
              filesProcessedInThisAttempt++;
              lastReasonCode = 'PROCESSING';
              lastReasonDetail = `file ${state!.completedFiles.length}/${state!.allFiles.length}: ${fileName}`;
              // Per-file state save: progress survives a crash/budget checkpoint,
              // so a redelivery resumes from the exact file rather than 1/N.
              budget.spend(1); // saveReviewState
              state!.accumulatedFindings = allFindings;
              await saveReviewState(fullRepo, prNumber, state!, redisSet);
            } catch (err) {
              if (err instanceof DailyQuotaExhaustedError) {
                // Daily quota won't recover in 60s — backoff-thrashing is
                // pointless. Park the review (FAILED) so the queue stops
                // redelivering; the user re-triggers later. Throw so it
                // surfaces to the pipeline catch below.
                throw err;
              }
              if (err instanceof AllKeysExhaustedError) {
                // This file + the rest of the batch go back for the retry pass.
                exhaustedAllKeys = true;
                exhaustedIndices.push(i);
                return;
              }
              if (err instanceof SubrequestBudgetExceededError) {
                // Budget checkpoint — don't mark the file done; abort the batch
                // so the queue redelivers and resumes from the last per-file
                // save. The budget is shared, so every concurrent worker will
                // trip it too; only one needs to propagate.
                throw err;
              }
              // Non-rate-limit failure: keep existing resume semantics (mark
              // done, no findings); reviewSingleFile already persisted the error.
              console.error(`[review] Error reviewing ${fileName}:`, err);
              state!.completedFiles.push(fileName);
              filesProcessedInThisAttempt++;
              lastReasonCode = 'RETRYING_AFTER_FAILURE';
              lastReasonDetail = `file ${fileName} failed: ${err instanceof Error ? sanitizeErrorText(err.message) : String(err)}`;
              budget.spend(1); // saveReviewState
              state!.accumulatedFindings = allFindings;
              await saveReviewState(fullRepo, prNumber, state!, redisSet);
            }
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => reviewWorker()));

        if (exhaustedAllKeys) {
          // Return files that were never claimed (cursor → end) plus the file
          // that exhausted the keys, so the backoff pass retries them.
          const returnIndices = [...exhaustedIndices];
          for (let k = cursor; k < batch.length; k++) returnIndices.push(k);
          returnIndices.sort((a, b) => a - b);
          filesToProcess.unshift(...returnIndices.map(k => batch[k]));
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
    
    // Guard the finalize step: it needs ~15 subrequests (SCORING, REACTING,
    // POSTING_COMMENT, reactions). If this delivery already burned most of the
    // budget, checkpoint instead of tripping Cloudflare's hard cap mid-post.
    if (!budget.hasRoomFor(FINALIZE_BUDGET_RESERVE)) {
      // Best-effort flush so a checkpointed delivery keeps its reasoning rows
      // (idempotent per-file upsert). State (findings) is already saved.
      try {
        if (reasoningBuffer.length > 0) {
          await saveReviewReasonings(reviewId, reasoningBuffer, env);
          reasoningBuffer.length = 0;
        }
      } catch (e) {
        console.warn('[review] Failed to flush reasoning before checkpoint:', e);
      }
      await completeStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
        checkpoint: true,
        filesProcessed: filesProcessedInThisAttempt,
        completedCount: state.completedFiles.length,
        totalCount: state.allFiles.length,
      });
      throw new SubrequestBudgetExceededError(SUBREQUEST_BUDGET_LIMIT);
    }

    // Persist captured model reasoning as a single batched INSERT — idempotent
    // per (review_id, file), so a redelivery re-flushing is harmless.
    try {
      if (reasoningBuffer.length > 0) {
        await saveReviewReasonings(reviewId, reasoningBuffer, env);
        reasoningBuffer.length = 0;
      }
    } catch (e) {
      console.warn('[review] Failed to flush reasoning:', e);
    }

    await completeStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
      batchIndex: state.batchIndex,
      filesProcessed: filesProcessedInThisAttempt,
      completedCount: state.completedFiles.length,
      totalCount: state.allFiles.length,
    });

    await finalizeReview(reviewId, allFindings, owner, repo, prNumber, token, env, stageAttempt);

  } catch (err) {
    if (err instanceof SubrequestBudgetExceededError) {
      // Budget checkpoint: the stage event stays open on purpose — the next
      // delivery reuses it (attempt number bumps, unique index scopes to
      // ended_at IS NULL) and resumes from the per-file Redis state. Not a
      // failure, so don't failStage.
      console.warn(`[review] ${err.message} — checkpointing ${fullRepo}#${prNumber} for redelivery`);
      throw err;
    }
    if (err instanceof DailyQuotaExhaustedError) {
      // Every provider key has hit its DAILY quota — it won't recover in the
      // queue's retry window, so a redelivery would just fail again. Instead
      // of a terminal FAILED (which needs a manual re-trigger), park as
      // PAUSED_DAILY_QUOTA and let the 1-minute cron auto-resume it after the
      // resume window. The queue message acks (we return, not throw).
      const failureMessage = err.message;
      const resumeAt = new Date(Date.now() + DAILY_QUOTA_PAUSE_AFTER_MS).toISOString();
      await dbMarkDailyQuotaPaused(reviewId, currentStage, stageAttempt, failureMessage, resumeAt, env);
      console.warn(
        `[review] ${fullRepo}#${prNumber} daily-quota parked (resume ~${new Date(resumeAt).toISOString()}) — ${failureMessage}`
      );
      return;
    }
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
    if (lockHeld) {
      await releaseReviewLock(fullRepo, prNumber, env).catch(err =>
        console.warn('[review] Failed to release lock:', err)
      );
    }

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
