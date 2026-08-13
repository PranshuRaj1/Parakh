/**
 * Review Job — Core Review Pipeline
 *
 * Orchestrates the review process with batched chunking, resumability, and
 * concurrency-safe API key rotation.
 */

import type {
  ReviewJobPayload,
  Finding,
  Rule,
  StageReasonCode,
  ReviewStage,
  Review,
  ReviewMode,
  ReviewTriggerResult,
  IncrementalReviewResult,
} from '@parakh/shared';
import {
  computeScore,
  displayScore,
  resolveSeverityForRuleViolation,
  POSITIVE_THRESHOLD,
  NEGATIVE_THRESHOLD,
  REACTIONS,
  MAX_FILES_PER_BATCH,
  REVIEW_STATE_TTL_SECONDS,
  REVIEW_LOCK_TTL_SECONDS,
} from '@parakh/shared';
import { getCachedToken } from '../github/auth.js';
import {
  fetchDiff,
  fetchDiffPinned,
  getCompareStatus,
  getPRDetails,
  postComment,
  postCommentOnce,
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
  getActiveReviewByPR,
  getLatestCompletedReviewBefore,
  insertReview,
  getReview,
  setTriggerCommentContext,
  updateTriggerCommentReactionId,
  updateReviewShaPin,
  updateReviewCompatibilityMetadata,
  updateReviewIncrementalPlan,
  updateReviewEffectiveMode,
  dbMarkDailyQuotaPaused,
  recordReviewFileEvent,
  recordIncrementalShadowRun,
  saveReviewReconciliation,
  markReviewIncomplete,
} from '../db/reviews.js';
import { getActiveRules, incrementEvidenceCount } from '../db/rules.js';
import { saveReviewReasonings } from '../db/reviews.js';
import { type ReviewResult } from '../gemini/client.js';
import { AllKeysExhaustedError, DailyQuotaExhaustedError, DAILY_QUOTA_PAUSE_AFTER_MS } from '../gemini/keyPool.js';
import type { LLMClient } from '../llm/provider.js';
import { AllProvidersFailedError, ProviderResponseError } from '../llm/errors.js';
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
  getReviewingFilesTimeout,
  getStageDeadline,
  shouldCheckpointDelivery,
} from './stage-tracker.js';
import type { Env } from '../index.js';
import { createRedisGet, createRedisSet, createRedisSetNX, createRedisDel } from '../redis.js';
import { ReviewRetryScheduledError, getReviewRetryDelaySeconds } from './review-retry.js';
import { hashResumeValidationDiff, type ResumeValidationHash } from '../review/resume-validation-hash.js';
import { hashActiveRules, REVIEW_PIPELINE_VERSION } from '../review/compatibility.js';
import { OUTBOUND_REQUEST_TIMEOUT_MS } from '../request-timeout.js';
import { getFeatureFlags } from '../config/feature-flags.js';
import { planIncrementalReview } from '../review/incremental/planner.js';
import { buildShadowObservation } from '../review/incremental/shadow.js';
import { parseDiffChanges, prepareIncrementalLedger } from '../review/incremental/changes.js';
import {
  emptyReconciliationSummary,
  ensureLedgerFindings,
  mergeReconciliationSummaries,
  reconcileFileFindings,
  retainPriorFindings,
  type FindingReconciliationOutcome,
  type LedgerFinding,
  type ReconciliationSummary,
} from '../review/incremental/ledger.js';
import {
  emitReviewBaseline,
  ReviewBaselineCollector,
  type ReviewBaselineOutcome,
} from '../review/baseline/metrics.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_REASONING_RETENTION_DAYS = 14;

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

// ─── Finding Suppression ──────────────────────────────────────────────────────

/**
 * Junk patterns Parakh never raises, regardless of LLM behavior. The EOF-newline
 * check is the canonical one the project explicitly considers useless.
 */
const BUILTIN_SUPPRESSED_PATTERNS: RegExp[] = [
  /newline at (the )?end of (the )?file/i,
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build deterministic suppression patterns from instruction rules. An instruction
 * like `stop flagging "No newline at the end of the file"` contributes the quoted
 * phrase as a literal case-insensitive match, so findings whose body repeats it
 * are dropped even if the LLM ignores the prompt-level suppression.
 */
export function extractSuppressionPatterns(instructions: Rule[]): RegExp[] {
  const patterns: RegExp[] = [...BUILTIN_SUPPRESSED_PATTERNS];
  for (const rule of instructions) {
    for (const match of rule.body?.matchAll(/"([^"]+)"/g) ?? []) {
      const phrase = match[1].trim();
      if (phrase.length < 4) continue;
      patterns.push(new RegExp(escapeRegExp(phrase), 'i'));
    }
  }
  return patterns;
}

/** Drop findings the developer asked never to raise (deterministic, LLM-independent). */
export function suppressFindings(findings: Finding[], instructions: Rule[]): Finding[] {
  const patterns = extractSuppressionPatterns(instructions);
  if (patterns.length === 0) return findings;
  return findings.filter((f) => !patterns.some((re) => re.test(f.body)));
}

export interface ResolvedReviewResult {
  rawFindingCount: number;
  findings: Finding[];
  /** Stored rules whose evidence counters should be incremented. */
  matchedRuleIds: string[];
}

/**
 * Convert structured model output into Parakh's final finding shape.
 * Keeping this transformation pure makes the offline replay exercise the same
 * severity and suppression behavior as production without mocking it.
 */
export function resolveReviewResult(
  result: ReviewResult,
  fileName: string,
  applicableRules: Rule[],
  suppressPatterns: RegExp[]
): ResolvedReviewResult {
  const findings: Finding[] = result.genericFindings.map((finding) => ({
    severity: finding.severity,
    file: finding.file || fileName,
    line: finding.line,
    body: finding.body,
    suggestion: finding.suggestion || null,
    rule_id: null,
  }));
  const matchedRuleIds: string[] = [];

  for (const finding of result.ruleFindings) {
    const rule = applicableRules.find((candidate) => candidate.id === finding.rule_id);
    if (rule?.kind === 'instruction') continue;

    findings.push({
      severity: resolveSeverityForRuleViolation(rule?.priority || 'normal'),
      file: finding.file || fileName,
      line: finding.line,
      body: finding.body,
      suggestion: finding.suggestion || null,
      rule_id: finding.rule_id,
    });
    if (rule) matchedRuleIds.push(rule.id);
  }

  return {
    rawFindingCount: result.genericFindings.length + result.ruleFindings.length,
    findings: findings.filter((finding) => !suppressPatterns.some((pattern) => pattern.test(finding.body))),
    matchedRuleIds,
  };
}

