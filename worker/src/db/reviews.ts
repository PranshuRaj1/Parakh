/**
 * Reviews Database Access Layer
 *
 * All operations on the `reviews` table.
 * This module ONLY does DB queries. No business logic.
 */

import { getDb } from './client.js';
import type { Review, ReviewStatus, Finding, RepoSettings, ReviewStepEvent } from '@parakh/shared';

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
    installation_id: number;
    status: ReviewStatus;
    score?: number;
    findings?: Finding[];
    seen_reaction_id?: number;
    trigger_reason?: 'opened' | 'synchronize' | 'manual_mention' | 'auto_retry';
  },
  env: EnvWithDB
): Promise<Review> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    INSERT INTO reviews (repo, pr_number, installation_id, status, score, findings,
                         seen_reaction_id, trigger_reason)
    VALUES (
      ${review.repo},
      ${review.pr_number},
      ${review.installation_id},
      ${review.status},
      ${review.score ?? null},
      ${review.findings ? JSON.stringify(review.findings) : null}::jsonb,
      ${review.seen_reaction_id ?? null},
      ${review.trigger_reason ?? 'opened'}
    )
    RETURNING *
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

// ─── Stuck Detection & Recovery Queries ───────────────────────────────────────

/**
 * Get a single review by ID.
 * Used by watchdog and resume logic.
 */
export async function getReview(
  id: string,
  env: EnvWithDB
): Promise<Review | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT * FROM reviews WHERE id = ${id}
  `;
  return (rows[0] as unknown as Review) || null;
}

/**
 * Find the latest non-terminal review for a PR.
 * Used by REVIEW_REQUEST handler to check for resumable reviews.
 * Returns reviews in RUNNING or PAUSED_RATE_LIMITED status.
 */
export async function getResumableReview(
  repo: string,
  prNumber: number,
  env: EnvWithDB
): Promise<Review | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT * FROM reviews
    WHERE repo = ${repo}
      AND pr_number = ${prNumber}
      AND status IN ('RUNNING', 'PAUSED_RATE_LIMITED')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return (rows[0] as unknown as Review) || null;
}

/**
 * Insert a step event into the audit log. Returns the generated event ID.
 * Used by progress.ts for step tracking and watchdog scheduling.
 */
export async function insertStepEvent(
  reviewId: string,
  step: string,
  status: string,
  detail: Record<string, unknown> | null,
  env: EnvWithDB
): Promise<string> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    INSERT INTO review_step_events (review_id, step, status, detail)
    VALUES (
      ${reviewId}::uuid,
      ${step},
      ${status},
      ${detail ? JSON.stringify(detail) : null}::jsonb
    )
    RETURNING id
  `;
  return (rows[0] as unknown as { id: string }).id;
}

/**
 * Get the latest step event for a review.
 * Used by watchdog's freshness check — if the latest event ID doesn't match
 * the expected ID, the review has made progress and the watchdog is stale.
 */
export async function getLatestStepEvent(
  reviewId: string,
  env: EnvWithDB
): Promise<ReviewStepEvent | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT * FROM review_step_events
    WHERE review_id = ${reviewId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return (rows[0] as unknown as ReviewStepEvent) || null;
}

/**
 * Update current_step and step_detail on reviews for dashboard display.
 */
export async function updateReviewCurrentStep(
  id: string,
  step: string,
  detail: Record<string, unknown> | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET current_step = ${step},
        step_detail = ${detail ? JSON.stringify(detail) : null}::jsonb
    WHERE id = ${id}
  `;
}

/**
 * Increment retry_count. Called by watchdog before dispatching auto_retry.
 */
export async function incrementRetryCount(
  id: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET retry_count = retry_count + 1
    WHERE id = ${id}
  `;
}

/**
 * Mark a review as RUNNING and set started_at.
 * Called by progress.ts on the first stepStarted() of a pipeline run.
 */
export async function markReviewRunning(
  id: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET status = 'RUNNING',
        started_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Mark a review as FAILED with error details.
 * Terminal state — review won't be auto-retried after this.
 */
export async function markReviewFailed(
  id: string,
  errorStep: string,
  errorMessage: string,
  errorStack: string | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET status = 'FAILED',
        failed_at = now(),
        error_step = ${errorStep},
        error_message = ${errorMessage},
        error_stack = ${errorStack}
    WHERE id = ${id}
  `;
}

/**
 * Mark a review as PAUSED_RATE_LIMITED.
 * Non-terminal — review can be resumed via @parakh review or auto_retry.
 */
export async function markReviewPaused(
  id: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET status = 'PAUSED_RATE_LIMITED'
    WHERE id = ${id}
  `;
}

/**
 * Get repo settings by looking up the review's repo first.
 * Used by progress.ts to get stuck_timeout_seconds for watchdog scheduling.
 */
export async function getRepoSettingsByReviewId(
  reviewId: string,
  env: EnvWithDB
): Promise<RepoSettings | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT rs.* FROM repo_settings rs
    JOIN reviews r ON r.repo = rs.repo
    WHERE r.id = ${reviewId}::uuid
  `;
  return (rows[0] as unknown as RepoSettings) || null;
}
