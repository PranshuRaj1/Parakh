import { describe, expect, it } from 'vitest';
import { runScore } from './run-history.js';
import type { EvalReport } from './types.js';

function report(): EvalReport {
  return {
    schemaVersion: 1,
    createdAt: '2026-09-07T00:00:00Z',
    goldSetVersion: 'gold-v1',
    oldPipeline: { label: 'old', branchRef: 'main', resolvedSha: 'a'.repeat(40) },
    newPipeline: { label: 'new', branchRef: 'feature', resolvedSha: 'b'.repeat(40) },
    judgeModel: 'judge',
    judgeTier: 'free',
    config: { reviewerModel: 'reviewer', contextBudget: 1000, tools: [], rulesHash: 'none', timeoutMs: 1000 },
    cases: [
      { assessment: 'better', comparison: { newMetrics: { strictF1: 0.8 } } },
      { assessment: 'judge_unstable', comparison: { newMetrics: { strictF1: 0.1 } } },
    ] as EvalReport['cases'],
    summary: { better: 1, worse: 0, mixed: 0, pass: 0, parity: 0, judge_unstable: 1 },
  };
}

describe('runScore', () => {
  it('excludes judge-unstable cases from the headline score', () => {
    expect(runScore(report())).toBe(0.8);
  });
});
