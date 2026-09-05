import { describe, expect, it } from 'vitest';
import {
  generateAdjudicationReview,
  generateMarkdownReport,
} from './report.js';
import type {
  EvalCaseReport,
  EvalReport,
  EvaluatedRun,
  FindingAdjudication,
  PipelineVersion,
} from './types.js';

function pipelineVersion(
  overrides: Partial<PipelineVersion> = {}
): PipelineVersion {
  return {
    label: 'old',
    branchRef: 'main',
    resolvedSha: 'a'.repeat(40),
    ...overrides,
  };
}

function emptyEvaluatedRun(
  pipeline: PipelineVersion
): EvaluatedRun {
  return {
    run: {
      caseId: 'test-case',
      caseSnapshotHash: 'hash',
      isNegativeControl: false,
      goldSetVersion: 'gold-v1',
      pipeline,
      config: {
        reviewerModel: 'gemini-2.5-flash',
        contextBudget: 20000,
        tools: [],
        rulesHash: 'none',
        timeoutMs: 120000,
      },
      output: {
        rawFindings: [],
        finalFindings: [],
        inputTokens: 0,
        outputTokens: 0,
        providerCalls: 0,
      },
      latencyMs: 0,
    },
    adjudications: [],
    metrics: {
      caseId: 'test-case',
      pipeline,
      knownPrecision: 0,
      recall: null,
      strictF1: null,
      weightedRecall: null,
      strictFalsePositives: 0,
      relaxedFalsePositives: 0,
      unsupportedRate: 0,
      duplicateRate: 0,
      partialRate: 0,
      judgeDisagreementRate: 0,
      heldOutCount: 0,
      heldOutRate: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      providerCalls: 0,
    },
  };
}

function sampleCaseReport(): EvalCaseReport {
  const oldPipeline = pipelineVersion({ label: 'old' });
  const newPipeline = pipelineVersion({
    label: 'new',
    branchRef: 'feature-branch',
    resolvedSha: 'b'.repeat(40),
  });

  const oldA = emptyEvaluatedRun(oldPipeline);
  oldA.metrics.knownPrecision = 0.5;
  oldA.metrics.recall = 0.5;
  oldA.metrics.strictF1 = 0.5;

  const newA = emptyEvaluatedRun(newPipeline);
  newA.metrics.knownPrecision = 0.75;
  newA.metrics.recall = 0.75;
  newA.metrics.strictF1 = 0.75;

  return {
    caseId: 'test-case-1',
    oldNoiseFloor: {
      pipeline: oldPipeline,
      reviewerDisagreementRate: 0.1,
      precisionDelta: 0,
      recallDelta: null,
      f1Delta: null,
      falsePositiveDelta: 0,
    },
    newNoiseFloor: {
      pipeline: newPipeline,
      reviewerDisagreementRate: 0.05,
      precisionDelta: 0,
      recallDelta: null,
      f1Delta: null,
      falsePositiveDelta: 0,
    },
    comparison: {
      caseId: 'test-case-1',
      oldMetrics: oldA.metrics,
      newMetrics: newA.metrics,
      precisionDelta: 0.25,
      recallDelta: 0.25,
      f1Delta: 0.25,
      weightedRecallDelta: 0.25,
      falsePositiveDelta: -1,
      latencyDeltaMs: 500,
    },
    assessment: 'better',
    runs: {
      oldA,
      oldB: emptyEvaluatedRun(oldPipeline),
      newA,
      newB: emptyEvaluatedRun(newPipeline),
    },
  };
}

function sampleReport(): EvalReport {
  return {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    goldSetVersion: 'gold-v1',
    oldPipeline: pipelineVersion({ label: 'old' }),
    newPipeline: pipelineVersion({
      label: 'new',
      branchRef: 'feature',
      resolvedSha: 'b'.repeat(40),
    }),
    judgeModel: 'openai/gpt-oss-120b',
    judgeTier: 'free',
    config: {
      reviewerModel: 'gemini-2.5-flash',
      contextBudget: 20000,
      tools: [],
      rulesHash: 'none',
      timeoutMs: 120000,
    },
    cases: [sampleCaseReport()],
    summary: { better: 1, worse: 0, mixed: 0, pass: 1, parity: 0, judge_unstable: 0 },
  };
}

describe('generateMarkdownReport', () => {
  it('produces a non-empty markdown report', () => {
    const report = generateMarkdownReport(sampleReport());
    expect(report).toContain('# Parakh PR Review Evaluation Report');
    expect(report).toContain('gold-v1');
  });

  it('includes configuration table', () => {
    const report = generateMarkdownReport(sampleReport());
    expect(report).toContain('| Gold Set Version | gold-v1 |');
    expect(report).toContain('| Judge Model | openai/gpt-oss-120b |');
  });

  it('includes summary table', () => {
    const report = generateMarkdownReport(sampleReport());
    expect(report).toContain('| better | 1 |');
  });

  it('includes per-case assessment', () => {
    const report = generateMarkdownReport(sampleReport());
    expect(report).toContain('### test-case-1');
    expect(report).toContain('Assessment: **better**');
  });

  it('renders comparison metrics', () => {
    const report = generateMarkdownReport(sampleReport());
    expect(report).toContain('| Precision | 50.0% | 75.0% |');
  });

  it('renders noise floor sections', () => {
    const report = generateMarkdownReport(sampleReport());
    expect(report).toContain('**Old Noise Floor**');
    expect(report).toContain('**New Noise Floor**');
  });
});

describe('generateAdjudicationReview', () => {
  it('returns empty string when no held-out findings', () => {
    const report = generateAdjudicationReview(sampleReport());
    expect(report).toContain('Adjudication Review');
  });

  it('renders held-out findings', () => {
    const caseReport = sampleCaseReport();
    const heldOutAdj: FindingAdjudication = {
      finding: {
        severity: 'HIGH',
        file: 'src/auth.ts',
        line: 42,
        body: 'Missing ownership check.',
        suggestion: 'Add owner check.',
        rule_id: null,
      },
      outcome: 'needs_human_review',
      matchedDefectId: null,
      verdicts: [
        {
          judgeModel: 'judge',
          judgeTier: 'free',
          defectExists: true,
          matchedDefectId: null,
          correctness: 2,
          localization: 1,
          actionability: 2,
          unsupportedClaim: false,
          evidenceQuote: 'code',
          reason: 'Judge passes disagree.',
        },
        {
          judgeModel: 'judge',
          judgeTier: 'free',
          defectExists: false,
          matchedDefectId: null,
          correctness: 0,
          localization: 0,
          actionability: 0,
          unsupportedClaim: false,
          evidenceQuote: 'code',
          reason: 'Issue not found.',
        },
      ],
      reason: 'Judge passes disagree.',
    };

    caseReport.runs.oldA.adjudications = [heldOutAdj];

    const report: EvalReport = {
      ...sampleReport(),
      cases: [caseReport],
    };

    const review = generateAdjudicationReview(report);
    expect(review).toContain('Missing ownership check');
    expect(review).toContain('src/auth.ts:42');
    expect(review).toContain('Judge verdicts');
    expect(review).toContain('[ ] correct');
    expect(review).toContain('[ ] valid_unlisted');
  });

  it('skips cases with no held-out findings', () => {
    const report = generateAdjudicationReview(sampleReport());
    expect(report).not.toContain('test-case-1');
  });
});
