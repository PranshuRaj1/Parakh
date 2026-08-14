/**
 * Reviews Database Access Layer
 *
 * All operations on the `reviews` table.
 * This module ONLY does DB queries. No business logic.
 */

import { getDb } from './client.js';
import type { Review, ReviewStatus, Finding, RepoSettings, ReviewStepEvent, ReviewReasoning } from '@parakh/shared';

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
    head_sha?: string | null;
    base_sha?: string | null;
  },
  env: EnvWithDB
): Promise<Review> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    INSERT INTO reviews (repo, pr_number, installation_id, status, score, findings,
                         seen_reaction_id, trigger_reason, github_delivery_id,
                         head_sha, base_sha)
    VALUES (
      ${review.repo},
      ${review.pr_number},
      ${review.installation_id},
      ${review.status},
      ${review.score ?? null},
      ${review.findings ? JSON.stringify(review.findings) : null}::jsonb,
      ${review.seen_reaction_id ?? null},
      ${review.trigger_reason ?? 'opened'},
      ${review.github_delivery_id ?? null},
      ${review.head_sha ?? null},
      ${review.base_sha ?? null}
    )
    RETURNING *
  `;

  return rows[0] as unknown as Review;
}

/**
 * Persist the SHA pin (head/base) once captured, so every subsequent
 * attempt/redelivery fetches the SAME immutable diff.
 */
export async function updateReviewShaPin(
  id: string,
  headSha: string,
  baseSha: string | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET head_sha = ${headSha},
        base_sha = ${baseSha}
    WHERE id = ${id}
  `;
}

