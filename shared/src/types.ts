// ─── Enums ───────────────────────────────────────────────────────────────────

/** Rule lifecycle status. SUGGESTED is cut from v1 — named future extension for auto-suggestion. */
export type RuleStatus = 'ACTIVE' | 'SUPERSEDED' | 'INACTIVE';

/** Rule priority — determines severity weight for violations. */
export type RulePriority = 'high' | 'normal';

/** Finding severity taxonomy. Gemini classifies generic findings; code assigns rule-violation severity. */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Review lifecycle status. */
export type ReviewStatus = 'SEEN' | 'REVIEWING' | 'COMPLETED';

/** Intent classification for reply comments. */
export type Intent = 'CORRECTION' | 'EXPLANATION' | 'DISMISSAL' | 'QUESTION';

/** Relationship between two rules, determined by contradiction engine. */
export type Relationship = 'DUPLICATE' | 'REFINEMENT' | 'CONTRADICTION' | 'UNRELATED';

// ─── Database Entities ───────────────────────────────────────────────────────

export interface Rule {
  id: string;
  repo: string;
  body: string;
  embedding: number[] | null;
  status: RuleStatus;
  scope: Record<string, unknown>;
  priority: RulePriority;
  supersedes: string | null;
  superseded_by: string | null;
  source_pr: number | null;
  /** Number of individual violation instances across reviews. Incremented per-finding, not per-review. */
  evidence_count: number;
  /** Number of duplicate correction attempts (DUPLICATE branch in contradiction engine). */
  reinforcement_count: number;
  created_at: string;
  superseded_at: string | null;
}

export interface Review {
  id: string;
  repo: string;
  pr_number: number;
  score: number | null;
  findings: Finding[] | null;
  seen_reaction_id: number | null;
  verdict_reaction_id: number | null;
  status: ReviewStatus;
  created_at: string;
}

export interface RuleRelationshipRecord {
  id: string;
  from_rule_id: string;
  to_rule_id: string;
  relationship: 'DUPLICATE' | 'REFINEMENT';
  created_at: string;
}

// ─── Finding Types ───────────────────────────────────────────────────────────

/**
 * Final finding shape — fully resolved, ready for scoring.
 * Both generic findings and rule-violation findings are merged into this shape
 * after severity has been determined (by LLM or by code, respectively).
 */
export interface Finding {
  severity: Severity;
  file: string;
  line: number;
  body: string;
  suggestion: string | null;
  /** Present only for rule-violation findings. */
  rule_id: string | null;
}

/**
 * Raw generic finding from Gemini — severity is LLM-assigned.
 * No rule_id because this finding isn't tied to a stored rule.
 */
export interface RawGenericFinding {
  severity: Severity;
  file: string;
  line: number;
  body: string;
  suggestion: string | null;
}

/**
 * Raw rule-violation finding from Gemini — NO severity field.
 * Severity is computed in code from the matched rule's priority via
 * resolveSeverityForRuleViolation(). This is the structural enforcement
 * of the determinism guarantee: severity literally isn't in the schema
 * the LLM returns into.
 */
export interface RawRuleFinding {
  file: string;
  line: number;
  body: string;
  suggestion: string | null;
  rule_id: string;
}

// ─── Queue Job Payloads ──────────────────────────────────────────────────────

export interface ReviewJobPayload {
  type: 'REVIEW';
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: string;
}

export interface CorrectionJobPayload {
  type: 'CORRECTION';
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commentBody: string;
  parentCommentBody: string;
}

export interface ContradictionJobPayload {
  type: 'CONTRADICTION';
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  ruleId: string;
  ruleBody: string;
  embedding: number[];
}

export type JobPayload = ReviewJobPayload | CorrectionJobPayload | ContradictionJobPayload;

// ─── Worker API Types ────────────────────────────────────────────────────────

/** Request body for POST /api/rules on the worker (called by dashboard). */
export interface CreateRuleRequest {
  repo: string;
  body: string;
  scope?: Record<string, unknown>;
  priority?: RulePriority;
}

/** Response from POST /api/rules on the worker. */
export interface CreateRuleResponse {
  rule: Rule;
  contradictionCheckEnqueued: boolean;
}