export function parseDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const fileDiffs = diff.split(/^diff --git /m).slice(1);
  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');
    const metadataPath = lines.find((line) => line.startsWith('rename to '))?.slice('rename to '.length)
      ?? lines.find((line) => line.startsWith('copy to '))?.slice('copy to '.length)
      ?? lines.find((line) => line.startsWith('+++ b/'))?.slice('+++ b/'.length);
    const path = metadataPath ? decodeGitPath(metadataPath) : parseDiffHeaderPath(lines[0] ?? '');
    if (!path) throw new Error(`Unable to parse diff path from header: ${lines[0] ?? '<empty>'}`);
    files.set(path, fileDiff);
  }
  return files;
}

function decodeGitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    throw new Error(`Unable to decode quoted Git path: ${trimmed}`);
  }
}

function parseDiffHeaderPath(header: string): string | null {
  const quoted = header.match(/^"a\/(?:[^"\\]|\\.)*" "b\/(?:[^"\\]|\\.)*"$/);
  if (quoted) {
    const tokens = quoted[0].match(/"(?:[^"\\]|\\.)*"/g);
    if (tokens?.length === 2) return (JSON.parse(tokens[1]) as string).slice(2);
  }
  if (!header.startsWith('a/')) return null;
  const candidates: Array<{ oldPath: string; newPath: string }> = [];
  let offset = header.indexOf(' b/', 2);
  while (offset >= 0) {
    candidates.push({ oldPath: header.slice(2, offset), newPath: header.slice(offset + 3) });
    offset = header.indexOf(' b/', offset + 1);
  }
  const equal = candidates.find((candidate) => candidate.oldPath === candidate.newPath);
  return equal?.newPath ?? candidates.at(-1)?.newPath ?? null;
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

