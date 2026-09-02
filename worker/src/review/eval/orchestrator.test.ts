import { describe, expect, it, vi } from 'vitest';
import {
  assessComparison,
  evaluateCase,
} from './orchestrator.test-helper.js';
import type {
  CaseComparison,
  CaseMetrics,
  EvalPipeline,
  JudgeVerdict,
  NoiseFloor,
} from './types.js';

const finding = {
  severity: 'HIGH' as const,
  file: 'src/a.ts',
  line: 1,
  body: 'Missing authorization.',
  suggestion: null,
  rule_id: null,
};

const output = {
  rawFindings: [finding],
  finalFindings: [finding],
  inputTokens: 10,
  outputTokens: 5,
  providerCalls: 1,
};

function pipeline(): EvalPipeline {
  return { review: vi.fn().mockResolvedValue(output) };
}

const judgeBody: Omit<JudgeVerdict, 'judgeModel' | 'judgeTier'> = {
  defectExists: true,
  matchedDefectId: 'defect-1',
  correctness: 2,
  localization: 2,
  actionability: 2,
  unsupportedClaim: false,
  evidenceQuote: 'code',
  reason: 'reason',
};

describe('eval orchestrator', () => {
  it('runs both noise floors and the primary paired comparison', async () => {
    const oldPipeline = pipeline();
    const newPipeline = pipeline();
    const report = await evaluateCase({
      testCase: {
        id: 'case-1',
        repo: 'fixture/repo',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        language: 'typescript',
        isNegativeControl: false,
        diff: 'diff',
        files: { 'src/a.ts': 'code' },
      },
      defects: [{
        id: 'defect-1',
        caseId: 'case-1',
        claim: 'claim',
        evidence: 'evidence',
        files: ['src/a.ts'],
        severity: 'HIGH',
        fixCondition: 'condition',
      }],
      goldSetVersion: 'gold-v1',
      oldPipeline,
      newPipeline,
      oldVersion: {
        label: 'old',
        branchRef: 'main',
        resolvedSha: 'a'.repeat(40),
      },
      newVersion: {
        label: 'new',
        branchRef: 'feature',
        resolvedSha: 'b'.repeat(40),
      },
      config: {
        reviewerModel: 'gemini',
        contextBudget: 100,
        tools: [],
        rulesHash: 'none',
        timeoutMs: 1_000,
      },
      judge: {
        model: 'judge',
        tier: 'free',
        judge: vi.fn().mockResolvedValue(judgeBody),
      },
      cache: {
        get: async () => null,
        set: async () => {},
      },
    });

    expect(oldPipeline.review).toHaveBeenCalledTimes(2);
    expect(newPipeline.review).toHaveBeenCalledTimes(2);
    expect(report.oldNoiseFloor.reviewerDisagreementRate).toBe(0);
    expect(report.newNoiseFloor.reviewerDisagreementRate).toBe(0);
    expect(report.comparison.f1Delta).toBe(0);
    expect(report.assessment).toBe('inconclusive');
  });

  it('caps the judge code context with judgeContextBudget', async () => {
    const judgeFn = vi.fn().mockResolvedValue(judgeBody);
    await evaluateCase({
      testCase: {
        id: 'case-1',
        repo: 'fixture/repo',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        language: 'typescript',
        isNegativeControl: false,
        diff: 'diff',
        files: { 'src/a.ts': 'x'.repeat(2_000) },
      },
      defects: [{
        id: 'defect-1',
        caseId: 'case-1',
        claim: 'claim',
        evidence: 'evidence',
        files: ['src/a.ts'],
        severity: 'HIGH',
        fixCondition: 'condition',
      }],
      goldSetVersion: 'gold-v1',
      oldPipeline: pipeline(),
      newPipeline: pipeline(),
      oldVersion: {
        label: 'old',
        branchRef: 'main',
        resolvedSha: 'a'.repeat(40),
      },
      newVersion: {
        label: 'new',
        branchRef: 'feature',
        resolvedSha: 'b'.repeat(40),
      },
      config: {
        reviewerModel: 'gemini',
        contextBudget: 500,
        judgeContextBudget: 100,
        tools: [],
        rulesHash: 'none',
        timeoutMs: 1_000,
      },
      judge: {
        model: 'judge',
        tier: 'free',
        judge: judgeFn,
      },
      cache: {
        get: async () => null,
        set: async () => {},
      },
    });

    const prompts = judgeFn.mock.calls.map(([prompt]) => String(prompt));
    const codeContext = prompts[0].split('Code context:\n')[1];
    expect(codeContext.length).toBe(400);
  });

  it('windows the judge code context around the finding line', async () => {
    const judgeFn = vi.fn().mockResolvedValue(judgeBody);
    const fileLines = Array.from({ length: 2_000 }, (_, index) => `L${index}`);
    fileLines[1_500] = 'THE_FINDING_TARGET_LINE';
    const targetFinding = { ...finding, line: 1_501 };
    const targetOutput = { ...output, finalFindings: [targetFinding] };
    await evaluateCase({
      testCase: {
        id: 'case-1',
        repo: 'fixture/repo',
        baseSha: '1'.repeat(40),
        headSha: '2'.repeat(40),
        language: 'typescript',
        isNegativeControl: false,
        diff: 'diff',
        files: { 'src/a.ts': fileLines.join('\n') },
      },
      defects: [{
        id: 'defect-1',
        caseId: 'case-1',
        claim: 'claim',
        evidence: 'evidence',
        files: ['src/a.ts'],
        severity: 'HIGH',
        fixCondition: 'condition',
      }],
      goldSetVersion: 'gold-v1',
      oldPipeline: { review: vi.fn().mockResolvedValue(targetOutput) },
      newPipeline: { review: vi.fn().mockResolvedValue(targetOutput) },
      oldVersion: {
        label: 'old',
        branchRef: 'main',
        resolvedSha: 'a'.repeat(40),
      },
      newVersion: {
        label: 'new',
        branchRef: 'feature',
        resolvedSha: 'b'.repeat(40),
      },
      config: {
        reviewerModel: 'gemini',
        contextBudget: 500,
        judgeContextBudget: 100,
        tools: [],
        rulesHash: 'none',
        timeoutMs: 1_000,
      },
      judge: {
        model: 'judge',
        tier: 'free',
        judge: judgeFn,
      },
      cache: {
        get: async () => null,
        set: async () => {},
      },
    });

    const codeContext = String(judgeFn.mock.calls[0][0]).split('Code context:\n')[1];
    expect(codeContext).toContain('THE_FINDING_TARGET_LINE');
  });
});

