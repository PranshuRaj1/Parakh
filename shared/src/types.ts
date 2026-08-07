// ─── Enums ───────────────────────────────────────────────────────────────────

/** Rule lifecycle status. SUGGESTED is cut from v1 — named future extension for auto-suggestion. */
export type RuleStatus = 'ACTIVE' | 'SUPERSEDED' | 'INACTIVE';

/** Rule priority — determines severity weight for violations. */
export type RulePriority = 'high' | 'normal';

/** Finding severity taxonomy. Gemini classifies generic findings; code assigns rule-violation severity. */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Review lifecycle status. REVIEWING removed in v4 — replaced by RUNNING with step tracking. */
export type ReviewStatus = 'SEEN' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PAUSED_RATE_LIMITED';

/** Intent classification for reply comments. */
export type Intent = 'CORRECTION' | 'EXPLANATION' | 'DISMISSAL' | 'QUESTION' | 'REVIEW_REQUEST' | 'GENERAL';

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
  repo: string;                    // "owner/repo" — combined field
  pr_number: number;
  installation_id: number | null;  // stored for watchdog resume
  score: number | null;
  findings: Finding[] | null;
  seen_reaction_id: number | null;
  verdict_reaction_id: number | null;
  status: ReviewStatus;
  trigger_reason: 'opened' | 'synchronize' | 'manual_mention' | 'auto_retry';
  retry_count: number;
  current_step: string | null;
  step_detail: Record<string, unknown> | null;
  started_at: string | null;
  failed_at: string | null;
  error_step: string | null;
  error_message: string | null;
  error_stack: string | null;
  github_delivery_id: string | null;
  created_at: string;
}

export interface RepoSettings {
  repo: string;
  reply_mode: 'mentioned_only' | 'all_comments';
  stuck_timeout_seconds: number | null;
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

export interface CommentJobPayload {
  type: 'COMMENT_RESPONSE';
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commentBody: string;
  commentType: 'issue_comment' | 'pull_request_review_comment';
  githubDeliveryId: string;
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

/** Watchdog queue payload — scheduled by progress.ts, consumed by watchdog.ts. */
export interface WatchdogPayload {
  type: 'WATCHDOG';
  reviewId: string;
  step: string;
  expectedEventId: string;
}

export type JobPayload = ReviewJobPayload | CommentJobPayload | ContradictionJobPayload | WatchdogPayload;

/** Step event audit record — append-only log of review pipeline progress. */
export interface ReviewStepEvent {
  id: string;
  review_id: string;
  step: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED';
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  created_at: string;
}

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