export async function updateReviewCompatibilityMetadata(
  id: string,
  activeRulesHash: string,
  pipelineVersion: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET active_rules_hash = ${activeRulesHash},
        pipeline_version = ${pipelineVersion}
    WHERE id = ${id}
  `;
}

export async function updateReviewIncrementalPlan(
  id: string,
  parentReviewId: string | null,
  comparisonBaseSha: string | null,
  planningFallbackReason: string | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET parent_review_id = ${parentReviewId}::uuid,
        comparison_base_sha = ${comparisonBaseSha},
        fallback_reason = COALESCE(${planningFallbackReason}, fallback_reason)
    WHERE id = ${id}
  `;
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
 * Record which comment triggered a manual_mention review, plus the id of the
 * reaction currently live on that comment (👀). Called on fresh starts only.
 */
export async function setTriggerCommentContext(
  id: string,
  commentId: number,
  commentType: 'issue_comment' | 'pull_request_review_comment',
  reactionId: number | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET trigger_comment_id = ${commentId},
        trigger_comment_type = ${commentType},
        trigger_comment_reaction_id = ${reactionId}
    WHERE id = ${id}
  `;
}

/**
 * Point trigger_comment_reaction_id at the currently-live reaction on the
 * trigger comment, so the next swap knows which one to remove first.
 * Pass null when the comment has no live reaction (middle-band verdict).
 */
export async function updateTriggerCommentReactionId(
  id: string,
  reactionId: number | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET trigger_comment_reaction_id = ${reactionId}
    WHERE id = ${id}
  `;
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

export async function getLatestCompletedReviewBefore(
  repo: string,
  prNumber: number,
  currentReviewId: string,
  env: EnvWithDB
): Promise<Review | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT candidate.*
    FROM reviews candidate
    JOIN reviews current_review ON current_review.id = ${currentReviewId}::uuid
    WHERE candidate.repo = ${repo}
      AND candidate.pr_number = ${prNumber}
      AND candidate.status = 'COMPLETED'
      AND candidate.created_at < current_review.created_at
    ORDER BY candidate.created_at DESC
    LIMIT 1
  `;
  return (rows[0] as unknown as Review) || null;
}

export interface IncrementalShadowRun {
  reviewId: string;
  parentReviewId: string | null;
  decision: 'eligible' | 'fallback' | 'not_requested' | 'disabled';
  fallbackReason: string | null;
  parentHeadSha: string | null;
  currentHeadSha: string;
  fullInputCharacters: number;
  incrementalInputCharacters: number | null;
  fullEstimatedTokens: number;
  incrementalEstimatedTokens: number | null;
  fullFileCount: number;
  incrementalFileCount: number | null;
  inputRatio: number | null;
  executionDiffHash: string;
  fullDiffHash: string;
  executionMatchesFull: boolean;
}

export async function recordIncrementalShadowRun(
  run: IncrementalShadowRun,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    INSERT INTO incremental_review_shadow_runs (
      review_id, parent_review_id, decision, fallback_reason, parent_head_sha,
      current_head_sha, full_input_characters, incremental_input_characters,
      full_estimated_tokens, incremental_estimated_tokens, full_file_count,
      incremental_file_count, input_ratio, execution_diff_hash, full_diff_hash,
      execution_matches_full
    ) VALUES (
      ${run.reviewId}::uuid, ${run.parentReviewId}::uuid, ${run.decision},
      ${run.fallbackReason}, ${run.parentHeadSha}, ${run.currentHeadSha},
      ${run.fullInputCharacters}, ${run.incrementalInputCharacters},
      ${run.fullEstimatedTokens}, ${run.incrementalEstimatedTokens},
      ${run.fullFileCount}, ${run.incrementalFileCount}, ${run.inputRatio},
      ${run.executionDiffHash}, ${run.fullDiffHash}, ${run.executionMatchesFull}
    )
    ON CONFLICT (review_id) DO UPDATE SET
      parent_review_id = EXCLUDED.parent_review_id,
      decision = EXCLUDED.decision,
      fallback_reason = EXCLUDED.fallback_reason,
      parent_head_sha = EXCLUDED.parent_head_sha,
      current_head_sha = EXCLUDED.current_head_sha,
      full_input_characters = EXCLUDED.full_input_characters,
      incremental_input_characters = EXCLUDED.incremental_input_characters,
      full_estimated_tokens = EXCLUDED.full_estimated_tokens,
      incremental_estimated_tokens = EXCLUDED.incremental_estimated_tokens,
      full_file_count = EXCLUDED.full_file_count,
      incremental_file_count = EXCLUDED.incremental_file_count,
      input_ratio = EXCLUDED.input_ratio,
      execution_diff_hash = EXCLUDED.execution_diff_hash,
      full_diff_hash = EXCLUDED.full_diff_hash,
      execution_matches_full = EXCLUDED.execution_matches_full
  `;
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
    // 1. Insert new stage attempt (started_at defaults to now(), ended_at is null).
    //    Idempotent against the partial unique index
    //    one_open_stage_attempt_per_review (review_id, stage, attempt_number)
    //    WHERE ended_at IS NULL. A redelivered/re-entrant execution (queue
    //    at-least-once, worker eviction) reuses the still-open event instead of
    //    crashing with a duplicate key.
    sql`
      INSERT INTO review_step_events (review_id, stage, attempt_number, detail)
      VALUES (${reviewId}, ${stage}, ${attempt}, ${detail ? JSON.stringify(detail) : null}::jsonb)
      ON CONFLICT (review_id, stage, attempt_number) WHERE ended_at IS NULL
      DO UPDATE SET started_at = now(), detail = EXCLUDED.detail
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

/**
 * Park a review because every LLM provider key hit its DAILY quota.
 *
 * Closes the open stage event as FAILED (code DAILY_QUOTA) WITHOUT setting
 * status = 'FAILED', then sets the review row to PAUSED_DAILY_QUOTA with a
 * resume timestamp. The 1-minute cron re-triggers it after that timestamp.
 */
export async function dbMarkDailyQuotaPaused(
  reviewId: string,
  stage: string,
  attempt: number,
  errorMessage: string,
  resumeAt: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql.transaction([
    sql`
      UPDATE review_step_events
      SET ended_at = now(),
          duration_ms = EXTRACT(EPOCH FROM now() - started_at) * 1000,
          outcome = 'FAILED',
          error_code = 'DAILY_QUOTA',
          error_message = ${errorMessage},
          error_stack = null
      WHERE review_id = ${reviewId} AND stage = ${stage} AND attempt_number = ${attempt} AND ended_at IS NULL
    `,
    sql`
      UPDATE reviews
      SET status = 'PAUSED_DAILY_QUOTA',
          failed_at = now(),
          error_step = ${stage},
          error_message = ${errorMessage},
          daily_quota_resume_at = ${resumeAt},
          worker_heartbeat_at = null
      WHERE id = ${reviewId}
    `,
  ]);
}

/**
 * Find PAUSED_DAILY_QUOTA reviews whose resume timestamp has elapsed
 * (or is missing), so the cron can re-enqueue them for review.
 */
export async function dbFindResumableDailyQuotaReviews(env: EnvWithDB): Promise<Review[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT * FROM reviews
    WHERE status = 'PAUSED_DAILY_QUOTA'
      AND (daily_quota_resume_at IS NULL OR daily_quota_resume_at <= now())
    ORDER BY failed_at ASC
  `;
  return rows as unknown as Review[];
}

// ─── Per-file Review Telemetry ─────────────────────────────────────────────────

export interface ReviewFileEventRecord {
  reviewId: string;
  file: string;
  status: 'COMPLETED' | 'FAILED';
  provider?: string | null;
  model?: string | null;
  findingsCount: number;
  errorMessage?: string | null;
}

/**
 * Record one row of per-file review telemetry (provider, model, outcome).
 * One row per file keeps the dashboard's per-file drill cheap and gives us
 * provider-usage signals without relying on reasoning capture.
 */
export async function recordReviewFileEvent(rec: ReviewFileEventRecord, env: EnvWithDB): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    INSERT INTO review_file_events (review_id, file, status, provider, model, findings_count, error_message)
    VALUES (
      ${rec.reviewId},
      ${rec.file},
      ${rec.status},
      ${rec.provider ?? null},
      ${rec.model ?? null},
      ${rec.findingsCount},
      ${rec.errorMessage ?? null}
    )
  `;
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

/**
 * Lightweight reason update — updates only the live pointer on the reviews row
 * (no reason_transitions append). Used for high-frequency per-file progress so
 * we don't bloat the stage event with one transition per file.
 */
export async function dbUpdateReasonDetail(
  reviewId: string,
  code: string,
  detail: string | null,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE reviews
    SET stage_reason_code = ${code},
        stage_reason_detail = ${detail},
        worker_heartbeat_at = now()
    WHERE id = ${reviewId}
  `;
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

// ─── Reasoning Capture Queries ───────────────────────────────────────────────

/**
 * Upsert the captured reasoning for one reviewed file.
 * Re-runs overwrite the prior row so resume/retry doesn't duplicate reasoning.
 * expires_at is derived from the configured retention window.
 */
export async function saveReviewReasoning(
  reviewId: string,
  file: string,
  input: { model?: string | null; thinking?: string | null; errorMessage?: string | null; retentionDays?: number },
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  const retentionDays = Math.max(1, Math.floor(input.retentionDays ?? 14));
  await sql`
    INSERT INTO review_reasoning (review_id, file, model, thinking, error_message, expires_at)
    VALUES (
      ${reviewId}::uuid,
      ${file},
      ${input.model ?? null},
      ${input.thinking ?? null},
      ${input.errorMessage ?? null},
      now() + make_interval(days => ${retentionDays})
    )
    ON CONFLICT (review_id, file)
    DO UPDATE SET
      model = EXCLUDED.model,
      thinking = EXCLUDED.thinking,
      error_message = EXCLUDED.error_message,
      expires_at = EXCLUDED.expires_at,
      created_at = now()
  `;
}

/**
 * Read non-expired reasoning rows for a review (dashboard display).
 */
export async function getReviewReasoningForReview(
  reviewId: string,
  env: EnvWithDB
): Promise<ReviewReasoning[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, review_id, file, model, thinking, error_message, created_at, expires_at
    FROM review_reasoning
    WHERE review_id = ${reviewId}::uuid AND expires_at > now()
    ORDER BY created_at ASC
  `;
  return rows as unknown as ReviewReasoning[];
}

/**
 * Bulk upsert reasoning rows for a review in ONE query (one subrequest).
 *
 * The per-file saveReviewReasoning() path was 1 DB subrequest per file —
 * for a 13-file review that alone is 13 of the 50-subrequest free-plan budget.
 * Batching to a single INSERT keeps reasoning capture without blowing the cap.
 */
export async function saveReviewReasonings(
  reviewId: string,
  rows: Array<{ file: string; model?: string | null; thinking?: string | null; errorMessage?: string | null; retentionDays?: number }>,
  env: EnvWithDB
): Promise<void> {
  if (rows.length === 0) return;
  const sql = getDb(env.DATABASE_URL);
  const retentionDays = Math.max(1, Math.floor(rows[0]?.retentionDays ?? 14));

  const files = rows.map(r => r.file);
  const models = rows.map(r => r.model ?? null);
  const thinkings = rows.map(r => r.thinking ?? null);
  const errors = rows.map(r => r.errorMessage ?? null);

  await sql`
    INSERT INTO review_reasoning (review_id, file, model, thinking, error_message, expires_at)
    SELECT ${reviewId}::uuid, f.file, f.model, f.thinking, f.error_message,
           now() + make_interval(days => ${retentionDays})
    FROM UNNEST(${files}::text[], ${models}::text[], ${thinkings}::text[], ${errors}::text[])
      AS f(file, model, thinking, error_message)
    ON CONFLICT (review_id, file)
    DO UPDATE SET
      model = EXCLUDED.model,
      thinking = EXCLUDED.thinking,
      error_message = EXCLUDED.error_message,
      expires_at = EXCLUDED.expires_at,
      created_at = now()
  `;
}

/**
 * Prune reasoning rows past their retention window.
 * Cheap, indexed DELETE — only writes when there is something to remove.
 */
export async function pruneExpiredReasoning(env: EnvWithDB): Promise<number> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    DELETE FROM review_reasoning
    WHERE expires_at < now()
    RETURNING id
  `;
  return rows.length;
}
