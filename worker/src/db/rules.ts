/**
 * Rules Database Access Layer
 *
 * All operations on the `rules` and `rule_relationships` tables.
 * This module ONLY does DB queries. No business logic, no LLM, no GitHub.
 */

import { getDb } from './client.js';
import type { Rule, RuleStatus, RuleRelationshipRecord, RulePriority, RuleMode } from '@parakh/shared';
import { EMBEDDING_DIMENSIONS } from '@parakh/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

interface EnvWithDB {
  DATABASE_URL: string;
}

// ─── Rule Queries ────────────────────────────────────────────────────────────

/**
 * Get all active rules for a repo, optionally filtered by file path scope.
 * This is the primary retrieval query:
 *   WHERE status = 'ACTIVE' AND repo = $1
 * That single WHERE clause is the entire "don't apply old rules" guarantee.
 */
export async function getActiveRules(
  repo: string,
  env: EnvWithDB,
  _filePath?: string
): Promise<Rule[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, repo, body, status, scope, priority, mode, patterns,
           supersedes, superseded_by, source_pr, evidence_count,
           reinforcement_count, created_at, superseded_at
    FROM rules
    WHERE status = 'ACTIVE' AND repo = ${repo}
    ORDER BY created_at ASC
  `;

  return rows as unknown as Rule[];
}

/**
 * Get a single rule by ID.
 * Used in review.ts to look up rule priority for severity resolution.
 */
export async function getRuleById(
  id: string,
  env: EnvWithDB
): Promise<Rule | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, repo, body, status, scope, priority, mode, patterns,
           supersedes, superseded_by, source_pr, evidence_count,
           reinforcement_count, created_at, superseded_at
    FROM rules
    WHERE id = ${id}
  `;

  return (rows[0] as unknown as Rule) || null;
}

/**
 * Insert a new rule with its embedding.
 */
export async function insertRule(
  rule: {
    repo: string;
    body: string;
    embedding: number[];
    status: RuleStatus;
    scope?: Record<string, unknown>;
    priority?: RulePriority;
    mode?: RuleMode;
    patterns?: string[];
    source_pr?: number;
  },
  env: EnvWithDB
): Promise<Rule> {
  // Fail-fast dimension guard: the rules.embedding column is vector(768), so
  // any other width would only fail inside Neon at runtime. Validate here so
  // provider/embedding mismatches (e.g. a 1024-dim model) surface as a clear
  // error at the point of insert instead of a Neon "expected 768 dimensions".
  if (rule.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `[rules] Embedding dimension mismatch: got ${rule.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`
    );
  }
  const sql = getDb(env.DATABASE_URL);
  const embeddingStr = `[${rule.embedding.join(',')}]`;
  const rows = await sql`
    INSERT INTO rules (repo, body, embedding, status, scope, priority, mode, patterns, source_pr)
    VALUES (
      ${rule.repo},
      ${rule.body},
      ${embeddingStr}::vector,
      ${rule.status},
      ${JSON.stringify(rule.scope || {})}::jsonb,
      ${rule.priority || 'normal'},
      ${rule.mode || 'enforce'},
      ${JSON.stringify(rule.patterns || [])}::jsonb,
      ${rule.source_pr || null}
    )
    RETURNING id, repo, body, status, scope, priority, mode, patterns,
              supersedes, superseded_by, source_pr, evidence_count,
              reinforcement_count, created_at, superseded_at
  `;

  return rows[0] as unknown as Rule;
}

/**
 * Update a rule's status.
 * Used by contradiction engine for SUPERSEDED/INACTIVE transitions.
 */
export async function updateRuleStatus(
  id: string,
  status: RuleStatus,
  env: EnvWithDB,
  supersededBy?: string
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);

  if (status === 'SUPERSEDED' && supersededBy) {
    await sql`
      UPDATE rules
      SET status = ${status},
          superseded_by = ${supersededBy}::uuid,
          superseded_at = now()
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE rules
      SET status = ${status}
      WHERE id = ${id}
    `;
  }
}

/**
 * Set the supersedes FK on a rule (new rule supersedes old rule).
 */