export interface ReviewCommentContext {
  mode: ReviewMode;
  rangeStartSha: string | null;
  rangeEndSha: string;
  newFindingCount: number;
  existingUnresolvedCount: number;
  resolvedCount: number;
  fallbackReason: string | null;
  noChangesSinceParent: boolean;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function selectDisplayedReviewScore(
  rawScore: number,
  noChangesSinceParent: boolean,
  previousScore: number | null
): number {
  return noChangesSinceParent && previousScore !== null
    ? previousScore
    : displayScore(rawScore);
}

export function formatReviewComment(
  score: number,
  displayedScore: number,
  findings: Finding[],
  repo: string,
  prNumber: number,
  dashboardBaseUrl?: string,
  context?: ReviewCommentContext
): string {
  const severityEmoji: Record<string, string> = {
    CRITICAL: '🔴',
    HIGH: '🟠',
    MEDIUM: '🟡',
    LOW: '🔵',
  };

  const reviewLabel = context
    ? context.mode === 'incremental' ? 'Incremental Review' : 'Full Review'
    : 'Code Review';
  let comment = `## Parakh ${reviewLabel} — ${displayedScore}/5\n\n`;

  if (context) {
    const start = context.rangeStartSha ? shortSha(context.rangeStartSha) : 'PR base';
    comment += `**Reviewed range:** \`${start}\` → \`${shortSha(context.rangeEndSha)}\`\n`;
    comment += `**Snapshot:** ${context.newFindingCount} new · ${context.existingUnresolvedCount} existing unresolved · ${context.resolvedCount} resolved\n`;
    comment += `**Complete PR score:** ${displayedScore}/5\n`;
    if (context.fallbackReason) {
      comment += `**Fallback:** ${context.fallbackReason.replace(/_/g, ' ')}\n`;
    }
    comment += '\n';
    if (context.noChangesSinceParent) {
      comment += `✅ No commits were added after \`${start}\`. No model calls were made, and the previous score was retained.\n\n`;
    }
  }

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

const REVIEW_STATE_KEY = (repo: string, pr: number, reviewId: string) =>
  `pr_review_state:${repo}:${pr}:${reviewId}`;
const REVIEW_LOCK_KEY  = (repo: string, pr: number) => `pr_review_lock:${repo}:${pr}`;
const REVIEW_ENQUEUE_LOCK_KEY = (repo: string, pr: number) => `pr_review_enqueue_lock:${repo}:${pr}`;

class ReviewExecutionActiveError extends Error {}

interface ReviewState {
  reviewId: string;
  requestedMode: ReviewMode;
  effectiveMode: ReviewMode;
  allFiles: string[];
  completedFiles: string[];
  accumulatedFindings: Finding[];
  batchIndex: number;
  diffHash: ResumeValidationHash;
  attemptCounter: number;
  reconciliationOutcomes: FindingReconciliationOutcome[];
  reconciliationSummary: ReconciliationSummary;
  fileFailures: Record<string, { attempts: number; lastError: string }>;
  terminalFailedFiles: string[];
}

async function loadReviewState(repo: string, prNumber: number, reviewId: string, redisGet: (key: string) => Promise<string | null>): Promise<ReviewState | null> {
  const raw = await redisGet(REVIEW_STATE_KEY(repo, prNumber, reviewId));
  return raw ? JSON.parse(raw) as ReviewState : null;
}

async function saveReviewState(repo: string, prNumber: number, state: ReviewState, redisSet: (key: string, value: string, opts?: { ex?: number }) => Promise<unknown>): Promise<void> {
  await redisSet(REVIEW_STATE_KEY(repo, prNumber, state.reviewId), JSON.stringify(state), { ex: REVIEW_STATE_TTL_SECONDS });
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

interface ReviewedFileResult {
  findings: Finding[];
  outcomes: FindingReconciliationOutcome[];
  summary: ReconciliationSummary;
  telemetry?: {
    findingsCount: number;
    matchedRuleIds: string[];
    provider: string | null;
    model: string;
  };
}

async function reviewSingleFile(
  llm: LLMClient,
  fileName: string,
  fileChunks: Map<string, string>,
  activeRules: Rule[],
  suppressPatterns: RegExp[],
  env: Env,
  signal: AbortSignal,
  reviewId: string,
  fileIndex: number,
  totalFiles: number,
  captureReasoning: boolean,
  retentionDays: number,
  reasoningBuffer: ReasoningEntry[],
  budget: SubrequestBudget,
  metrics: ReviewBaselineCollector,
  priorFindings: LedgerFinding[] | null,
  headSha: string
): Promise<ReviewedFileResult> {
  const fileDiff = fileChunks.get(fileName);
  if (!fileDiff) return { findings: [], outcomes: [], summary: emptyReconciliationSummary() };

  const applicableRules = activeRules.filter(r =>
    matchesScope(fileName, r.scope as Record<string, unknown>)
  );

  // Live per-file progress: "file 3/8: src/foo.ts" on the reviews row.
  // Uses the light update so we don't append a reason_transitions per file.
  // Throttled to every DETAIL_UPDATE_EVERY files + the last file so a large PR
  // doesn't burn one DB subrequest per file (13 files → ~3 writes).
  if (fileIndex % DETAIL_UPDATE_EVERY === 0 || fileIndex === totalFiles) {
    try {
      budget.spend(1);
      await updateReasonDetail(reviewId, 'PROCESSING', `file ${fileIndex}/${totalFiles}: ${fileName}`, env);
    } catch (telemetryErr) {
      console.warn(`[review] Failed to update progress for ${fileName}:`, telemetryErr);
    }
  }

  let result: ReviewResult | IncrementalReviewResult;
  try {
    // The real Gemini/Groq calls happen inside the provider's key rotation,
    // which spends from the budget per actual attempt — so no spend here.
    metrics.recordReviewCall();
    result = priorFindings === null
      ? await llm.reviewDiff(fileName, fileDiff, applicableRules, signal)
      : await llm.reviewIncrementalDiff(fileName, fileDiff, applicableRules, priorFindings, signal);
  } catch (err) {
    if (err instanceof AllKeysExhaustedError || err instanceof AllProvidersFailedError) throw err;
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
    throw err;
  }

  if (captureReasoning && result.thinking) {
    reasoningBuffer.push({
      file: fileName,
      model: llm.modelName,
      thinking: result.thinking,
      retentionDays,
    });
  }

  const resolved = resolveReviewResult(result, fileName, applicableRules, suppressPatterns);
  metrics.recordFindings(resolved.rawFindingCount, resolved.findings.length);
  const telemetry = {
    findingsCount: result.genericFindings.length + result.ruleFindings.length,
    matchedRuleIds: resolved.matchedRuleIds,
    provider: llm.servedProvider,
    model: llm.modelName,
  };

  if (priorFindings !== null) {
    const incremental = result as IncrementalReviewResult;
    const reconciled = await reconcileFileFindings(
      priorFindings,
      resolved.findings,
      incremental.priorFindingResolutions,
      headSha
    );
    return { ...reconciled, telemetry };
  }

  return {
    findings: resolved.findings,
    outcomes: [],
    summary: emptyReconciliationSummary(),
    telemetry,
  };
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

export interface TriggerReviewInput {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  reason: 'opened' | 'synchronize' | 'manual_mention' | 'auto_retry';
  requestedMode: ReviewMode;
  resumeReviewId?: string;
  githubDeliveryId?: string;
  commentId?: number;
  commentType?: 'issue_comment' | 'pull_request_review_comment';
}

function isStaleActiveReview(review: Review): boolean {
  if (review.status !== 'RUNNING') return false;
  if (!review.worker_heartbeat_at) return true;
  return Date.now() - new Date(review.worker_heartbeat_at).getTime()
    >= REVIEW_LOCK_TTL_SECONDS * 1000;
}

export async function triggerReview(
  input: TriggerReviewInput,
  env: Env
): Promise<ReviewTriggerResult> {
  const {
    installationId,
    owner,
    repo,
    prNumber,
    reason,
    requestedMode,
    resumeReviewId,
    githubDeliveryId,
    commentId,
    commentType,
  } = input;
  const fullRepo = `${owner}/${repo}`;
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);
  const details = await getPRDetails(owner, repo, prNumber, token);
  const headSha = details.head.sha;
  const baseSha = details.base.sha;
  const enqueueLockKey = REVIEW_ENQUEUE_LOCK_KEY(fullRepo, prNumber);
  const enqueueIdentity = JSON.stringify({ headSha, requestedMode });

  // Enqueue serialization is separate from the long-running execution lock.
  // Its value identifies an identical racing request so the caller can return
  // ALREADY_ACTIVE instead of an inaccurate generic BUSY response.
  const setNX = createRedisSetNX(env);
  const locked = await setNX(enqueueLockKey, enqueueIdentity, 30);
  if (!locked) {
    const activeIdentity = await redis.get(enqueueLockKey);
    return activeIdentity === enqueueIdentity ? 'ALREADY_ACTIVE' : 'BUSY';
  }

  let reviewId: string;
  let triggerResult: ReviewTriggerResult = 'ENQUEUED';
  try {
    if (resumeReviewId) {
      const resumable = await getReview(resumeReviewId, env);
      if (!resumable) throw new Error(`Cannot resume missing review ${resumeReviewId}`);
      const resumableMode = resumable.requested_review_mode ?? 'full';
      if (resumable.head_sha !== headSha || resumableMode !== requestedMode) return 'BUSY';

      reviewId = resumeReviewId;
      triggerResult = 'RESUMED';
      await updateReviewStatus(reviewId, 'QUEUED', env, githubDeliveryId);
    } else {
      // The lock serializes this recheck with insertion. Two near-simultaneous
      // comments can otherwise both observe no active review before enqueueing.
      const active = await getActiveReviewByPR(fullRepo, prNumber, env);
      if (active) {
        const activeMode = active.requested_review_mode ?? 'full';
        const sameRequest = active.head_sha === headSha && activeMode === requestedMode;
        if (!sameRequest) return 'BUSY';
        if (!isStaleActiveReview(active)) return 'ALREADY_ACTIVE';

        reviewId = active.id;
        triggerResult = 'RESUMED';
        await updateReviewStatus(reviewId, 'QUEUED', env, githubDeliveryId);
      } else {
        reviewId = '';
      }
    }

    // Clean up previous verdict reaction ONLY on genuinely fresh triggers.
    if (triggerResult === 'ENQUEUED') {
      const previousReview = await getLatestReviewByPR(fullRepo, prNumber, env);
      if (previousReview?.verdict_reaction_id) {
        try {
          await removeReaction(owner, repo, prNumber, previousReview.verdict_reaction_id, token);
        } catch (err) {
          console.warn(`[review] Failed to remove previous verdict reaction:`, err);
        }
      }
    }

    if (triggerResult === 'ENQUEUED') {
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
        requested_review_mode: requestedMode,
        effective_review_mode: 'full',
        fallback_reason: requestedMode === 'incremental' ? 'incremental_disabled' : null,
        pipeline_version: REVIEW_PIPELINE_VERSION,
      }, env);
      reviewId = review.id;
    }

    if (commentId !== undefined && commentType !== undefined) {
      let commentReactionId: number | null = null;
      try {
        commentReactionId = await addCommentReaction(owner, repo, commentId, commentType, REACTIONS.SEEN, token);
      } catch (err) {
        console.warn('[review] Failed to add seen reaction to trigger comment:', err);
      }
      await setTriggerCommentContext(reviewId, commentId, commentType, commentReactionId, env);
    }

    const payload: ReviewJobPayload = {
      type: 'REVIEW',
      installationId,
      owner,
      repo,
      prNumber,
      reviewId,
      requestedMode,
      effectiveMode: 'full',
    };

    // We push this to the Queue so it runs asynchronously with proper timeouts!
    await env.WATCHDOG_QUEUE.send(payload);
    return triggerResult;
  } finally {
    const del = createRedisDel(env);
    await del(enqueueLockKey).catch(() => {});
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
  const deliveryStartedAt = Date.now();
  const { reviewId, owner, repo, prNumber } = payload;
  const fullRepo = `${owner}/${repo}`;
  const redisGet = createRedisGet(env);
  const redisSet = createRedisSet(env);
  const featureFlags = getFeatureFlags(env);
  const metrics = new ReviewBaselineCollector(reviewId, attempts, featureFlags);

  // Tracked in function scope so the catch can attribute failures accurately.
  let currentStage: ReviewStage = 'FETCHING_DIFF';
  let stageAttempt = 1;
  let lastReasonCode: StageReasonCode | null = null;
  let lastReasonDetail: string | null = null;
  let lockHeld = false;
  let budget: SubrequestBudget | null = null;
  let metricsOutcome: ReviewBaselineOutcome = 'skipped';
  let checkpointReason: string | null = null;

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
    metrics.recordAttempt(stageAttempt);

    // Execution-time lock: the authoritative guard for one active execution per
    // PR. triggerReview only held the lock around enqueueing; here we acquire it
    // so a redelivered/racing job SKIPS when another execution is provably alive
    // (fresh heartbeat) instead of running the pipeline twice.
    const lockAcquired = await acquireReviewLock(fullRepo, prNumber, env);
    if (!lockAcquired) {
      const heartbeatAge = dbReview.worker_heartbeat_at
        ? Date.now() - new Date(dbReview.worker_heartbeat_at).getTime()
        : Number.POSITIVE_INFINITY;
      if (heartbeatAge < REVIEW_LOCK_TTL_SECONDS * 1000) {
        throw new ReviewExecutionActiveError(`review execution is still active for ${fullRepo}#${prNumber}`);
      }
      await refreshReviewLock(fullRepo, prNumber, env);
      console.warn(`[review] Stole stale lock for ${fullRepo}#${prNumber}`);
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

    let state = await loadReviewState(fullRepo, prNumber, reviewId, redisGet);

    currentStage = 'FETCHING_DIFF';
    await startStage(reviewId, 'FETCHING_DIFF', stageAttempt, env);
    const fullDiff = await withTimeout('FETCHING_DIFF', STAGE_TIMEOUTS_MS.FETCHING_DIFF, async () => {
      // Compare pinned base…head when available; otherwise fall back to the PR
      // diff (unpinned, but still correct for a fresh single-shot review).
      return headSha && baseSha
        ? fetchDiffPinned(owner, repo, baseSha, headSha, token)
        : fetchDiff(owner, repo, prNumber, token);
    });
    const fullFileChunks = parseDiffByFile(fullDiff);
    const fullDiffHash = await hashResumeValidationDiff(fullDiff);
    const fullReviewableFileCount = Array.from(fullFileChunks.keys()).filter(
      (file) => !isIgnoredLockfile(file)
    ).length;
    metrics.captureInput(fullDiff, fullDiffHash, fullFileChunks.size, fullReviewableFileCount);
    await completeStage(reviewId, 'FETCHING_DIFF', stageAttempt, env, metrics.stageDetail());

    currentStage = 'LOADING_RULES';
    await startStage(reviewId, 'LOADING_RULES', stageAttempt, env);
    const activeRules = await withTimeout('LOADING_RULES', STAGE_TIMEOUTS_MS.LOADING_RULES, async () => {
       return getActiveRules(fullRepo, env);
    });

    const activeRulesHash = await hashActiveRules(activeRules);
    await updateReviewCompatibilityMetadata(
      reviewId,
      activeRulesHash,
      REVIEW_PIPELINE_VERSION,
      env
    );
    await completeStage(reviewId, 'LOADING_RULES', stageAttempt, env);

    let effectiveMode: ReviewMode = 'full';
    let executionDiff = fullDiff;
    let parent: Review | null = null;
    let incrementalDiff: string | null = null;
    let planningFallbackReason: string | null = payload.requestedMode === 'incremental'
      ? 'incremental_disabled'
      : null;

    const shouldPlanIncremental = payload.requestedMode === 'incremental'
      && (featureFlags.incrementalReviewShadow || featureFlags.incrementalReview)
      && headSha
      && baseSha;

    if (shouldPlanIncremental && headSha && baseSha) {
      try {
        parent = await getLatestCompletedReviewBefore(fullRepo, prNumber, reviewId, env);
        let plan = planIncrementalReview({
          parent,
          currentBaseSha: baseSha,
          activeRulesHash,
          pipelineVersion: REVIEW_PIPELINE_VERSION,
          parentIsAncestor: null,
        });

        if (plan.decision === 'fallback' && plan.reason === 'head_not_descendant' && parent?.head_sha) {
          const compareStatus = await getCompareStatus(owner, repo, parent.head_sha, headSha, token);
          plan = planIncrementalReview({
            parent,
            currentBaseSha: baseSha,
            activeRulesHash,
            pipelineVersion: REVIEW_PIPELINE_VERSION,
            parentIsAncestor: compareStatus === 'ahead' || compareStatus === 'identical',
          });
        }

        if (plan.decision === 'eligible') {
          incrementalDiff = await fetchDiffPinned(owner, repo, plan.comparisonBaseSha, headSha, token);
          await updateReviewIncrementalPlan(
            reviewId, plan.parent.id, plan.comparisonBaseSha, null, env
          );
          if (featureFlags.incrementalReview) {
            effectiveMode = 'incremental';
            executionDiff = incrementalDiff;
            planningFallbackReason = null;
          }
        } else {
          planningFallbackReason = plan.reason;
          await updateReviewIncrementalPlan(reviewId, parent?.id ?? null, null, plan.reason, env);
        }

        if (featureFlags.incrementalReviewShadow && !featureFlags.incrementalReview) {
          const shadowRun = buildShadowObservation({
            reviewId,
            parentReviewId: parent?.id ?? null,
            decision: plan.decision,
            fallbackReason: plan.decision === 'fallback' ? plan.reason : null,
            parentHeadSha: parent?.head_sha ?? null,
            currentHeadSha: headSha,
            fullDiff,
            incrementalDiff,
            executionDiffHash: fullDiffHash,
            fullDiffHash,
          });
          await recordIncrementalShadowRun(shadowRun, env);
          console.log(`[incremental-shadow] ${JSON.stringify(shadowRun)}`);
        }
      } catch (err) {
        planningFallbackReason = 'planner_failed';
        console.warn('[incremental] Planner failed; using full review:', err);
      }
    }

    await updateReviewEffectiveMode(reviewId, effectiveMode, planningFallbackReason, env);

    const fileChunks = parseDiffByFile(executionDiff);
    const executionDiffHash = await hashResumeValidationDiff(executionDiff);
    const reviewableFileCount = Array.from(fileChunks.keys()).filter(
      (file) => !isIgnoredLockfile(file)
    ).length;
    metrics.captureInput(executionDiff, executionDiffHash, fileChunks.size, reviewableFileCount);

    const changes = effectiveMode === 'incremental' ? parseDiffChanges(executionDiff) : [];
    const parentLedger = effectiveMode === 'incremental' && parent?.findings && parent.head_sha
      ? ensureLedgerFindings(parent.findings, parent.head_sha)
      : [];
    const preparedLedger = prepareIncrementalLedger(
      parentLedger,
      changes,
      headSha ?? 'unknown',
      (path) => !isIgnoredLockfile(path)
    );
    const priorFindingsByFile = preparedLedger.priorFindingsByFile;
    const finalizeOutput: FinalizeReviewOutput = {
      rangeStartSha: effectiveMode === 'incremental' ? parent?.head_sha ?? null : baseSha,
      fallbackReason: planningFallbackReason,
      noChangesSinceParent: effectiveMode === 'incremental' && executionDiff.trim().length === 0,
      previousScore: effectiveMode === 'incremental' ? parent?.score ?? null : null,
    };

    if (state && (
      state.diffHash !== executionDiffHash ||
      state.reviewId !== reviewId ||
      state.requestedMode !== payload.requestedMode ||
      state.effectiveMode !== effectiveMode
    )) {
      console.warn('[review] Resume state does not match the pinned review — starting fresh');
      state = null;
    }

    // In-flight checkpoints from pre-ledger deployments can safely resume as
    // full reviews; seed only the new bookkeeping fields they did not store.
    if (state) {
      state.reconciliationOutcomes ??= [];
      state.reconciliationSummary ??= emptyReconciliationSummary();
      state.fileFailures ??= {};
      state.terminalFailedFiles ??= [];
    }

    if (!state) {
      const deterministicallyHandled = new Set(changes
        .filter((change) => change.kind === 'deleted' || change.kind === 'renamed')
        .map((change) => change.newPath ?? change.oldPath)
        .filter((path): path is string => path !== null));
      const allFiles = Array.from(fileChunks.keys()).filter(
        (file) => !isIgnoredLockfile(file) && !deterministicallyHandled.has(file)
      );
      state = {
        reviewId,
        requestedMode: payload.requestedMode,
        effectiveMode,
        allFiles,
        completedFiles: [],
        accumulatedFindings: effectiveMode === 'incremental' ? preparedLedger.initialFindings : [],
        batchIndex: 0,
        diffHash: executionDiffHash,
        attemptCounter: stageAttempt,
        reconciliationOutcomes: effectiveMode === 'incremental' ? preparedLedger.outcomes : [],
        reconciliationSummary: effectiveMode === 'incremental'
          ? preparedLedger.summary
          : emptyReconciliationSummary(),
        fileFailures: {},
        terminalFailedFiles: [],
      };
    }

    await saveReviewState(fullRepo, prNumber, state, redisSet);
    const remainingFiles = state.allFiles.filter((file) => !state!.completedFiles.includes(file));

    if (remainingFiles.length === 0) {
      await finalizeReview(
        reviewId, state.accumulatedFindings, owner, repo, prNumber, token, env,
        stageAttempt, metrics, headSha ?? 'unknown', effectiveMode,
        state.reconciliationOutcomes, state.reconciliationSummary, finalizeOutput
      );
      metricsOutcome = 'completed';
      return;
    }

    // Compile suppression patterns once per job — instruction rules don't change
    // mid-review, so per-file recompilation would be wasted work.
    const suppressPatterns = extractSuppressionPatterns(activeRules.filter(r => r.kind === 'instruction'));

    // Budget guard: counts the subrequests we control (DB, Redis, GitHub,
    // Gemini, Groq). Free plan caps an invocation at 50 total; this stops us
    // well under that and lets the queue redelivery resume from per-file state
    // instead of dying with "Too many subrequests".
    const activeBudget = new SubrequestBudget(SUBREQUEST_BUDGET_LIMIT);
    budget = activeBudget;
    // Startup overhead (token, lock, getReview, fetchDiff, rules, stages) that
    // happens before the loop — conservative estimate so the loop doesn't
    // exceed the real cap even if our counting misses an edge.
    activeBudget.spend(STARTUP_SUBREQUESTS_ESTIMATE);

    // Provider stack: Gemini primary, Groq fallback (configurable). The budget
    // is attached so every REAL key attempt (incl. rotation retries + fallback)
    // counts against the guard — the key to not undercounting during storms.
    const { llm } = createLLMClients(env, activeBudget);
    const allFindings = [...state.accumulatedFindings];
    const filesToProcess = [...remainingFiles];

    const captureReasoning = env.REASONING_CAPTURE_ENABLED === 'true';
    const retentionDays = parseRetentionDays(env.REASONING_RETENTION_DAYS);
    const reasoningBuffer: ReasoningEntry[] = [];
    let filesProcessedInThisAttempt = 0;
    let optionalTelemetryWrites = 0;
    const canWriteOptionalTelemetry = (): boolean =>
      optionalTelemetryWrites < MAX_FILES_PER_BATCH
      && activeBudget.hasRoomFor(1)
      && !shouldCheckpointDelivery(
        deliveryStartedAt,
        Date.now(),
        OUTBOUND_REQUEST_TIMEOUT_MS
      );
    let stateCommit: Promise<void> = Promise.resolve();
    const commitReviewState = async (mutate: () => void): Promise<void> => {
      const commit = stateCommit.then(async () => {
        mutate();
        activeBudget.spend(1);
        await saveReviewState(fullRepo, prNumber, state!, redisSet);
      });
      stateCommit = commit.catch(() => undefined);
      await commit;
    };

    currentStage = 'REVIEWING_FILES';
    const deliveryFileCount = Math.min(filesToProcess.length, MAX_FILES_PER_BATCH);
    const filesTimeout = getReviewingFilesTimeout(deliveryFileCount);
    await startStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
      batchIndex: state.batchIndex,
      fileNames: filesToProcess.slice(0, deliveryFileCount),
    }, getStageDeadline(filesTimeout));

    if (shouldCheckpointDelivery(deliveryStartedAt, Date.now(), filesTimeout)) {
      await completeStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
        checkpoint: true,
        reason: 'delivery_deadline',
        completedCount: state.completedFiles.length,
        totalCount: state.allFiles.length,
      });
      await updateReviewStatus(reviewId, 'QUEUED', env);
      metricsOutcome = 'checkpoint';
      checkpointReason = 'delivery_deadline';
      throw new ReviewRetryScheduledError(1);
    }

    await withTimeout('REVIEWING_FILES', filesTimeout, async (signal) => {
      while (filesToProcess.length > 0) {
        if (signal.aborted) break;

        const batch = filesToProcess.splice(0, MAX_FILES_PER_BATCH);

        // Keep lease alive and extend the execution lock.
        activeBudget.spend(2); // heartbeat + refreshReviewLock
        await heartbeat(reviewId, env);
        await refreshReviewLock(fullRepo, prNumber, env);

        lastReasonCode = 'PROCESSING';
        lastReasonDetail = `Reviewing batch ${state!.batchIndex} (${state!.completedFiles.length}/${state!.allFiles.length} files done)`;
        activeBudget.spend(1); // updateReason
        await updateReason(reviewId, 'PROCESSING', lastReasonDetail, env);

        // Small bounded concurrency (default 2) to make progress under modest
        // key pools without bursting all generations at once. A full burst used
        // to trip the per-minute ceiling and discard the whole batch on a 429 —
        // which looped in backoff until the stage timed out with 0 files done.
        const concurrency = Math.min(DEFAULT_FILE_CONCURRENCY, batch.length);
        let cursor = 0;
        const reviewWorker = async () => {
          while (!signal.aborted) {
            const i = cursor++;
            if (i >= batch.length) return;
            const fileName = batch[i];
            try {
              const reviewed = await reviewSingleFile(
                llm, fileName, fileChunks, activeRules, suppressPatterns, env, signal,
                reviewId, state!.completedFiles.length + 1, state!.allFiles.length,
                captureReasoning, retentionDays, reasoningBuffer, activeBudget, metrics,
                effectiveMode === 'incremental' ? (priorFindingsByFile.get(fileName) ?? []) : null,
                headSha ?? 'unknown'
              );
              await commitReviewState(() => {
                allFindings.push(...reviewed.findings);
                state!.reconciliationOutcomes.push(...reviewed.outcomes);
                state!.reconciliationSummary = mergeReconciliationSummaries(
                  state!.reconciliationSummary,
                  reviewed.summary
                );
                state!.completedFiles.push(fileName);
                delete state!.fileFailures[fileName];
                filesProcessedInThisAttempt++;
                lastReasonCode = 'PROCESSING';
                lastReasonDetail = `file ${state!.completedFiles.length}/${state!.allFiles.length}: ${fileName}`;
                state!.accumulatedFindings = allFindings;
              });
              if (reviewed.telemetry) {
                for (const ruleId of reviewed.telemetry.matchedRuleIds) {
                  if (!canWriteOptionalTelemetry()) break;
                  try {
                    optionalTelemetryWrites++;
                    activeBudget.spend(1);
                    await incrementEvidenceCount(ruleId, env);
                  } catch (telemetryErr) {
                    console.warn(`[review] Failed to increment evidence for ${ruleId}:`, telemetryErr);
                  }
                }
                if (canWriteOptionalTelemetry()) {
                  try {
                    optionalTelemetryWrites++;
                    activeBudget.spend(1);
                    await recordReviewFileEvent({
                      reviewId,
                      file: fileName,
                      status: 'COMPLETED',
                      provider: reviewed.telemetry.provider,
                      model: reviewed.telemetry.model,
                      findingsCount: reviewed.telemetry.findingsCount,
                    }, env);
                  } catch (telemetryErr) {
                    console.warn(`[review] Failed to record file event for ${fileName}:`, telemetryErr);
                  }
                }
              }
            } catch (err) {
              if (err instanceof DailyQuotaExhaustedError) {
                // Daily quota won't recover in 60s — backoff-thrashing is
                // pointless. Park the review (FAILED) so the queue stops
                // redelivering; the user re-triggers later. Throw so it
                // surfaces to the pipeline catch below.
                throw err;
              }
              if (err instanceof AllKeysExhaustedError || err instanceof AllProvidersFailedError) {
                const previous = state!.fileFailures[fileName]?.attempts ?? 0;
                const attemptsForFile = previous + 1;
                const providerError = err instanceof AllProvidersFailedError ? err.lastError : err;
                const lastError = sanitizeErrorText(providerError?.message ?? err.message);
                let terminalOutcome: ReviewedFileResult | null = null;
                if (attemptsForFile >= 3) {
                  if (effectiveMode === 'incremental') {
                    const responseFailure = providerError instanceof ProviderResponseError
                      ? providerError.reason === 'missing' ? 'MODEL_RESULT_MISSING' : 'MODEL_RESULT_MALFORMED'
                      : 'PROVIDER_FAILURE';
                    const prior = priorFindingsByFile.get(fileName) ?? [];
                    if (
                      responseFailure === 'MODEL_RESULT_MISSING'
                      && providerError instanceof ProviderResponseError
                      && providerError.response
                    ) {
                      const partial = providerError.response as IncrementalReviewResult;
                      const applicableRules = activeRules.filter((rule) => matchesScope(fileName, rule.scope));
                      const resolved = resolveReviewResult(partial, fileName, applicableRules, suppressPatterns);
                      metrics.recordFindings(resolved.rawFindingCount, resolved.findings.length);
                      terminalOutcome = await reconcileFileFindings(prior, resolved.findings, null, headSha ?? 'unknown');
                    } else {
                      terminalOutcome = retainPriorFindings(prior, responseFailure);
                    }
                  }
                }
                await commitReviewState(() => {
                  state!.fileFailures[fileName] = { attempts: attemptsForFile, lastError };
                  if (attemptsForFile >= 3 && !state!.terminalFailedFiles.includes(fileName)) {
                    state!.terminalFailedFiles.push(fileName);
                  }
                  if (terminalOutcome) {
                    allFindings.push(...terminalOutcome.findings);
                    state!.reconciliationOutcomes.push(...terminalOutcome.outcomes);
                    state!.reconciliationSummary = mergeReconciliationSummaries(
                      state!.reconciliationSummary,
                      terminalOutcome.summary
                    );
                  }
                  state!.accumulatedFindings = allFindings;
                });
                continue;
              }
              if (err instanceof SubrequestBudgetExceededError) {
                // Budget checkpoint — don't mark the file done; abort the batch
                // so the queue redelivers and resumes from the last per-file
                // save. The budget is shared, so every concurrent worker will
                // trip it too; only one needs to propagate.
                throw err;
              }
              // Unexpected failures fail the stage. They must never be counted
              // as reviewed files with zero findings.
              console.error(`[review] Error reviewing ${fileName}:`, err);
              throw err;
            }
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => reviewWorker()));
        await commitReviewState(() => {
          state!.batchIndex++;
          state!.accumulatedFindings = allFindings;
        });
        break;
      }
    });

    const retryableFailures = Object.entries(state.fileFailures)
      .filter(([file, failure]) => failure.attempts < 3 && !state.terminalFailedFiles.includes(file));
    if (retryableFailures.length > 0 || filesToProcess.length > 0) {
      state.accumulatedFindings = allFindings;
      await saveReviewState(fullRepo, prNumber, state, redisSet);
      const reason = retryableFailures.length > 0 ? 'provider_retry' : 'delivery_batch';
      await completeStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
        checkpoint: true,
        reason,
        failedFiles: retryableFailures.map(([file]) => file),
        completedCount: state.completedFiles.length,
        totalCount: state.allFiles.length,
      });
      await updateReviewStatus(reviewId, 'QUEUED', env);
      const delaySeconds = retryableFailures.length > 0
        ? getReviewRetryDelaySeconds(Math.max(...retryableFailures.map(([, failure]) => failure.attempts)))
        : 1;
      metricsOutcome = 'checkpoint';
      checkpointReason = reason;
      throw new ReviewRetryScheduledError(delaySeconds);
    }

    if (state.terminalFailedFiles.length > 0) {
      await completeStage(reviewId, 'REVIEWING_FILES', stageAttempt, env, {
        incomplete: true,
        failedFiles: state.terminalFailedFiles,
        completedCount: state.completedFiles.length,
        totalCount: state.allFiles.length,
      });
      await finalizeIncompleteReview(
        reviewId, allFindings, state, owner, repo, prNumber, token, env,
        effectiveMode, headSha ?? 'unknown'
      );
      metricsOutcome = 'failed';
      return;
    }
    
    // Guard the finalize step: it needs ~15 subrequests (SCORING, REACTING,
    // POSTING_COMMENT, reactions). If this delivery already burned most of the
    // budget, checkpoint instead of tripping Cloudflare's hard cap mid-post.
    if (!activeBudget.hasRoomFor(FINALIZE_BUDGET_RESERVE)) {
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
        ...metrics.stageDetail(),
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
      ...metrics.stageDetail(),
    });

    await finalizeReview(
      reviewId, allFindings, owner, repo, prNumber, token, env, stageAttempt, metrics,
      headSha ?? 'unknown', effectiveMode,
      state.reconciliationOutcomes, state.reconciliationSummary, finalizeOutput
    );
    metricsOutcome = 'completed';

  } catch (err) {
    if (err instanceof ReviewExecutionActiveError) {
      metricsOutcome = 'skipped';
      throw err;
    }
    if (err instanceof SubrequestBudgetExceededError) {
      // Budget checkpoint: the stage event stays open on purpose — the next
      // delivery reuses it (attempt number bumps, unique index scopes to
      // ended_at IS NULL) and resumes from the per-file Redis state. Not a
      // failure, so don't failStage.
      console.warn(`[review] ${err.message} — checkpointing ${fullRepo}#${prNumber} for redelivery`);
      metricsOutcome = 'checkpoint';
      checkpointReason = 'subrequest_budget';
      throw err;
    }
    if (err instanceof ReviewRetryScheduledError) {
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
      metricsOutcome = 'failed';
      return;
    }
    metricsOutcome = 'failed';
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
        await redisDel(REVIEW_STATE_KEY(fullRepo, prNumber, reviewId));
      }
    } catch (err) {
      console.warn('[review] Failed to check/clean review state:', err);
    }

    try {
      emitReviewBaseline(
        metrics.snapshot(metricsOutcome, budget?.used ?? 0, checkpointReason)
      );
    } catch (err) {
      // Telemetry is passive. It must never turn a successful review into a
      // queue retry or hide the original pipeline error.
      console.warn('[review] Failed to emit baseline metrics:', err);
    }
  }
}

