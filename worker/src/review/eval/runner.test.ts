import { describe, expect, it, vi } from 'vitest';
import {
  assertComparableRuns,
  hashEvalCase,
  resolvePipelineVersion,
  reviewRunCacheKey,
  runPairedCase,
} from './runner.js';
import type {
  EvalCase,
  EvalPipeline,
  EvalRun,
  EvalRunConfig,
  PipelineOutput,
  PipelineVersion,
} from './types.js';

const testCase: EvalCase = {
  id: 'case-1',
  repo: 'fixture/repo',
  baseSha: '1'.repeat(40),
  headSha: '2'.repeat(40),
  language: 'typescript',
  isNegativeControl: false,
  diff: 'diff',
  files: { 'src/a.ts': 'content' },
};

const config: EvalRunConfig = {
  reviewerModel: 'reviewer',
  contextBudget: 20_000,
  tools: ['repository-context'],
  rulesHash: 'rules',
  timeoutMs: 60_000,
};

const output: PipelineOutput = {
  rawFindings: [],
  finalFindings: [],
  inputTokens: 10,
  outputTokens: 5,
  providerCalls: 1,
};

function version(label: 'old' | 'new'): PipelineVersion {
  return {
    label,
    branchRef: label,
    resolvedSha: (label === 'old' ? 'a' : 'b').repeat(40),
  };
}

function pipeline(): EvalPipeline {
  return { review: vi.fn().mockResolvedValue(output) };
}

describe('eval runner', () => {
  it('resolves and pins moving branch refs', async () => {
    const resolved = await resolvePipelineVersion(
      'old',
      'main',
      async () => 'a'.repeat(40)
    );
    expect(resolved).toEqual({
      label: 'old',
      branchRef: 'main',
      resolvedSha: 'a'.repeat(40),
    });
  });

  it('rejects values that are not full commit SHAs', async () => {
    await expect(resolvePipelineVersion('new', 'feature', async () => 'abc'))
      .rejects.toThrow('Could not resolve pipeline ref');
  });

  it('runs both pipelines against the same case and config', async () => {
    const oldPipeline = pipeline();
    const newPipeline = pipeline();
    const result = await runPairedCase({
      oldPipeline,
      newPipeline,
      oldVersion: version('old'),
      newVersion: version('new'),
      testCase,
      goldSetVersion: 'gold-v1',
      config,
    });

    expect(oldPipeline.review).toHaveBeenCalledWith(testCase, config);
    expect(newPipeline.review).toHaveBeenCalledWith(testCase, config);
    expect(result.oldRun.pipeline.resolvedSha).toBe('a'.repeat(40));
    expect(result.newRun.pipeline.resolvedSha).toBe('b'.repeat(40));
  });

  it('hashes the full pinned snapshot independently of file insertion order', async () => {
    const reversed = {
      ...testCase,
      files: {
        'src/b.ts': 'other',
        'src/a.ts': 'content',
      },
    };
    const ordered = {
      ...testCase,
      files: {
        'src/a.ts': 'content',
        'src/b.ts': 'other',
      },
    };
    expect(await hashEvalCase(reversed)).toBe(await hashEvalCase(ordered));
    expect(await hashEvalCase({ ...ordered, diff: 'changed' }))
      .not.toBe(await hashEvalCase(ordered));
  });

  it('keeps the review cache key independent of the judge context budget', async () => {
    const snapshot = await hashEvalCase(testCase);
    const base = {
      slot: 'oldA' as const,
      version: version('old'),
      caseSnapshotHash: snapshot,
    };
    expect(reviewRunCacheKey({ ...base, config })).toBe(reviewRunCacheKey({
      ...base,
      config: { ...config, judgeContextBudget: 2_000 },
    }));
    expect(reviewRunCacheKey({ ...base, config })).not.toBe(
      reviewRunCacheKey({ ...base, config: { ...config, timeoutMs: 30_000 } })
    );
  });

  it('keeps file and grouped strategies in separate cache entries', async () => {
    const snapshot = await hashEvalCase(testCase);
    const base = { slot: 'oldA' as const, caseSnapshotHash: snapshot, config };
    expect(reviewRunCacheKey({ ...base, version: { ...version('old'), strategy: 'file' } }))
      .not.toBe(reviewRunCacheKey({ ...base, version: { ...version('old'), strategy: 'grouped' } }));
  });

  it('fails loudly when snapshots or configs differ', () => {
    const baseRun: EvalRun = {
      caseId: testCase.id,
      caseSnapshotHash: 'snapshot',
      isNegativeControl: false,
      goldSetVersion: 'gold-v1',
      pipeline: version('old'),
      config,
      output,
      latencyMs: 1,
    };

    expect(() => assertComparableRuns(baseRun, {
      ...baseRun,
      caseId: 'case-2',
    })).toThrow('Eval case mismatch');

    expect(() => assertComparableRuns(baseRun, {
      ...baseRun,
      caseSnapshotHash: 'different',
    })).toThrow('Eval snapshot mismatch');

    expect(() => assertComparableRuns(baseRun, {
      ...baseRun,
      config: { ...config, contextBudget: 10_000 },
    })).toThrow('Eval config mismatch');
  });
});
