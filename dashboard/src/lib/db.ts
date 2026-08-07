import { neon } from '@neondatabase/serverless';
import type { Rule, Review, RuleRelationshipRecord } from '@parakh/shared';

// Ensures Next.js doesn't cache DB queries at build time
export const revalidate = 0;

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  return neon(process.env.DATABASE_URL);
}

// ─── Read Queries for Dashboard ──────────────────────────────────────────────

export async function getDashboardRules(repo: string): Promise<Rule[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT id, repo, body, status, scope, priority, supersedes, superseded_by,
           source_pr, evidence_count, reinforcement_count, created_at, superseded_at
    FROM rules
    WHERE repo = ${repo}
    ORDER BY created_at DESC
  `;
  return rows as unknown as Rule[];
}

export async function getDashboardRuleRelationships(repo: string): Promise<RuleRelationshipRecord[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT rr.id, rr.from_rule_id, rr.to_rule_id, rr.relationship, rr.created_at
    FROM rule_relationships rr
    JOIN rules r ON rr.from_rule_id = r.id
    WHERE r.repo = ${repo}
  `;
  return rows as unknown as RuleRelationshipRecord[];
}

export async function getDashboardReviews(repo: string, limit = 50): Promise<Review[]> {
  const sql = getSql();
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

export async function getReview(id: string): Promise<Review | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM reviews WHERE id = ${id}
  `;
  return (rows[0] as unknown as Review) || null;
}

export async function countCompletedReviews(repo: string | null): Promise<number> {
  const sql = getSql();
  let rows;
  if (repo) {
    rows = await sql`SELECT COUNT(*)::int as count FROM reviews WHERE status = 'COMPLETED' AND repo = ${repo}`;
  } else {
    rows = await sql`SELECT COUNT(*)::int as count FROM reviews WHERE status = 'COMPLETED'`;
  }
  return rows[0].count;
}

export async function getAvgDurationByStep(repo: string | null): Promise<Map<string, number>> {
  const sql = getSql();
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

export async function getAvgMsPerFile(repo: string | null): Promise<number> {
  const sql = getSql();
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

export async function getCompletedStepsForReview(reviewId: string): Promise<{ step: string; duration_ms: number | null }[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT step, duration_ms
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid AND status = 'COMPLETED'
  `;
  return rows as { step: string; duration_ms: number | null }[];
}

export async function getLatestReviewingFilesDetail(reviewId: string): Promise<{ completedCount: number; totalCount: number } | null> {
  const sql = getSql();
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

export async function getStepEventsForReview(reviewId: string) {
  const sql = getSql();
  const rows = await sql`
    SELECT *
    FROM review_step_events
    WHERE review_id = ${reviewId}::uuid
    ORDER BY created_at ASC
  `;
  return rows;
}
