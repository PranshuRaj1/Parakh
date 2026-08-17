/**
 * Deterministic cosmetic-severity capping for generic findings.
 *
 * Cosmetic families (extract-function, add-comment, rename, documentation
 * nits) are model-assigned MEDIUM far too often — "Consider extracting a
 * function" and "add a comment explaining MAX_REPLY_DEPTH" both scored MEDIUM
 * on PR #25, saturating ~0.95 points off the score. This module pins those
 * families to LOW by pattern match so the model can't inflate them. It is
 * purely cosmetic — rule-sourced findings are already deterministic by
 * construction and are never touched here.
 */

import type { Finding, Severity } from '@parakh/shared';

const COSMETIC_PATTERNS: RegExp[] = [
  /consider extracting/i,
  /extract (?:a|this into a|the) function/i,
  /extract (?:this|it) into/i,
  /add a comment explaining/i,
  /consider adding a comment/i,
  /add (?:a |an )?(?:comment|docblock|jsdoc)/i,
  /could be more descriptive/i,
  /renam/i,
  /consider documenting/i,
  /add documentation/i,
  /document (?:this|the|that|it)\b/i,
  /jsdoc/i,
];

/** True when a finding body belongs to a cosmetic family capped at LOW. */
export function isCosmeticFinding(body: string): boolean {
  return COSMETIC_PATTERNS.some((re) => re.test(body));
}

/**
 * Cap cosmetic generic findings at LOW. Rule-sourced findings (rule_id set)
 * keep their deterministic severity. Returns the capped findings and the
 * number of demotions so the pipeline can log the effect.
 */
export function capCosmeticSeverity(
  findings: Finding[]
): { findings: Finding[]; demoted: number } {
  let demoted = 0;
  const capped = findings.map((finding) => {
    if (finding.rule_id === null && finding.severity !== 'LOW' && isCosmeticFinding(finding.body)) {
      demoted += 1;
      return { ...finding, severity: 'LOW' as Severity };
    }
    return finding;
  });
  return { findings: capped, demoted };
}