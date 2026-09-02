import { describe, expect, it } from 'vitest';
import {
  compareCaseMetrics,
  computeCaseMetrics,
  computeNoiseFloor,
} from './metrics.js';
import type {
  AdjudicationOutcome,
  EvalDefect,
  EvalRun,
  FindingAdjudication,
  JudgeVerdict,
} from './types.js';

const defect: EvalDefect = {
  id: 'defect-1',
  caseId: 'case-1',
  claim: 'claim',
  evidence: 'evidence',
  files: ['src/a.ts'],
  severity: 'HIGH',
  fixCondition: 'condition',
};

const verdict: JudgeVerdict = {
  judgeModel: 'judge',
  judgeTier: 'free',
  defectExists: true,
  matchedDefectId: defect.id,
  correctness: 2,
  localization: 2,
  actionability: 2,
  unsupportedClaim: false,
  evidenceQuote: 'code',
  reason: 'reason',
};

function run(label: 'old' | 'new', findings = [finding()]): EvalRun {
  return {
    caseId: 'case-1',
    caseSnapshotHash: 'snapshot',
    isNegativeControl: false,
    goldSetVersion: 'gold-v1',
    pipeline: {
      label,
      branchRef: label,
      resolvedSha: 'a'.repeat(40),
    },
    config: {
      reviewerModel: 'reviewer',
      contextBudget: 10,
      tools: [],
      rulesHash: 'rules',
      timeoutMs: 100,
    },
    output: {
      rawFindings: findings,
      finalFindings: findings,
      inputTokens: 10,
      outputTokens: 5,
      providerCalls: 1,
    },
    latencyMs: label === 'old' ? 10 : 12,
  };
}

function finding(body = 'issue') {
  return {
    severity: 'HIGH' as const,
    file: 'src/a.ts',
    line: 1,
    body,
    suggestion: null,
    rule_id: null,
  };
}

function adjudication(
  outcome: AdjudicationOutcome,
  matchedDefectId: string | null = null,
  verdicts = [verdict, verdict]
): FindingAdjudication {
  return {
    finding: finding(outcome),
    outcome,
    matchedDefectId,
    verdicts,
    reason: outcome,
  };
}

describe('computeCaseMetrics', () => {
  it('deduplicates matched defects before recall and excludes partial credit', () => {
    const metrics = computeCaseMetrics({
      run: run('old'),
      defects: [defect],
      adjudications: [
        adjudication('correct', defect.id),
        adjudication('correct', defect.id),
        adjudication('partially_correct', defect.id),
      ],
    });

    expect(metrics.recall).toBe(1);
    expect(metrics.knownPrecision).toBeCloseTo(2 / 3);
    expect(metrics.partialRate).toBeCloseTo(1 / 3);
  });

  it('excludes duplicates, valid unlisted, and held findings as specified', () => {
    const disagreeing = [
      verdict,
      { ...verdict, correctness: 1 as const },
    ];
    const metrics = computeCaseMetrics({
      run: run('old'),
      defects: [defect],
      adjudications: [
        adjudication('correct', defect.id),
        adjudication('duplicate', defect.id),
        adjudication('valid_unlisted'),
        adjudication('needs_human_review', null, disagreeing),
      ],
    });

    expect(metrics.knownPrecision).toBe(1);
    expect(metrics.heldOutCount).toBe(1);
    expect(metrics.heldOutRate).toBe(0.25);
    expect(metrics.judgeDisagreementRate).toBe(0.25);
  });

  it('returns null recall and F1 for negative controls', () => {
    const negativeRun = { ...run('old'), isNegativeControl: true };
    const metrics = computeCaseMetrics({
      run: negativeRun,
      defects: [],
      adjudications: [adjudication('incorrect')],
    });
    expect(metrics.recall).toBeNull();
    expect(metrics.strictF1).toBeNull();
    expect(metrics.strictFalsePositives).toBe(1);
  });
});

describe('comparison metrics', () => {
  it('reports paired deltas', () => {
    const oldMetrics = computeCaseMetrics({
      run: run('old'),
      defects: [defect],
      adjudications: [adjudication('incorrect')],
    });
    const newMetrics = computeCaseMetrics({
      run: run('new'),
      defects: [defect],
      adjudications: [adjudication('correct', defect.id)],
    });
    const comparison = compareCaseMetrics(oldMetrics, newMetrics);
    expect(comparison.recallDelta).toBe(1);
    expect(comparison.f1Delta).toBe(1);
  });

  it('measures same-pipeline finding disagreement', () => {
    const firstRun = run('old', [finding('first')]);
    const secondRun = run('old', [finding('second')]);
    const firstMetrics = computeCaseMetrics({
      run: firstRun,
      defects: [defect],
      adjudications: [adjudication('incorrect')],
    });
    const secondMetrics = computeCaseMetrics({
      run: secondRun,
      defects: [defect],
      adjudications: [adjudication('correct', defect.id)],
    });
    const noise = computeNoiseFloor({
      firstRun,
      secondRun,
      firstMetrics,
      secondMetrics,
    });
    expect(noise.reviewerDisagreementRate).toBe(1);
    expect(noise.f1Delta).toBe(1);
  });
});
