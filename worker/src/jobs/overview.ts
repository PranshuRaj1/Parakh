/**
 * Persistent PR overview comment — Greptile-style single comment per PR.
 *
 * One stable-marker issue comment holds the latest score, a short PR
 * overview, and a row per changed file. Every completed review updates the
 * same comment in place instead of posting a new summary. Inline finding
 * comments stay separate and immutable.
 */

import type { FileAnalysis, Severity } from '@parakh/shared';
import { findIssueCommentByMarker, postComment, updateIssueComment } from '../github/api.js';
import type { Env } from '../index.js';
import { getLatestOverviewCommentId, setReviewOverviewCommentId } from '../db/reviews.js';

export const OVERVIEW_MARKER = '<!-- parakh-pr-overview -->';

/** GitHub rejects bodies past 65_536 chars — build well under that. */
const OVERVIEW_BODY_BUDGET = 60_000;

/** Severity → display priority label for inline comments. */
export function formatPriority(severity: Severity): string {
  const labels: Record<Severity, string> = {
    CRITICAL: '🔴 **P0**',
    HIGH: '🟠 **P1**',
    MEDIUM: '🟡 **P2**',
    LOW: '🟡 **P2**',
  };
  return labels[severity];
}

/** Flatten whitespace and escape Markdown table separators for safe cells. */
function tableCell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

/** Flatten whitespace and cap a model-generated file overview at 200 chars. */
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
export function deterministicPrOverview(files: FileAnalysis[]): string {
  if (files.length === 0) return 'No file changes.';
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return `Changes ${files.length} file${files.length === 1 ? '' : 's'}, adding ${additions} and removing ${deletions} lines.`;
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
}

/**
 * Render the persistent overview comment body (without the stable marker —
 * the upsert appends it). Rows follow the given order; when the body would
 * exceed the budget, complete rows are included until it no longer fits.
 */
export function formatOverviewComment(input: OverviewCommentInput): string {
  let body =
    `# Parakh Overview\n\n## Score: ${input.score}/5\n\n## Overview\n\n${tableCell(input.prOverview)}\n\n## Files Changed\n\n` +
    '| File | Changes | Overview |\n| --- | ---: | --- |\n';

  let truncated = false;
  let rows = '';
  for (const file of input.files) {
    const row = `| \`${tableCell(file.path)}\` | +${file.additions} / -${file.deletions} | ${tableCell(file.overview)} |\n`;
    if (body.length + rows.length + row.length > OVERVIEW_BODY_BUDGET) {
      truncated = true;
      break;
    }
    rows += row;
  }
  body += rows;

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
