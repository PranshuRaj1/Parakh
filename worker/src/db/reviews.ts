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
      ${review.findings ? JSON.stringify(review.findings) : null}::jsonb,
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
 * Returns reviews in RUNNING or QUEUED status.
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
      AND status IN ('RUNNING', 'QUEUED')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return (rows[0] as unknown as Review) || null;
}

// ─── Stage Tracking DB Operations ─────────────────────────────────────────────

export async function dbStartStage(
  reviewId: string,
  stage: string,
  attempt: number,
  detail: Record<string, unknown> | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql.transaction([
    // 1. Insert new stage attempt (started_at defaults to now(), ended_at is null)
    sql`
      INSERT INTO review_step_events (review_id, stage, attempt_number, detail)
      VALUES (${reviewId}, ${stage}, ${attempt}, ${detail ? JSON.stringify(detail) : null}::jsonb)
    `,
    // 2. Update reviews live pointer
    sql`
      UPDATE reviews
      SET status = 'RUNNING',
          current_stage = ${stage},
          stage_started_at = now(),
          stage_attempt = ${attempt},
          stage_reason_code = 'PROCESSING',
          stage_reason_detail = null,
          worker_heartbeat_at = now()
      WHERE id = ${reviewId}
    `
  ]);
}

export async function dbCompleteStage(
  reviewId: string,
  stage: string,
  attempt: number,
  detail: Record<string, unknown> | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql.transaction([
    // 1. Close out event
    sql`
      UPDATE review_step_events
      SET ended_at = now(),
          duration_ms = EXTRACT(EPOCH FROM now() - started_at) * 1000,
          outcome = 'COMPLETED',
          detail = CASE 
            WHEN ${detail ? JSON.stringify(detail) : null}::jsonb IS NOT NULL 
            THEN ${detail ? JSON.stringify(detail) : null}::jsonb 
            ELSE detail 
          END
      WHERE review_id = ${reviewId} AND stage = ${stage} AND attempt_number = ${attempt} AND ended_at IS NULL
    `,
    // 2. Clear heartbeat on reviews table
    sql`
      UPDATE reviews
      SET worker_heartbeat_at = null
      WHERE id = ${reviewId}
    `
  ]);
}

export async function dbFailStage(
  reviewId: string,
  stage: string,
  attempt: number,
  errorCode: string,
  errorMessage: string,
  errorStack: string | null,
  terminal: boolean,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  const queries = [
    sql`
      UPDATE review_step_events
      SET ended_at = now(),
          duration_ms = EXTRACT(EPOCH FROM now() - started_at) * 1000,
          outcome = 'FAILED',
          error_code = ${errorCode},
          error_message = ${errorMessage},
          error_stack = ${errorStack}
      WHERE review_id = ${reviewId} AND stage = ${stage} AND attempt_number = ${attempt} AND ended_at IS NULL
    `
  ];

  if (terminal) {
    queries.push(sql`
      UPDATE reviews
      SET status = 'FAILED',
          failed_at = now(),
          error_step = ${stage},
          error_message = ${errorMessage},
          error_stack = ${errorStack},
          worker_heartbeat_at = null
      WHERE id = ${reviewId}
    `);
  }

  await sql.transaction(queries);
}

export async function dbTimeoutStage(
  reviewId: string,
  stage: string,
  attempt: number,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql.transaction([
    sql`
      UPDATE review_step_events
      SET ended_at = now(),
          duration_ms = EXTRACT(EPOCH FROM now() - started_at) * 1000,
          outcome = 'TIMED_OUT',
          error_code = 'STAGE_TIMEOUT'
      WHERE review_id = ${reviewId} AND stage = ${stage} AND attempt_number = ${attempt} AND ended_at IS NULL
    `,
    sql`
      UPDATE reviews
      SET status = 'FAILED',
          failed_at = now(),
          error_step = ${stage},
          error_message = 'Stage timed out',
          worker_heartbeat_at = null
      WHERE id = ${reviewId}
    `
  ]);
}

