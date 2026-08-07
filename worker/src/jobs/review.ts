/**
 * Review Job — Core Review Pipeline
 *
 * Orchestrates the review process with batched chunking, resumability, and
 * concurrency-safe API key rotation.
 */

import type { ReviewJobPayload, Finding, Rule } from '@parakh/shared';
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
} from '../github/api.js';
import {
  updateReviewStatus,
  updateReviewResults,
  updateReviewReactions,
  getLatestReviewByPR,
  insertReview,
  getReview,
  markReviewPaused,
} from '../db/reviews.js';
import { getActiveRules, incrementEvidenceCount } from '../db/rules.js';
import { GeminiClient } from '../gemini/client.js';
import { AllKeysExhaustedError } from '../gemini/keyPool.js';
import { stepStarted, stepCompleted, resetProgressTracking } from './progress.js';
import type { Env } from '../index.js';
import { createRedisGet, createRedisSet, createRedisSetNX, createRedisDel } from '../redis.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function formatReviewComment(
  score: number,
  displayedScore: number,
  findings: Finding[],
  repo: string,
  prNumber: number
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
    return comment;
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

  return comment;
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
  env: Env
): Promise<Finding[]> {
  const fileDiff = fileChunks.get(fileName);
  if (!fileDiff) return [];

  const applicableRules = activeRules.filter(r =>
    matchesScope(fileName, r.scope as Record<string, unknown>)
  );

  const result = await gemini.reviewDiff(fileName, fileDiff, applicableRules);
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
  skipLock?: boolean
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
    await updateReviewStatus(reviewId, 'SEEN', env);
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
      status: 'SEEN',
      seen_reaction_id: seenReactionId,
      trigger_reason: reason,
    }, env);
    reviewId = review.id;
  }

  const payload: ReviewJobPayload = {
    type: 'REVIEW',
    installationId,
    owner,
    repo,
    prNumber,
    reviewId,
  };

  await executeReviewJobInternal(payload, env, token);
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

  try {
    let state = await loadReviewState(fullRepo, prNumber, redisGet);

    await stepStarted(reviewId, 'FETCHING_DIFF', env);
    const diff = await fetchDiff(owner, repo, prNumber, token);
    const fileChunks = parseDiffByFile(diff);
    const currentDiffHash = await sha256(diff);
    await stepCompleted(reviewId, 'FETCHING_DIFF', env);

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
      };
    }

    await saveReviewState(fullRepo, prNumber, state, redisSet);

    const remainingFiles = state.allFiles.filter(f => !state.completedFiles.includes(f));

    if (remainingFiles.length === 0) {
      await finalizeReview(reviewId, state.accumulatedFindings, owner, repo, prNumber, token, env);
      return;
    }

    await stepStarted(reviewId, 'FETCHING_RULES', env);
    const activeRules = await getActiveRules(fullRepo, env);
    await stepCompleted(reviewId, 'FETCHING_RULES', env);

    const gemini = new GeminiClient(env);
    const allFindings = [...state.accumulatedFindings];
    const filesToProcess = [...remainingFiles];

    while (filesToProcess.length > 0) {
      const batch = filesToProcess.splice(0, MAX_FILES_PER_BATCH);

      await stepStarted(reviewId, 'REVIEWING_FILES', env, {
        batchIndex: state.batchIndex,
        fileNames: batch,
      });

      const results = await Promise.allSettled(
        batch.map(fileName => reviewSingleFile(gemini, fileName, fileChunks, activeRules, env))
      );

      const exhausted = results.find(
        r => r.status === 'rejected' && r.reason instanceof AllKeysExhaustedError
      );

      if (exhausted) {
        state.accumulatedFindings = allFindings;
        await saveReviewState(fullRepo, prNumber, state, redisSet);
        await markReviewPaused(reviewId, env);

        await postComment(owner, repo, prNumber,
          "⏳ All Gemini API keys are rate-limited right now. " +
          "Reply `@parakh review` in a minute to pick this back up.",
          token
        );
        return; 
      }

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          allFindings.push(...r.value);
        } else {
          console.error(`[review] Error reviewing ${batch[i]}:`, r.reason);
        }
        state.completedFiles.push(batch[i]);
      }

      await stepCompleted(reviewId, 'REVIEWING_FILES', env, {
        batchIndex: state.batchIndex,
        completedCount: state.completedFiles.length,
        totalCount: state.allFiles.length,
      });

      state.batchIndex++;
      state.accumulatedFindings = allFindings;
      await saveReviewState(fullRepo, prNumber, state, redisSet);

      if (filesToProcess.length > 0) {
        await delay(GEMINI_RATE_LIMITS.PER_FILE_DELAY_MS);
      }
    }

    await finalizeReview(reviewId, allFindings, owner, repo, prNumber, token, env);

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

    resetProgressTracking(reviewId);
  }
}

async function finalizeReview(
  reviewId: string,
  findings: Finding[],
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  env: Env
): Promise<void> {
  const fullRepo = `${owner}/${repo}`;

  const rawScore = computeScore(findings);
  const score = displayScore(rawScore);

  await updateReviewResults(reviewId, score, findings, env);

  const review = await import('../db/reviews.js').then((m) => m.getLatestReviewByPR(fullRepo, prNumber, env));
  if (review?.seen_reaction_id) {
    try {
      await removeReaction(owner, repo, prNumber, review.seen_reaction_id, token);
    } catch (err) {
      console.warn(`[review] Failed to remove 👀 reaction:`, err);
    }
  }

  const comment = formatReviewComment(
    rawScore,
    score,
    findings,
    fullRepo,
    prNumber
  );
  await postComment(owner, repo, prNumber, comment, token);

  let verdictReactionId: number | null = null;
  if (score >= POSITIVE_THRESHOLD) {
    verdictReactionId = await addReaction(owner, repo, prNumber, REACTIONS.POSITIVE, token);
  } else if (score < NEGATIVE_THRESHOLD) {
    verdictReactionId = await addReaction(owner, repo, prNumber, REACTIONS.NEGATIVE, token);
  }

  if (verdictReactionId !== null) {
    await updateReviewReactions(reviewId, env, undefined, verdictReactionId);
  }
  await updateReviewStatus(reviewId, 'COMPLETED', env);

  console.log(`[review] Completed review for ${fullRepo}#${prNumber}: ${score}/5`);
}
