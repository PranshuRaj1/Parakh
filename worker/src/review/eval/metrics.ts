import { verdictsDisagree } from './adjudication.js';
import { assertComparableRuns } from './runner.js';
import type {
  CaseComparison,
  CaseMetrics,
  EvalDefect,
  EvalRun,
  FindingAdjudication,
  NoiseFloor,
} from './types.js';

const SEVERITY_WEIGHTS = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
} as const;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : right - left;
}

export function computeCaseMetrics(input: {
  run: EvalRun;
  defects: EvalDefect[];
  adjudications: FindingAdjudication[];
}): CaseMetrics {
  const resolved = input.adjudications.filter(
    (item) => item.outcome !== 'needs_human_review'
  );
  const known = resolved.filter(
    (item) => item.outcome !== 'duplicate' && item.outcome !== 'valid_unlisted'
  );
  const correct = known.filter((item) => item.outcome === 'correct');
  const defectIds = new Set(input.defects.map((defect) => defect.id));
  const matchedIds = new Set(
    correct
      .map((item) => item.matchedDefectId)
      .filter((id): id is string => id !== null && defectIds.has(id))
  );
  const knownPrecision = ratio(correct.length, known.length);
  const recall = input.defects.length === 0
    ? null
    : matchedIds.size / input.defects.length;
  const strictF1 = recall === null
    ? null
    : ratio(2 * knownPrecision * recall, knownPrecision + recall);
  const totalWeight = input.defects.reduce(
    (sum, defect) => sum + SEVERITY_WEIGHTS[defect.severity],
    0
  );
  const matchedWeight = input.defects
    .filter((defect) => matchedIds.has(defect.id))
    .reduce((sum, defect) => sum + SEVERITY_WEIGHTS[defect.severity], 0);
  const heldOutCount = input.adjudications.length - resolved.length;
  const incorrect = known.filter(
    (item) => item.outcome === 'incorrect' || item.outcome === 'unsupported'
  ).length;
  const strictFalsePositives = input.run.isNegativeControl
    ? resolved.filter((item) => item.outcome !== 'duplicate').length
    : incorrect;
  const relaxedFalsePositives = input.run.isNegativeControl
    ? known.length
    : incorrect;

  return {
    caseId: input.run.caseId,
    pipeline: input.run.pipeline,
    knownPrecision,
    recall,
    strictF1,
    weightedRecall: totalWeight === 0 ? null : matchedWeight / totalWeight,
    strictFalsePositives,
    relaxedFalsePositives,
    unsupportedRate: ratio(
      known.filter((item) => item.outcome === 'unsupported').length,
      known.length
    ),
    duplicateRate: ratio(
      resolved.filter((item) => item.outcome === 'duplicate').length,
      resolved.length
    ),
    partialRate: ratio(
      known.filter((item) => item.outcome === 'partially_correct').length,
      known.length
    ),
    judgeDisagreementRate: ratio(
      input.adjudications.filter((item) => verdictsDisagree(item.verdicts)).length,
      input.adjudications.length
    ),
    heldOutCount,
    heldOutRate: ratio(heldOutCount, input.adjudications.length),
    latencyMs: input.run.latencyMs,
    inputTokens: input.run.output.inputTokens,
    outputTokens: input.run.output.outputTokens,
    providerCalls: input.run.output.providerCalls,
    retrieval: input.run.output.retrieval,
  };
}

export function compareCaseMetrics(
  oldMetrics: CaseMetrics,
  newMetrics: CaseMetrics
): CaseComparison {
  if (oldMetrics.caseId !== newMetrics.caseId) {
    throw new Error(
      `Cannot compare metrics for ${oldMetrics.caseId} and ${newMetrics.caseId}`
    );
  }
  return {
    caseId: oldMetrics.caseId,
    oldMetrics,
    newMetrics,
    precisionDelta: newMetrics.knownPrecision - oldMetrics.knownPrecision,
    recallDelta: delta(oldMetrics.recall, newMetrics.recall),
    f1Delta: delta(oldMetrics.strictF1, newMetrics.strictF1),
    weightedRecallDelta: delta(
      oldMetrics.weightedRecall,
      newMetrics.weightedRecall
    ),
    falsePositiveDelta:
      newMetrics.strictFalsePositives - oldMetrics.strictFalsePositives,
    latencyDeltaMs: newMetrics.latencyMs - oldMetrics.latencyMs,
  };
}

function findingKeys(run: EvalRun): Set<string> {
  return new Set(run.output.finalFindings.map((finding) =>
    JSON.stringify({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      body: finding.body.trim().replace(/\s+/g, ' ').toLowerCase(),
      suggestion: finding.suggestion?.trim().replace(/\s+/g, ' ').toLowerCase() ?? null,
      ruleId: finding.rule_id,
    })
  ));
}

export function computeNoiseFloor(input: {
  firstRun: EvalRun;
  secondRun: EvalRun;
  firstMetrics: CaseMetrics;
  secondMetrics: CaseMetrics;
}): NoiseFloor {
  assertComparableRuns(input.firstRun, input.secondRun);
  if (input.firstRun.pipeline.resolvedSha !== input.secondRun.pipeline.resolvedSha) {
    throw new Error('Noise-floor runs must use the same pipeline SHA');
  }
  const first = findingKeys(input.firstRun);
  const second = findingKeys(input.secondRun);
  const union = new Set([...first, ...second]);
  const intersection = [...first].filter((key) => second.has(key)).length;
  return {
    pipeline: input.firstRun.pipeline,
    reviewerDisagreementRate: union.size === 0
      ? 0
      : 1 - intersection / union.size,
    precisionDelta:
      input.secondMetrics.knownPrecision - input.firstMetrics.knownPrecision,
    recallDelta: delta(input.firstMetrics.recall, input.secondMetrics.recall),
    f1Delta: delta(input.firstMetrics.strictF1, input.secondMetrics.strictF1),
    falsePositiveDelta:
      input.secondMetrics.strictFalsePositives
      - input.firstMetrics.strictFalsePositives,
  };
}
