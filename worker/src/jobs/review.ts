/**
 * Review Job — Core Review Pipeline
 *
 * Orchestrates the review process: fetch diff → Gemini review per file →
 * post-process severity → score → post comment → reaction.
 *
 * This module ORCHESTRATES the other modules (github, gemini, db, scoring).
 * It contains no auth, API, DB, or LLM logic itself.
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
} from '@parakh/shared';
import { getCachedToken } from '../github/auth.js';
import {
  fetchDiff,
  getPRFiles,
  postComment,
  addReaction,
  removeReaction,
  getPRDetails,
} from '../github/api.js';
import { GeminiClient } from '../gemini/client.js';
import { getActiveRules, getRuleById, incrementEvidenceCount } from '../db/rules.js';
import { updateReviewStatus, updateReviewResults, updateReviewReactions } from '../db/reviews.js';
import type { Env } from '../index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if a file path matches a rule's scope globs.
 * Simple glob matching — supports * and ** patterns.
 */
function matchesScope(filePath: string, scope: Record<string, unknown>): boolean {
  const patterns = scope.include as string[] | undefined;
  if (!patterns || patterns.length === 0) {
    return true; // No scope = applies to all files
  }

  return patterns.some((pattern) => {
    // Convert glob to regex
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

/**
 * Parse a unified diff into per-file chunks.
 */
function parseDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const fileDiffs = diff.split(/^diff --git /m).slice(1); // skip empty first element

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');
    // Extract filename from "a/path b/path" line
    const firstLine = lines[0] || '';
    const match = firstLine.match(/b\/(.+)/);
    if (match) {
      files.set(match[1], fileDiff);
    }
  }

  return files;
}

/**
 * Format findings into a PR comment body.
 */
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

  // Group findings by severity
  const grouped: Record<string, Finding[]> = {};
  for (const f of findings) {
    if (!grouped[f.severity]) grouped[f.severity] = [];
    grouped[f.severity].push(f);
  }

  // Summary
  const counts = Object.entries(grouped)
    .map(([sev, items]) => `${severityEmoji[sev]} ${items.length} ${sev}`)
    .join(' · ');
  comment += `**Summary:** ${counts}\n\n`;

  // Detail per severity level
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

// ─── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Execute the full review pipeline for a PR.
 *
 * Pipeline:
 * 1. Get installation token
 * 2. Update review status to REVIEWING
 * 3. Fetch PR diff + file list
 * 4. Fetch active rules for this repo
 * 5. For each changed file: filter rules by scope, call Gemini
 * 6. Post-process rule findings: compute severity from rule priority (DETERMINISTIC)
 * 7. Increment evidence_count per violation instance
 * 8. Compute score (DETERMINISTIC pure arithmetic)
 * 9. Update review record
 * 10. Remove 👀 reaction
 * 11. Post summary comment
 * 12. Post verdict reaction based on thresholds
 * 13. Update review to COMPLETED
 */
export async function executeReviewJob(
  payload: ReviewJobPayload,
  env: Env
): Promise<void> {
  const { installationId, owner, repo, prNumber, reviewId } = payload;
  const fullRepo = `${owner}/${repo}`;

  console.log(`[review] Starting review for ${fullRepo}#${prNumber}`);

  // 1. Get installation token
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

  // 2. Update review status
  await updateReviewStatus(reviewId, 'REVIEWING', env);

  // 3. Fetch diff
  const diff = await fetchDiff(owner, repo, prNumber, token);
  const fileChunks = parseDiffByFile(diff);

  if (fileChunks.size === 0) {
    console.log(`[review] No file changes in diff for ${fullRepo}#${prNumber}`);
    await finalizeReview(reviewId, 5, [], owner, repo, prNumber, token, env);
    return;
  }

  // 4. Fetch active rules
  const activeRules = await getActiveRules(fullRepo, env);
  console.log(`[review] ${activeRules.length} active rules for ${fullRepo}`);

  // 5. Review each file
  const gemini = new GeminiClient(env.GEMINI_API_KEY);
  const allFindings: Finding[] = [];

  for (const [fileName, fileDiff] of fileChunks) {
    // Filter rules by scope
    const applicableRules = activeRules.filter((r) => matchesScope(fileName, r.scope as Record<string, unknown>));

    try {
      const result = await gemini.reviewDiff(fileName, fileDiff, applicableRules);

      // 6a. Generic findings — severity from LLM (as-is)
      for (const gf of result.genericFindings) {
        allFindings.push({
          severity: gf.severity,
          file: gf.file || fileName,
          line: gf.line,
          body: gf.body,
          suggestion: gf.suggestion || null,
          rule_id: null,
        });
      }

      // 6b. Rule findings — severity computed in code from rule priority
      for (const rf of result.ruleFindings) {
        // Look up the rule to get its priority
        const rule = applicableRules.find((r) => r.id === rf.rule_id);
        const priority = rule?.priority || 'normal';

        // DETERMINISTIC: severity from code, not LLM
        const severity = resolveSeverityForRuleViolation(priority);

        allFindings.push({
          severity,
          file: rf.file || fileName,
          line: rf.line,
          body: rf.body,
          suggestion: rf.suggestion || null,
          rule_id: rf.rule_id,
        });

        // 7. Increment evidence_count per violation instance
        if (rule) {
          await incrementEvidenceCount(rule.id, env);
        }
      }
    } catch (err) {
      console.error(`[review] Error reviewing ${fileName}:`, err);
      // Continue with other files — don't fail the whole review for one file
    }

    // Rate limiting — space out per-file calls
    if (fileChunks.size > 1) {
      await delay(GEMINI_RATE_LIMITS.PER_FILE_DELAY_MS);
    }
  }

  // 8. Compute score (DETERMINISTIC)
  const rawScore = computeScore(allFindings);
  const score = displayScore(rawScore);

  console.log(`[review] ${fullRepo}#${prNumber}: ${allFindings.length} findings, score ${score}/5`);

  // 9-13. Finalize
  await finalizeReview(reviewId, score, allFindings, owner, repo, prNumber, token, env);
}

/**
 * Finalize a review: update DB, remove 👀, post comment, post verdict reaction.
 */
async function finalizeReview(
  reviewId: string,
  score: number,
  findings: Finding[],
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  env: Env
): Promise<void> {
  const fullRepo = `${owner}/${repo}`;

  // 9. Update review record
  await updateReviewResults(reviewId, score, findings, env);

  // 10. Remove 👀 reaction
  const review = await import('../db/reviews.js').then((m) => m.getLatestReviewByPR(fullRepo, prNumber, env));
  if (review?.seen_reaction_id) {
    try {
      await removeReaction(owner, repo, prNumber, review.seen_reaction_id, token);
    } catch (err) {
      console.warn(`[review] Failed to remove 👀 reaction:`, err);
    }
  }

  // 11. Post summary comment
  const comment = formatReviewComment(
    computeScore(findings), // raw score for breakdown display
    score,
    findings,
    fullRepo,
    prNumber
  );
  await postComment(owner, repo, prNumber, comment, token);

  // 12. Post verdict reaction based on thresholds
  let verdictReactionId: number | null = null;
  if (score >= POSITIVE_THRESHOLD) {
    verdictReactionId = await addReaction(owner, repo, prNumber, REACTIONS.POSITIVE, token);
  } else if (score < NEGATIVE_THRESHOLD) {
    verdictReactionId = await addReaction(owner, repo, prNumber, REACTIONS.NEGATIVE, token);
  }
  // 2.5 ≤ score < 4.0 → no reaction (mixed result, let inline comments speak)

  // 13. Update review to COMPLETED with reaction IDs
  if (verdictReactionId !== null) {
    await updateReviewReactions(reviewId, env, undefined, verdictReactionId);
  }
  await updateReviewStatus(reviewId, 'COMPLETED', env);

  console.log(`[review] Completed review for ${fullRepo}#${prNumber}: ${score}/5`);
}

// ─── Redis Helpers (duplicated from handler.ts — will refactor into shared util) ─

function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    const data = (await response.json()) as { result: string | null };
    return data.result;
  };
}

function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${key}/${value}/EX/${opts.ex}` : `/${key}/${value}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    return response.json();
  };
}
