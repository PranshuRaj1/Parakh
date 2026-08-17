import type { Env } from '../index.js';

/**
 * Feature switches for the staged behavior-first review rollout.
 *
 * These switches are deliberately inert in the foundation release. Keeping
 * parsing in one module prevents later pipeline stages from inventing subtly
 * different defaults or truthiness rules.
 */
export interface FeatureFlags {
  semanticDiff: boolean;
  behaviorGrouping: boolean;
  behaviorGroupingShadow: boolean;
  groupedReviewOutput: boolean;
  stalenessCheck: boolean;
  deterministicAnalysis: boolean;
  incrementalReview: boolean;
  incrementalReviewShadow: boolean;
  /** Fetch the full file at head SHA and inject it as verification context for the review prompt. */
  reviewFileContext: boolean;
  /**
   * Inject a deterministic attention-focus block into review prompts: anchor
   * files that carried prior findings (incremental), falling back to the raw
   * PR title/description when no prior findings exist (first-time reviews).
   */
  attentionFocus: boolean;
  /** Cap per-file raw diffs before they reach the model (large-codebase viability). */
  boundedRawDiffs: boolean;
  /**
   * Phase 4: one LLM review-start call reads the execution diff and produces
   * the attention focus (validated + bounded, deterministic fallback on failure).
   */
  reviewStartFocus: boolean;
}

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = Object.freeze({
  semanticDiff: false,
  behaviorGrouping: false,
  behaviorGroupingShadow: true,
  groupedReviewOutput: false,
  stalenessCheck: false,
  deterministicAnalysis: false,
  incrementalReview: false,
  incrementalReviewShadow: true,
  reviewFileContext: false,
  attentionFocus: false,
  boundedRawDiffs: false,
  reviewStartFocus: false,
});

function parseBooleanFlag(
  name: string,
  rawValue: string | undefined,
  fallback: boolean
): boolean {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const value = rawValue.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Log only the flag name and safe fallback. Never serialize the Env object:
  // it also contains credentials for GitHub, Redis, Neon, and LLM providers.
  console.warn(`[config] Invalid boolean for ${name}; using default ${fallback}`);
  return fallback;
}

/** Parse a fresh immutable snapshot for one Worker invocation. */
export function getFeatureFlags(env: Env): FeatureFlags {
  const flags: FeatureFlags = {
    semanticDiff: parseBooleanFlag(
      'SEMANTIC_DIFF_ENABLED',
      env.SEMANTIC_DIFF_ENABLED,
      DEFAULT_FEATURE_FLAGS.semanticDiff
    ),
    behaviorGrouping: parseBooleanFlag(
      'BEHAVIOR_GROUPING_ENABLED',
      env.BEHAVIOR_GROUPING_ENABLED,
      DEFAULT_FEATURE_FLAGS.behaviorGrouping
    ),
    behaviorGroupingShadow: parseBooleanFlag(
      'BEHAVIOR_GROUPING_SHADOW',
      env.BEHAVIOR_GROUPING_SHADOW,
      DEFAULT_FEATURE_FLAGS.behaviorGroupingShadow
    ),
    groupedReviewOutput: parseBooleanFlag(
      'GROUPED_REVIEW_OUTPUT_ENABLED',
      env.GROUPED_REVIEW_OUTPUT_ENABLED,
      DEFAULT_FEATURE_FLAGS.groupedReviewOutput
    ),
    stalenessCheck: parseBooleanFlag(
      'STALENESS_CHECK_ENABLED',
      env.STALENESS_CHECK_ENABLED,
      DEFAULT_FEATURE_FLAGS.stalenessCheck
    ),
    deterministicAnalysis: parseBooleanFlag(
      'DETERMINISTIC_ANALYSIS_ENABLED',
      env.DETERMINISTIC_ANALYSIS_ENABLED,
      DEFAULT_FEATURE_FLAGS.deterministicAnalysis
    ),
    incrementalReview: parseBooleanFlag(
      'INCREMENTAL_REVIEW_ENABLED',
      env.INCREMENTAL_REVIEW_ENABLED,
      DEFAULT_FEATURE_FLAGS.incrementalReview
    ),
    incrementalReviewShadow: parseBooleanFlag(
      'INCREMENTAL_REVIEW_SHADOW',
      env.INCREMENTAL_REVIEW_SHADOW,
      DEFAULT_FEATURE_FLAGS.incrementalReviewShadow
    ),
    reviewFileContext: parseBooleanFlag(
      'REVIEW_FILE_CONTEXT_ENABLED',
      env.REVIEW_FILE_CONTEXT_ENABLED,
      DEFAULT_FEATURE_FLAGS.reviewFileContext
    ),
    attentionFocus: parseBooleanFlag(
      'ATTENTION_FOCUS_ENABLED',
      env.ATTENTION_FOCUS_ENABLED,
      DEFAULT_FEATURE_FLAGS.attentionFocus
    ),
    boundedRawDiffs: parseBooleanFlag(
      'BOUNDED_RAW_DIFFS_ENABLED',
      env.BOUNDED_RAW_DIFFS_ENABLED,
      DEFAULT_FEATURE_FLAGS.boundedRawDiffs
    ),
    reviewStartFocus: parseBooleanFlag(
      'REVIEW_START_FOCUS_ENABLED',
      env.REVIEW_START_FOCUS_ENABLED,
      DEFAULT_FEATURE_FLAGS.reviewStartFocus
    ),
  };

  // Rendering grouped output without a group plan would be unsafe. Fail
  // closed rather than letting a configuration typo alter review output.
  if (flags.groupedReviewOutput && !flags.behaviorGrouping) {
    console.warn(
      '[config] GROUPED_REVIEW_OUTPUT_ENABLED requires BEHAVIOR_GROUPING_ENABLED; disabling grouped output'
    );
    flags.groupedReviewOutput = false;
  }

  return Object.freeze(flags);
}