interface FinalizeReviewOutput {
  rangeStartSha: string | null;
  fallbackReason: string | null;
  noChangesSinceParent: boolean;
  previousScore: number | null;
}

async function finalizeIncompleteReview(
  reviewId: string,
  findings: Finding[],
  state: ReviewState,
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  env: Env,
  effectiveMode: ReviewMode,
  headSha: string
): Promise<void> {
  const ledgerFindings = ensureLedgerFindings(findings, headSha);
  const provisionalScore = effectiveMode === 'incremental'
    ? displayScore(computeScore(ledgerFindings))
    : null;
  const comment = formatIncompleteReviewComment(
    ledgerFindings,
    state.completedFiles.length,
    state.allFiles.length,
    state.terminalFailedFiles,
    provisionalScore
  );
  await postCommentOnce(owner, repo, prNumber, comment, `<!-- parakh-incomplete:${reviewId} -->`, token);
  const current = await getReview(reviewId, env);
  if (current?.trigger_comment_id) await swapCommentReaction(current, 'confused', owner, repo, token, env);
  await markReviewIncomplete(
    reviewId,
    ledgerFindings,
    provisionalScore,
    `Incomplete review: ${state.completedFiles.length}/${state.allFiles.length} files completed`,
    env
  );
}

export function formatIncompleteReviewComment(
  findings: Finding[],
  completedCount: number,
  totalCount: number,
  failedFiles: string[],
  provisionalScore: number | null
): string {
  const priorityFindings = findings.filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH');
  let comment = `## Parakh Code Review Incomplete - No Score\n\n`;
  comment += `Reviewed **${completedCount} of ${totalCount}** files. `;
  comment += `The remaining ${failedFiles.length} file(s) could not be reviewed after three provider attempts.\n\n`;
  if (provisionalScore !== null) {
    comment += `**Provisional ledger score:** ${provisionalScore}/5\n\n`;
    comment += `This score conservatively retains prior findings for files that could not be revalidated. It is not a completed review score.\n\n`;
  }
  if (priorityFindings.length > 0) {
    comment += `### Critical and high findings already confirmed\n\n`;
    for (const finding of priorityFindings) {
      comment += `- **${finding.severity}** \`${finding.file}:${finding.line}\`: ${finding.body}\n`;
      if (finding.suggestion) comment += `  > ${finding.suggestion}\n`;
    }
    comment += `\nFix these issues, then reply \`@parakh review\` to review the complete PR.\n`;
  } else {
    comment += `No critical or high findings were confirmed in the reviewed subset. Unreviewed files may still contain issues.\n\n`;
    comment += `Reply \`@parakh review\` to retry the complete review.\n`;
  }
  comment += `\n**Unreviewed files:** ${failedFiles.map((file) => `\`${file}\``).join(', ')}\n`;
  return comment;
}

async function finalizeReview(
  reviewId: string,
  findings: Finding[],
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  env: Env,
  stageAttempt: number,
  metrics: ReviewBaselineCollector,
  headSha: string,
  effectiveMode: ReviewMode,
  reconciliationOutcomes: FindingReconciliationOutcome[],
  reconciliationSummary: ReconciliationSummary,
  output: FinalizeReviewOutput
): Promise<void> {
  const fullRepo = `${owner}/${repo}`;

  // Idempotency guard: if another delivery already finalized this review
  // (double completion from a redelivery), bail before posting anything again.
  const current = await getReview(reviewId, env);
  if (current?.status === 'COMPLETED') {
    console.log(`[review] finalize skipped — review ${reviewId} already COMPLETED`);
    return;
  }

  const ledgerFindings = ensureLedgerFindings(findings, headSha);
  const persistedSummary = effectiveMode === 'full'
    ? { ...emptyReconciliationSummary(), newCount: ledgerFindings.length }
    : reconciliationSummary;

  await startStage(reviewId, 'SCORING', stageAttempt, env);
  const rawScore = computeScore(ledgerFindings);
  const score = selectDisplayedReviewScore(
    rawScore,
    output.noChangesSinceParent,
    output.previousScore
  );
  metrics.recordScore(rawScore, score);
  await updateReviewResults(reviewId, score, ledgerFindings, env);
  await saveReviewReconciliation(reviewId, reconciliationOutcomes, persistedSummary, env);
  await completeStage(reviewId, 'SCORING', stageAttempt, env, metrics.stageDetail());

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
      ledgerFindings,
      fullRepo,
      prNumber,
      env.DASHBOARD_BASE_URL,
      {
        mode: effectiveMode,
        rangeStartSha: output.rangeStartSha,
        rangeEndSha: headSha,
        newFindingCount: persistedSummary.newCount,
        existingUnresolvedCount: Math.max(0, ledgerFindings.length - persistedSummary.newCount),
        resolvedCount: persistedSummary.resolvedCount,
        fallbackReason: output.fallbackReason,
        noChangesSinceParent: output.noChangesSinceParent,
      }
    );
    await postCommentOnce(
      owner,
      repo,
      prNumber,
      comment,
      `<!-- parakh-review:${reviewId} -->`,
      token
    );
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
