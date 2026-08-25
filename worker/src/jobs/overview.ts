/**
 * Persistent PR overview comment — Greptile-style single comment per PR.
 *
 * One stable-marker issue comment holds the latest score, a short PR
 * overview, and a row per changed file. Every completed review updates the
 * same comment in place instead of posting a new summary. Inline finding
 * comments stay separate and immutable.
 */

import type { CodebaseImpact, FileAnalysis, Severity } from '@parakh/shared';
import { findIssueCommentByMarker, postComment, updateIssueComment } from '../github/api.js';
import type { Env } from '../index.js';
import { getLatestOverviewCommentId, setReviewOverviewCommentId } from '../db/reviews.js';

export const OVERVIEW_MARKER = '<!-- parakh-pr-overview -->';

/** GitHub rejects bodies past 65_536 chars — build well under that. */
const OVERVIEW_BODY_BUDGET = 60_000;

/** Severity → display priority label for inline comments. */
export function formatPriority(severity: Severity): string {
  const labels: Record<Severity, string> = {
    CRITICAL: '<a href="#"><img alt="P0" src="https://greptile-static-assets.s3.amazonaws.com/badges/p0.svg?v=7" align="top"></a>',
    HIGH: '<a href="#"><img alt="P1" src="https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg?v=7" align="top"></a>',
    MEDIUM: '<a href="#"><img alt="P2" src="https://greptile-static-assets.s3.amazonaws.com/badges/p2.svg?v=7" align="top"></a>',
    LOW: '<a href="#"><img alt="P2" src="https://greptile-static-assets.s3.amazonaws.com/badges/p2.svg?v=7" align="top"></a>',
  };
  return labels[severity];
}

/** Flatten whitespace and escape Markdown table separators for safe cells. */
function tableCell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