function metrics(overrides: Partial<CaseMetrics> = {}): CaseMetrics {
  return {
    caseId: 'case',
    pipeline: {
      label: 'old',
      branchRef: 'main',
      resolvedSha: 'a'.repeat(40),
    },
    knownPrecision: 1,
    recall: 0,
    strictF1: 0,
    weightedRecall: 0,
    strictFalsePositives: 0,
    relaxedFalsePositives: 0,
    unsupportedRate: 0,
    duplicateRate: 0,
    partialRate: 0,
    judgeDisagreementRate: 0,
    heldOutCount: 0,
    heldOutRate: 0,
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    providerCalls: 1,
    ...overrides,
  };
}

function comparison(overrides: Partial<CaseComparison> = {}): CaseComparison {
  return {
    caseId: 'case',
    oldMetrics: metrics(),
    newMetrics: metrics({ pipeline: {
      label: 'new',
      branchRef: 'feature',
      resolvedSha: 'b'.repeat(40),
    } }),
    precisionDelta: 0,
    recallDelta: 0,
    f1Delta: 0,
    weightedRecallDelta: 0,
    falsePositiveDelta: 0,
    latencyDeltaMs: 0,
    ...overrides,
  };
}

function noise(f1Delta = 0): NoiseFloor {
  return {
    pipeline: metrics().pipeline,
    reviewerDisagreementRate: 0,
    precisionDelta: 0,
    recallDelta: 0,
    f1Delta,
    falsePositiveDelta: 0,
  };
}

describe('assessComparison', () => {
  it('requires improvements to clear the measured noise floor', () => {
    expect(assessComparison({
      comparison: comparison({ f1Delta: 0.1 }),
      oldNoise: noise(0.1),
      newNoise: noise(0),
    })).toBe('inconclusive');
    expect(assessComparison({
      comparison: comparison({ f1Delta: 0.2 }),
      oldNoise: noise(0.1),
      newNoise: noise(0),
    })).toBe('better');
  });

  it('blocks interpretation when held-out judgments exceed 20 percent', () => {
    expect(assessComparison({
      comparison: comparison({
        oldMetrics: metrics({ heldOutRate: 0.25 }),
      }),
      oldNoise: noise(),
      newNoise: noise(),
    })).toBe('judge_unstable');
  });
});
