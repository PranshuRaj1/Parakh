// ─── Enums ───────────────────────────────────────────────────────────────────

/** Rule lifecycle status. SUGGESTED is cut from v1 — named future extension for auto-suggestion. */
export type RuleStatus = 'ACTIVE' | 'SUPERSEDED' | 'INACTIVE';

/** Rule priority — determines severity weight for violations. */
export type RulePriority = 'high' | 'normal';

/**
 * Rule kind — decides how a rule is applied during review:
 * - 'standard': an enforceable coding standard. Violations surface as rule findings.
 * - 'instruction': a suppression directive ("stop flagging X"). Never enforced as a
 *   standard; instead excluded from the enforce list, rendered as a "do NOT report"
 *   hint in the prompt, and matched deterministically to drop findings.
 */
export type RuleKind = 'standard' | 'instruction';

/** Finding severity taxonomy. Gemini classifies generic findings; code assigns rule-violation severity. */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Review lifecycle status. REVIEWING removed in v4 — replaced by RUNNING with stage tracking. */
export type ReviewStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PAUSED_DAILY_QUOTA';

/** Requested and effective review scope. Incremental requests fall back to full until rollout. */
export type ReviewMode = 'incremental' | 'full';

export type ReviewTriggerResult = 'ENQUEUED' | 'RESUMED' | 'ALREADY_ACTIVE' | 'BUSY';

export type ReviewStage = 'QUEUED' | 'AUTHENTICATING' | 'FETCHING_DIFF' | 'LOADING_RULES' | 'REVIEWING_FILES' | 'SCORING' | 'POSTING_COMMENT' | 'REACTING';

export type StageReasonCode = 'PROCESSING' | 'RATE_LIMITED_BACKOFF' | 'RETRYING_AFTER_FAILURE' | 'WAITING_ON_GEMINI' | 'WAITING_ON_GITHUB_API' | 'RETRY_QUEUED';

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
  /** 'standard' (enforce) or 'instruction' (suppress). Defaults to 'standard'. */
  kind?: RuleKind;
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
  current_stage: ReviewStage | null;
  stage_started_at: string | null;
  stage_attempt: number | null;
  stage_reason_code: StageReasonCode | null;
  stage_reason_detail: string | null;
  worker_heartbeat_at: string | null;
  started_at: string | null;
  failed_at: string | null;
  error_step: string | null;
  error_message: string | null;
  error_stack: string | null;
  github_delivery_id: string | null;
  /** When the review may auto-resume after a daily-quota pause (null = not paused). */
  daily_quota_resume_at: string | null;
  /** ID of the comment whose `@parakh review` triggered this review (manual_mention only). */
  trigger_comment_id: number | null;
  /** Where the trigger comment lives: top-level issue comment or inline review comment. */
  trigger_comment_type: 'issue_comment' | 'pull_request_review_comment' | null;
  /** ID of whichever reaction is currently live on the trigger comment (👀, then 👍/👎/😕). */
  trigger_comment_reaction_id: number | null;
  /** Head SHA of the PR captured at review-start — pins the reviewed diff. */
  head_sha: string | null;
  /** Base SHA captured at review-start — used for compare/{base}.../{head} diff. */
  base_sha: string | null;
  requested_review_mode: ReviewMode;
  effective_review_mode: ReviewMode;
  parent_review_id: string | null;
  comparison_base_sha: string | null;
  fallback_reason: string | null;
  active_rules_hash: string | null;
  pipeline_version: string;
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
  requestedMode: ReviewMode;
  effectiveMode: ReviewMode;
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

export type JobPayload = ReviewJobPayload | CommentJobPayload | ContradictionJobPayload;

/**
 * Captured model reasoning (thinking) for a single reviewed file.
 * Stored separately from findings — raw text, dashboard-only, pruned after expiry.
 */
export interface ReviewReasoning {
  id: string;
  review_id: string;
  /** File path this reasoning applies to. */
  file: string;
  /** Model identifier that generated the thinking (e.g. gemini-2.5-flash). */
  model: string | null;
  /** Raw thinking text. May be null when the file call failed before producing thoughts. */
  thinking: string | null;
  /** Set when the file's review call failed (non-rate-limit) — surfaces partial failures. */
  error_message: string | null;
  created_at: string;
  /** Soft retention deadline — pruned from the DB after this. */
  expires_at: string;
}

/** Stage event audit record — append-only log of review pipeline progress. */
export interface ReviewStepEvent {
  id: string;
  review_id: string;
  stage: ReviewStage;
  attempt_number: number;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  outcome: 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | null;
  error_code: string | null;
  error_message: string | null;
  error_stack: string | null;
  reason_transitions: Array<{ code: string; detail: string; at: string }>;
  detail: Record<string, unknown> | null;
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
