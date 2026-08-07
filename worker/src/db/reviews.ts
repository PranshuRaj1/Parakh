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
    github_delivery_id?: string | null;
  },
  env: EnvWithDB
): Promise<Review> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    INSERT INTO reviews (repo, pr_number, installation_id, status, score, findings,
                         seen_reaction_id, trigger_reason, github_delivery_id)
    VALUES (
      ${review.repo},
      ${review.pr_number},
      ${review.installation_id},
      ${review.status},
      ${review.score ?? null},
      ${review.seen_reaction_id ?? null},
      ${review.trigger_reason ?? 'opened'},
      ${review.github_delivery_id ?? null}
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
  env: EnvWithDB,
  githubDeliveryId?: string
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  if (githubDeliveryId) {
    await sql`
      UPDATE reviews
      SET status = ${status},
          github_delivery_id = ${githubDeliveryId}
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE reviews
      SET status = ${status}
      WHERE id = ${id}
    `;
  }
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
  env: EnvWithDB,
  durationMs?: number | null
): Promise<string> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    INSERT INTO review_step_events (review_id, step, status, detail, duration_ms)
    VALUES (
      ${reviewId}::uuid,
      ${step},
      ${status},
      ${detail ? JSON.stringify(detail) : null}::jsonb,
      ${durationMs ?? null}
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

// ─── ETA Queries ─────────────────────────────────────────────────────────────

export async function getMatchingStartedEvent(
  reviewId: string,
  step: string,
  env: EnvWithDB
): Promise<ReviewStepEvent | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT *
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid AND step = ${step} AND status = 'STARTED'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return (rows[0] as unknown as ReviewStepEvent) || null;
}

export async function countCompletedReviews(
  repo: string | null,
  env: EnvWithDB
): Promise<number> {
  const sql = getDb(env.DATABASE_URL);
  let rows;
  if (repo) {
    rows = await sql`SELECT COUNT(*)::int as count FROM reviews WHERE status = 'COMPLETED' AND repo = ${repo}`;
  } else {
    rows = await sql`SELECT COUNT(*)::int as count FROM reviews WHERE status = 'COMPLETED'`;
  }
  return rows[0].count;
}

export async function getAvgDurationByStep(
  repo: string | null,
  env: EnvWithDB
): Promise<Map<string, number>> {
  const sql = getDb(env.DATABASE_URL);
  let rows;
  if (repo) {
    rows = await sql`
      SELECT rse.step, AVG(rse.duration_ms) AS avg_ms
      FROM review_step_events rse
      JOIN reviews r ON r.id = rse.review_id
      WHERE rse.status = 'COMPLETED' AND rse.step != 'REVIEWING_FILES'
        AND r.repo = ${repo}
      GROUP BY rse.step;
    `;
  } else {
    rows = await sql`
      SELECT rse.step, AVG(rse.duration_ms) AS avg_ms
      FROM review_step_events rse
      WHERE rse.status = 'COMPLETED' AND rse.step != 'REVIEWING_FILES'
      GROUP BY rse.step;
    `;
  }
  
  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.avg_ms != null) map.set(row.step, Number(row.avg_ms));
  }
  return map;
}

export async function getAvgMsPerFile(
  repo: string | null,
  env: EnvWithDB
): Promise<number> {
  const sql = getDb(env.DATABASE_URL);
  let rows;
  if (repo) {
    rows = await sql`
      SELECT AVG(rse.duration_ms::float / NULLIF((rse.detail->>'batchSize')::int, 0)) AS avg_ms_per_file
      FROM review_step_events rse
      JOIN reviews r ON r.id = rse.review_id
      WHERE rse.step = 'REVIEWING_FILES' AND rse.status = 'COMPLETED'
        AND r.repo = ${repo};
    `;
  } else {
    rows = await sql`
      SELECT AVG(rse.duration_ms::float / NULLIF((rse.detail->>'batchSize')::int, 0)) AS avg_ms_per_file
      FROM review_step_events rse
      WHERE rse.step = 'REVIEWING_FILES' AND rse.status = 'COMPLETED';
    `;
  }
  return Number(rows[0]?.avg_ms_per_file) || 0;
}

export async function getCompletedStepsForReview(
  reviewId: string,
  env: EnvWithDB
): Promise<{ step: string; duration_ms: number | null }[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT step, duration_ms
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid AND status = 'COMPLETED'
  `;
  return rows as { step: string; duration_ms: number | null }[];
}

export async function getLatestReviewingFilesDetail(
  reviewId: string,
  env: EnvWithDB
): Promise<{ completedCount: number; totalCount: number } | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT detail
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid AND step = 'REVIEWING_FILES' AND status IN ('STARTED', 'COMPLETED')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!rows[0] || !rows[0].detail) return null;
  const detail = rows[0].detail as Record<string, unknown>;
  if (typeof detail.completedCount === 'number' && typeof detail.totalCount === 'number') {
    return { completedCount: detail.completedCount, totalCount: detail.totalCount };
  }
  return null;
}

export async function getStepEventsForReview(
  reviewId: string,
  env: EnvWithDB
): Promise<ReviewStepEvent[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT *
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid
    ORDER BY created_at ASC
  `;
  return rows as unknown as ReviewStepEvent[];
}