/** Flatten whitespace and cap a model-generated file overview at 200 chars. */
/** Keep model-generated overview text safe before it crosses into GitHub markup. */
export function sanitizeOverview(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Generated lockfiles are machine-written; summarize them deterministically. */
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

/** Deterministic overview for files never sent to the model. */
export function fallbackFileOverview(file: { status: string; filename: string }): string {
  if (file.status === 'removed') return 'Deletes this file.';
  if (file.status === 'renamed') return 'Renames this file.';
  if (isIgnoredLockfile(file.filename)) return 'Updates locked dependency metadata.';
  return 'Updates this file.';
}

/** Deterministic PR-level overview when no model summary is available. */
/** Build a model-independent PR summary when no usable model overview exists. */
export function deterministicPrOverview(files: FileAnalysis[]): string {
  if (files.length === 0) return 'No file changes.';
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const stats = `Changes ${files.length} file${files.length === 1 ? '' : 's'}, adding ${additions} and removing ${deletions} lines.`;
  const changes = files
    .map((file) => sanitizeOverview(file.overview))
    .filter((overview) => overview && !/^Updates this file\.$/.test(overview))
    .filter((overview, index, overviews) => overviews.indexOf(overview) === index)
    .slice(0, 3);
  return changes.length > 0 ? `${stats} Key changes: ${changes.join(' ')}` : stats;
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

export interface OverviewCommentInput {
  score: number;
  prOverview: string;
  files: FileAnalysis[];
  repo: string;
  prNumber: number;
  dashboardBaseUrl?: string;
  codebaseImpact?: CodebaseImpact;
}

function formatImpact(impact: CodebaseImpact): string {
  const report = impact.blastRadius;
  const symbolLine = (symbol: { qualifiedName: string; path: string; startLine: number }) =>
    `- \`${symbol.qualifiedName}\` (${symbol.path}:${symbol.startLine})`;
  const lines = [`## Codebase Impact\n\n**Blast radius: ${report.level}**`];
  if (report.changedSymbols.length > 0) {
    lines.push(`\nChanged symbols:\n${report.changedSymbols.slice(0, 20).map(symbolLine).join('\n')}`);
  }
  if (report.affectedSymbols.length > 0) {
    lines.push(`\nAffected callers:\n${report.affectedSymbols.slice(0, 12).map(symbolLine).join('\n')}`);
  }
  if (report.relatedTests.length > 0) {
    lines.push(`\nRelated tests:\n${report.relatedTests.slice(0, 8).map((symbol) => `- \`${symbol.path}:${symbol.startLine}\``).join('\n')}`);
  }
  if (report.riskSignals.length > 0) lines.push(`\nRisk signals:\n${report.riskSignals.slice(0, 8).map((signal) => `- ${signal}`).join('\n')}`);
  if (impact.reuseCandidates.length > 0) {
    lines.push(`\nPossible reuse:\n${impact.reuseCandidates.slice(0, 5).map((candidate) => `- \`${candidate.candidate.qualifiedName}\` (${candidate.candidate.path}:${candidate.candidate.startLine})\n  ${candidate.signals.join('; ')}\n  ${candidate.recommendation}`).join('\n')}`);
  }
  return lines.join('\n');
}

/**
 * Render the persistent overview comment body (without the stable marker —
 * the upsert appends it). Rows follow the given order; when the body would
 * exceed the budget, complete rows are included until it no longer fits.
 */
export function formatOverviewComment(input: OverviewCommentInput): string {
  const impact = input.codebaseImpact ? `\n${formatImpact(input.codebaseImpact)}\n` : '';
  let body =
    `# Parakh Overview\n\n## Score: ${input.score}/5\n\n## Overview\n\n${tableCell(input.prOverview)}\n\n## Files Changed\n\n` +
    '| File | Changes | Overview |\n| --- | ---: | --- |\n';

  let truncated = false;
  let rows = '';
  for (const file of input.files) {
    const row = `| \`${tableCell(file.path)}\` | +${file.additions} / -${file.deletions} | ${tableCell(file.overview)} |\n`;
    if (body.length + rows.length + row.length + impact.length > OVERVIEW_BODY_BUDGET) {
      truncated = true;
      break;
    }
    rows += row;
  }
  body += rows;

  body += impact;

  if (truncated) {
    body += '\n_Additional changed files are available on the dashboard because this PR exceeds GitHub’s comment size limit._\n';
  }

  return appendDashboardLink(body, input.repo, input.prNumber, input.dashboardBaseUrl);
}

/**
 * Create-or-update the single persistent overview comment for a PR.
 *
 * Resolution order: the stored comment ID from the latest prior review, then
 * any existing comment carrying the stable marker, then create fresh. A
 * stored ID pointing at a deleted comment (404) falls through to search.
 */
/** Update the single durable overview comment instead of creating duplicates. */
export async function upsertOverviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: string,
  body: string,
  token: string,
  env: Env
): Promise<void> {
  const marked = `${body}\n\n${OVERVIEW_MARKER}`;

  try {
    const storedId = await getLatestOverviewCommentId(`${owner}/${repo}`, prNumber, env);
    if (storedId) {
      await updateIssueComment(owner, repo, storedId, marked, token);
      await setReviewOverviewCommentId(reviewId, storedId, env);
      return;
    }
  } catch (err) {
    console.warn(`[review] Stored overview comment unavailable (${owner}/${repo}#${prNumber}) — searching by marker:`, err);
  }

  try {
    const existing = await findIssueCommentByMarker(owner, repo, prNumber, OVERVIEW_MARKER, token);
    if (existing) {
      await updateIssueComment(owner, repo, existing.id, marked, token);
      await setReviewOverviewCommentId(reviewId, existing.id, env);
      return;
    }
  } catch (err) {
    console.warn('[review] Failed to search for an existing overview comment:', err);
  }

  const created = await postComment(owner, repo, prNumber, marked, token);
  await setReviewOverviewCommentId(reviewId, created.id, env);
}
