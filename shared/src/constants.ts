import type { Severity } from './types.js';

// ─── Severity Taxonomy ───────────────────────────────────────────────────────

/**
 * Severity definitions with examples — used verbatim in Gemini review prompts.
 * This is the single source of truth for what each severity bucket means.
 */
export const SEVERITY_TAXONOMY: Record<Severity, { weight: number; definition: string; examples: string }> = {
  CRITICAL: {
    weight: -2.5,
    definition: 'Security vulnerability, data loss, breaks production on the happy path',
    examples: 'IDOR, missing auth check, unhandled exception on core flow',
  },
  HIGH: {
    weight: -1.25,
    definition: 'Logic bug hit in normal usage, or violates an ACTIVE rule tagged priority: high',
    examples: 'Off-by-one in pagination, race condition, security-tagged convention violated',
  },
  MEDIUM: {
    weight: -0.5,
    definition: 'Edge-case bug, weak error handling, perf issue, or violates a normal-priority ACTIVE rule',
    examples: 'Unbounded loop, missing null check on rare input, standard convention violated',
  },
  LOW: {
    weight: -0.1,
    definition: 'Style, naming, readability',
    examples: 'Unclear variable name, missing comment',
  },
};

// ─── Score Thresholds ────────────────────────────────────────────────────────

/** Score at or above this → 👍 verdict reaction. */
export const POSITIVE_THRESHOLD = 4.0;

/** Score below this → 👎 verdict reaction. */
export const NEGATIVE_THRESHOLD = 2.5;

// ─── Reaction Emojis ─────────────────────────────────────────────────────────

/** GitHub reaction content values used in the emoji state machine. */
export const REACTIONS = {
  SEEN: '+1' as const,
  POSITIVE: '+1' as const,
  NEGATIVE: '-1' as const,
};

// ─── Rate Limiting ───────────────────────────────────────────────────────────

/** Gemini free-tier rate limits (conservative estimates). */
export const GEMINI_RATE_LIMITS = {
  /** Max requests per minute for generative model. */
  GENERATION_RPM: 15,
  /** Max requests per minute for embedding model. */
  EMBEDDING_RPM: 1500,
  /** Delay between per-file review calls in ms. */
  PER_FILE_DELAY_MS: 4000,
};

// ─── Stuck Detection & Recovery ──────────────────────────────────────────────

/** Maximum retries before marking FAILED. Checked as: retry_count >= MAX_REVIEW_RETRIES. */
export const MAX_REVIEW_RETRIES = 1;

/** Default stuck timeout in seconds (overridable per-repo via repo_settings.stuck_timeout_seconds). */
export const DEFAULT_STUCK_TIMEOUT_SECONDS = 30;

/** TTL for Redis review state keys. Prevents abandoned PRs from holding state forever. */
export const REVIEW_STATE_TTL_SECONDS = 48 * 60 * 60; // 48 hours

/** TTL for Redis session lock. Short — just long enough to survive a cold-start race. */
export const REVIEW_LOCK_TTL_SECONDS = 300; // 5 minutes

/** Max files per Gemini batch within one worker invocation. */
export const MAX_FILES_PER_BATCH = 5;

// ─── Contradiction Engine ────────────────────────────────────────────────────

/** Cosine similarity threshold for candidate retrieval in contradiction check. */
export const CONTRADICTION_SIMILARITY_THRESHOLD = 0.7;

/** Max candidates to retrieve from pgvector for contradiction check. */
export const CONTRADICTION_MAX_CANDIDATES = 5;

// ─── GitHub App ──────────────────────────────────────────────────────────────

/** GitHub App bot username suffix — used to identify bot comments. */
export const GITHUB_APP_BOT_SUFFIX = '[bot]';

/** Installation token cache TTL buffer — cache expires this many seconds before actual expiry. */
export const TOKEN_CACHE_BUFFER_SECONDS = 300;