export async function dbUpdateReason(
  reviewId: string,
  code: string,
  detail: string | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  // 1. Update live pointer
  const reviewRes = await sql`
    UPDATE reviews
    SET stage_reason_code = ${code},
        stage_reason_detail = ${detail},
        worker_heartbeat_at = now()
    WHERE id = ${reviewId}
    RETURNING current_stage, stage_attempt
  `;

  if (reviewRes.length > 0) {
    const { current_stage, stage_attempt } = reviewRes[0];
    // 2. Append to reason_transitions array using jsonb_insert or simply appending.
    await sql`
      UPDATE review_step_events
      SET reason_transitions = reason_transitions || jsonb_build_array(
        jsonb_build_object('code', ${code}::text, 'detail', ${detail}::text, 'at', now())
      )
      WHERE review_id = ${reviewId} AND stage = ${current_stage} AND attempt_number = ${stage_attempt} AND ended_at IS NULL
    `;
  }
}

export async function dbUpdateHeartbeat(
  reviewId: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET worker_heartbeat_at = now()
    WHERE id = ${reviewId}
  `;
}

export async function dbIncrementRetryCount(
  reviewId: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET retry_count = retry_count + 1
    WHERE id = ${reviewId}
  `;
}

export async function dbSweepStalledReviews(
  timeoutSeconds: number,
  env: EnvWithDB
): Promise<{ reviewId: string; stage: string; attempt: number }[]> {
  const sql = getDb(env.DATABASE_URL);
  
  // Find running reviews whose heartbeat is older than timeoutSeconds
  // or (if heartbeat is null) stage_started_at is older.
  const rows = await sql`
    SELECT id, current_stage, stage_attempt
    FROM reviews
    WHERE status = 'RUNNING'
      AND COALESCE(worker_heartbeat_at, stage_started_at) < now() - (${timeoutSeconds} || ' seconds')::interval
  `;
  
  return rows.map(r => ({
    reviewId: r.id as string,
    stage: r.current_stage as string,
    attempt: Number(r.stage_attempt)
  }));
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
  stage: string,
  env: EnvWithDB
): Promise<ReviewStepEvent | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT *
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid AND stage = ${stage} AND ended_at IS NULL
    ORDER BY started_at DESC
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
      SELECT rse.stage as step, AVG(rse.duration_ms) AS avg_ms
      FROM review_step_events rse
      JOIN reviews r ON r.id = rse.review_id
      WHERE rse.outcome = 'COMPLETED' AND rse.stage != 'REVIEWING_FILES'
        AND r.repo = ${repo}
      GROUP BY rse.stage;
    `;
  } else {
    rows = await sql`
      SELECT rse.stage as step, AVG(rse.duration_ms) AS avg_ms
      FROM review_step_events rse
      WHERE rse.outcome = 'COMPLETED' AND rse.stage != 'REVIEWING_FILES'
      GROUP BY rse.stage;
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
      SELECT AVG(rse.duration_ms::float / NULLIF((rse.detail->>'filesProcessed')::int, 0)) AS avg_ms_per_file
      FROM review_step_events rse
      JOIN reviews r ON r.id = rse.review_id
      WHERE rse.stage = 'REVIEWING_FILES' AND rse.outcome = 'COMPLETED'
        AND r.repo = ${repo};
    `;
  } else {
    rows = await sql`
      SELECT AVG(rse.duration_ms::float / NULLIF((rse.detail->>'filesProcessed')::int, 0)) AS avg_ms_per_file
      FROM review_step_events rse
      WHERE rse.stage = 'REVIEWING_FILES' AND rse.outcome = 'COMPLETED';
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
    SELECT stage as step, duration_ms
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid AND outcome = 'COMPLETED'
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
    WHERE review_id = ${reviewId}::uuid AND stage = 'REVIEWING_FILES'
    ORDER BY started_at DESC
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
    ORDER BY started_at ASC
  `;
  return rows as unknown as ReviewStepEvent[];
}
