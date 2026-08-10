import type { Severity, Finding, RulePriority } from './types.js';

// ─── Severity Scoring ────────────────────────────────────────────────────────

/**
 * Linear, UNCAPPED weight per high-severity level. Real defects (security,
 * correctness, data loss) should be able to tank a score — the 1st CRITICAL
 * hurts exactly as much as the 3rd. Penalty = |weight| per finding.
 */
export const SEVERITY_WEIGHTS: Record<'CRITICAL' | 'HIGH', number> = {
  CRITICAL: -2.5,
  HIGH: -1.25,
};

/**
 * Exponential saturation curve for noise-prone severities. A flood of MEDIUM
 * and LOW findings decays instead of subtracting forever, so a PR full of
 * style nits bottoms out near max(MEDIUM)+max(LOW) instead of driving the
 * score to 0.
 *
 *   penalty(count) = max * (1 − e^(−count/k))
 *
 * Tuning lives here — one named constant, trivial to adjust.
 */
export const SEVERITY_SATURATION: Record<'MEDIUM' | 'LOW', { max: number; k: number }> = {
  MEDIUM: { max: 1.5, k: 4 },
  LOW: { max: 0.4, k: 5 },
};

/**
 * Deterministic mapping from rule priority to the severity assigned to its violations.
 * This is the code-level enforcement: rule violations never get LLM-assigned severity.
 *
 *   priority: 'high'   → severity: 'HIGH'   → linear weight: -1.25
 *   priority: 'normal' → severity: 'MEDIUM'  → saturated curve (max 1.5, k 4)
 */
export const PRIORITY_TO_SEVERITY: Record<RulePriority, Severity> = {
  high: 'HIGH',
  normal: 'MEDIUM',
};

// ─── Scoring Functions ───────────────────────────────────────────────────────

/** Penalty of a count against a saturation curve; 0 for non-positive counts. */
function saturationPenalty(
  count: number,
  { max, k }: { max: number; k: number }
): number {
  if (count <= 0) return 0;
  return max * (1 - Math.exp(-count / k));
}

/**
 * Compute raw score from an array of fully-resolved findings.
 * Pure arithmetic — no LLM, no network, no side effects.
 *
 * Formula: clamp(5 − Σ penalty, 0, 5) where
 *   CRITICAL/HIGH are linear and uncapped,
 *   MEDIUM/LOW follow SEVERITY_SATURATION (exponential decay).
 *
 * @example
 * // 1 HIGH + 2 LOW → 5 - 1.25 - sat(2) = 3.678...
 * computeScore([{severity:'HIGH',...}, {severity:'LOW',...}, {severity:'LOW',...}])
 */
export function computeScore(findings: Finding[]): number {
  const counts: Record<Severity, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  };
  for (const f of findings) counts[f.severity]++;

  const penalty =
    counts.CRITICAL * -SEVERITY_WEIGHTS.CRITICAL +
    counts.HIGH * -SEVERITY_WEIGHTS.HIGH +
    saturationPenalty(counts.MEDIUM, SEVERITY_SATURATION.MEDIUM) +
    saturationPenalty(counts.LOW, SEVERITY_SATURATION.LOW);

  return Math.max(0, Math.min(5, 5 - penalty));
}

/**
 * Round a raw score to the nearest 0.1 for display. Tenths give PRs nuance
 * (4.5 / 4.7) without the visual noise of arbitrary precision.
 *
 * @example
 * displayScore(4.9275)  // 4.9
 * displayScore(3.678)   // 3.7
 * displayScore(4.64)    // 4.6
 */
export function displayScore(raw: number): number {
  return Math.round(raw * 10) / 10;
}

/**
 * Normalize a finding body for duplicate comparison: lowercase, strip
 * non-alphanumerics, collapse whitespace, cap length. Two phrasings of the
 * same issue ("No newline at end of file" vs "missing newline at EOF") map to
 * the same key so generic + rule-violation duplicates collapse.
 */
export function normalizeMessage(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/**
 * Dedupe findings keyed on (file, line, normalized body). On collision, keep
 * the higher-severity finding.
 *
 * This is the primary fix for double-counting: the same issue frequently
 * arrives as BOTH a generic finding and a rule violation (and sometimes twice
 * within one array). Summed naively it would be counted 2–3x toward the score.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${normalizeMessage(f.body)}`;
    const existing = seen.get(key);
    if (!existing || SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
      seen.set(key, f);
    }
  }
  return Array.from(seen.values());
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