export async function setRuleSupersedes(
  newRuleId: string,
  oldRuleId: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE rules
    SET supersedes = ${oldRuleId}::uuid
    WHERE id = ${newRuleId}
  `;
}

/**
 * Find similar active rules using pgvector cosine similarity.
 * Used by the contradiction engine to find candidates for relationship classification.
 */
export async function findSimilarRules(
  repo: string,
  embedding: number[],
  threshold: number,
  limit: number,
  env: EnvWithDB,
  excludeRuleId?: string
): Promise<(Rule & { similarity: number })[]> {
  const sql = getDb(env.DATABASE_URL);
  const embeddingStr = `[${embedding.join(',')}]`;

  const rows = await sql`
    SELECT id, repo, body, status, scope, priority, mode, patterns,
           supersedes, superseded_by, source_pr, evidence_count,
           reinforcement_count, created_at, superseded_at,
           1 - (embedding <=> ${embeddingStr}::vector) as similarity
    FROM rules
    WHERE status = 'ACTIVE'
      AND repo = ${repo}
      AND embedding IS NOT NULL
      AND (${excludeRuleId}::uuid IS NULL OR id != ${excludeRuleId}::uuid)
      AND 1 - (embedding <=> ${embeddingStr}::vector) > ${threshold}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  return rows as unknown as (Rule & { similarity: number })[];
}

/**
 * Increment evidence_count — called per violation instance during a review.
 * NOT per review, per finding. "How many times this rule was actually violated."
 */
export async function incrementEvidenceCount(
  id: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE rules
    SET evidence_count = evidence_count + 1
    WHERE id = ${id}
  `;
}

/**
 * Increment reinforcement_count — called when a DUPLICATE correction is received.
 * "How many times someone re-taught us something we already knew."
 */
export async function incrementReinforcementCount(
  id: string,
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    UPDATE rules
    SET reinforcement_count = reinforcement_count + 1
    WHERE id = ${id}
  `;
}

// ─── Rule Relationships ──────────────────────────────────────────────────────

/**
 * Insert a relationship record (DUPLICATE or REFINEMENT).
 * Direction convention: from_rule_id = newer, to_rule_id = existing.
 */
export async function insertRuleRelationship(
  fromRuleId: string,
  toRuleId: string,
  relationship: 'DUPLICATE' | 'REFINEMENT',
  env: EnvWithDB
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await sql`
    INSERT INTO rule_relationships (from_rule_id, to_rule_id, relationship)
    VALUES (${fromRuleId}::uuid, ${toRuleId}::uuid, ${relationship})
    ON CONFLICT (from_rule_id, to_rule_id) DO NOTHING
  `;
}

/**
 * Get the supersession chain for a rule.
 * Walks the supersedes/superseded_by FKs to build the full chain.
 * Returns rules in order: oldest → newest.
 */
export async function getSupersessionChain(
  ruleId: string,
  env: EnvWithDB
): Promise<Rule[]> {
  const sql = getDb(env.DATABASE_URL);

  // Recursive CTE to walk the chain in both directions
  const rows = await sql`
    WITH RECURSIVE chain AS (
      -- Start from the given rule
      SELECT id, repo, body, status, scope, priority, mode, patterns,
             supersedes, superseded_by, source_pr, evidence_count,
             reinforcement_count, created_at, superseded_at
      FROM rules WHERE id = ${ruleId}

      UNION ALL

      -- Walk backwards (older rules that this one supersedes)
      SELECT r.id, r.repo, r.body, r.status, r.scope, r.priority, r.mode, r.patterns,
             r.supersedes, r.superseded_by, r.source_pr, r.evidence_count,
             r.reinforcement_count, r.created_at, r.superseded_at
      FROM rules r
      INNER JOIN chain c ON r.id = c.supersedes

      UNION ALL

      -- Walk forwards (newer rules that supersede this one)
      SELECT r.id, r.repo, r.body, r.status, r.scope, r.priority, r.mode, r.patterns,
             r.supersedes, r.superseded_by, r.source_pr, r.evidence_count,
             r.reinforcement_count, r.created_at, r.superseded_at
      FROM rules r
      INNER JOIN chain c ON r.id = c.superseded_by
    )
    SELECT DISTINCT ON (id) * FROM chain ORDER BY id, created_at ASC
  `;

  return rows as unknown as Rule[];
}

/**
 * Get all relationships involving a rule.
 * Queries BOTH directions: from_rule_id = $1 OR to_rule_id = $1
 * so the dashboard never silently misses edges.
 */
export async function getRuleRelationships(
  ruleId: string,
  env: EnvWithDB
): Promise<RuleRelationshipRecord[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await sql`
    SELECT id, from_rule_id, to_rule_id, relationship, created_at
    FROM rule_relationships
    WHERE from_rule_id = ${ruleId}::uuid OR to_rule_id = ${ruleId}::uuid
    ORDER BY created_at DESC
  `;

  return rows as unknown as RuleRelationshipRecord[];
}
