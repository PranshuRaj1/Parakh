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
