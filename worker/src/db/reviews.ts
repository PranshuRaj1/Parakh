/**
 * Reviews Database Access Layer
 *
 * All operations on the `reviews` table.
 * This module ONLY does DB queries. No business logic.
 */

import { getDb } from './client.js';
import type { Review, ReviewStatus, Finding, RepoSettings } from '@parakh/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

interface EnvWithDB {
  DATABASE_URL: string;
}

// ─── Review Queries ──────────────────────────────────────────────────────────

/**
 * Insert a new review record.
 * Every synchronize event creates a new row — intentional for score history.
 */
export async function insertReview(
  review: {
    repo: string;
    pr_number: number;
    status: ReviewStatus;
    score?: number;
    findings?: Finding[];
    seen_reaction_id?: number;
    trigger_reason?: 'opened' | 'synchronize' | 'manual_mention';
  },
  env: EnvWithDB
): Promise<Review> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    INSERT INTO reviews (repo, pr_number, status, score, findings, seen_reaction_id, trigger_reason)
    VALUES (
      ${review.repo},
      ${review.pr_number},
      ${review.status},
      ${review.score ?? null},
      ${review.findings ? JSON.stringify(review.findings) : null}::jsonb,
      ${review.seen_reaction_id ?? null},
      ${review.trigger_reason ?? 'opened'}
    )
    RETURNING id, repo, pr_number, score, findings, seen_reaction_id,
              verdict_reaction_id, status, trigger_reason, created_at
  `;

  return rows[0] as unknown as Review;
}

// ─── Repo Settings Queries ───────────────────────────────────────────────────

/**
 * Get settings for a specific repository.
 */
export async function getRepoSettings(repo: string, env: EnvWithDB): Promise<RepoSettings | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT * FROM repo_settings WHERE repo = ${repo}
  `;
  return (rows[0] as unknown as RepoSettings) || null;
}

/**
 * Update reaction IDs on a review record.
 */
export async function updateReviewReactions(
  id: string,
  env: EnvWithDB,
  seenReactionId?: number,
  verdictReactionId?: number
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);

  if (seenReactionId !== undefined && verdictReactionId !== undefined) {
    await sql`
      UPDATE reviews
      SET seen_reaction_id = ${seenReactionId},
          verdict_reaction_id = ${verdictReactionId}
      WHERE id = ${id}
    `;
  } else if (seenReactionId !== undefined) {
    await sql`
      UPDATE reviews
      SET seen_reaction_id = ${seenReactionId}
      WHERE id = ${id}
    `;
  } else if (verdictReactionId !== undefined) {
    await sql`
      UPDATE reviews
      SET verdict_reaction_id = ${verdictReactionId}
      WHERE id = ${id}
    `;
  }
}

/**
 * Update the status of a review.
 */
export async function updateReviewStatus(
  id: string,
  status: ReviewStatus,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET status = ${status}
    WHERE id = ${id}
  `;
}

/**
 * Update review with completed results.
 */
export async function updateReviewResults(
  id: string,
  score: number,
  findings: Finding[],
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET score = ${score},
        findings = ${JSON.stringify(findings)}::jsonb
    WHERE id = ${id}
  `;
}

/**
 * Get the LATEST review for a PR.
 * Uses ORDER BY created_at DESC LIMIT 1 — always the most recent row.
 *
 * Important: multiple rows per PR is intentional (score history per push).
 * This function specifically returns the latest for stale-reaction cleanup.
 */
export async function getLatestReviewByPR(
  repo: string,
  prNumber: number,
  env: EnvWithDB
): Promise<Review | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, repo, pr_number, score, findings, seen_reaction_id,
           verdict_reaction_id, status, created_at
    FROM reviews
    WHERE repo = ${repo} AND pr_number = ${prNumber}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return (rows[0] as unknown as Review) || null;
}

/**
 * Get recent reviews for a repo (for dashboard display).
 */
export async function getRecentReviews(
  repo: string,
  limit: number,
  env: EnvWithDB
): Promise<Review[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, repo, pr_number, score, findings, seen_reaction_id,
           verdict_reaction_id, status, created_at
    FROM reviews
    WHERE repo = ${repo}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return rows as unknown as Review[];
}

/**
 * Get all reviews for a specific PR (for score history on dashboard).
 */
export async function getReviewsByPR(
  repo: string,
  prNumber: number,
  env: EnvWithDB
): Promise<Review[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, repo, pr_number, score, findings, seen_reaction_id,
           verdict_reaction_id, status, created_at
    FROM reviews
    WHERE repo = ${repo} AND pr_number = ${prNumber}
    ORDER BY created_at ASC
  `;

  return rows as unknown as Review[];
}
