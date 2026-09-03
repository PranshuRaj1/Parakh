import type {
  AdjudicationOutcome,
  JudgeVerdict,
} from './types.js';

export function verdictsDisagree(verdicts: JudgeVerdict[]): boolean {
  if (verdicts.length < 2) return false;
  const first = verdicts[0];
  return verdicts.slice(1).some((verdict) =>
    verdict.defectExists !== first.defectExists
    || verdict.matchedDefectId !== first.matchedDefectId
    || verdict.correctness !== first.correctness
    || (verdict.unsupportedClaim !== first.unsupportedClaim
      && !(verdict.defectExists === false && first.defectExists === false
        && verdict.correctness === 0 && first.correctness === 0))
  );
}
export function adjudicateVerdicts(
  verdicts: JudgeVerdict[],
  matchedDefectIds: ReadonlySet<string> = new Set()
): AdjudicationOutcome {
  if (verdicts.length === 0 || verdictsDisagree(verdicts)) return 'needs_human_review';

  const verdict = verdicts[0];
  if (verdict.unsupportedClaim) return 'unsupported';
  if (verdict.matchedDefectId && matchedDefectIds.has(verdict.matchedDefectId)) {
    return 'duplicate';
  }
  if (!verdict.defectExists && verdict.correctness === 0 && !verdict.matchedDefectId) {
    return 'incorrect';
  }
  if (verdict.defectExists && verdict.correctness === 2 && verdict.matchedDefectId) {
    return 'correct';
  }
  if (verdict.defectExists && verdict.correctness === 1) {
    return 'partially_correct';
  }
  if (verdict.defectExists && verdict.correctness === 2 && !verdict.matchedDefectId) {
    return 'valid_unlisted';
  }
  return 'needs_human_review';
}
