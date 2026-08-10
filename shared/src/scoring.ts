import type { Severity, Finding, RulePriority } from './types.js';

// ─── Severity Weights ────────────────────────────────────────────────────────

/**
 * Weight per severity level. Used in the scoring formula:
 *   score = clamp(5 − Σ|weight_i|, 0, 5)
 */
export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  CRITICAL: -2.5,
  HIGH: -1.25,
  MEDIUM: -0.5,
  LOW: -0.1,
};

/** Repeated lower-severity findings should not overwhelm the score. */
const SEVERITY_PENALTY_CAPS: Partial<Record<Severity, number>> = {
  MEDIUM: 1.5,
  LOW: 0.4,
};

/**
 * Deterministic mapping from rule priority to the severity assigned to its violations.
 * This is the code-level enforcement: rule violations never get LLM-assigned severity.
 *
 *   priority: 'high'   → severity: 'HIGH'   → weight: -1.25
 *   priority: 'normal' → severity: 'MEDIUM'  → weight: -0.5
 */
export const PRIORITY_TO_SEVERITY: Record<RulePriority, Severity> = {
  high: 'HIGH',
  normal: 'MEDIUM',
};

// ─── Scoring Functions ───────────────────────────────────────────────────────

/**
 * Compute raw score from an array of fully-resolved findings.
 * Pure arithmetic — no LLM, no network, no side effects.
 *
 * Formula: clamp(5 − Σ|weight_i for each finding|, 0, 5)
 *
 * @example
 * // 1 HIGH + 2 LOW → 5 - 1.25 - 0.1 - 0.1 = 3.55
 * computeScore([{severity:'HIGH',...}, {severity:'LOW',...}, {severity:'LOW',...}]) // 3.55
 */
export function computeScore(findings: Finding[]): number {
  const penalties = findings.reduce<Partial<Record<Severity, number>>>((totals, finding) => {
    totals[finding.severity] = (totals[finding.severity] ?? 0) + Math.abs(SEVERITY_WEIGHTS[finding.severity]);
    return totals;
  }, {});
  const penalty = Object.entries(penalties).reduce((sum, [severity, total]) =>
    sum + Math.min(total ?? 0, SEVERITY_PENALTY_CAPS[severity as Severity] ?? Infinity), 0);
  return Math.max(0, Math.min(5, 5 - penalty));
}

/**
 * Round a raw score to the nearest 0.5 for display.
 * Half-points are the only granularity a human will actually read.
 *
 * @example
 * displayScore(3.55)  // 3.5
 * displayScore(4.26)  // 4.5
 * displayScore(4.74)  // 4.5
 * displayScore(4.75)  // 5.0
 */
export function displayScore(raw: number): number {
  return Math.round(raw * 2) / 2;
}

/**
 * Resolve the severity for a rule-violation finding based on the rule's priority.
 * This is the deterministic path — no LLM involved.
 *
 * Called in review.ts during post-processing of RawRuleFinding entries.
 *
 * @example
 * resolveSeverityForRuleViolation('high')   // 'HIGH'
 * resolveSeverityForRuleViolation('normal') // 'MEDIUM'
 */
export function resolveSeverityForRuleViolation(priority: RulePriority): Severity {
  return PRIORITY_TO_SEVERITY[priority];
}
