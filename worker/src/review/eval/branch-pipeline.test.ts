import { describe, expect, it, vi } from 'vitest';
import { createBranchPipelineFromModules } from './branch-pipeline.test-helper.js';
import type { EvalCase, EvalRunConfig } from './types.js';

const testCase: EvalCase = {
  id: 'case',
  repo: 'fixture/repo',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  language: 'typescript',
  isNegativeControl: false,
  diff: 'source diff',
  files: { 'src/a.ts': 'full file content' },
};

const config: EvalRunConfig = {
  reviewerModel: 'gemini-test',
  contextBudget: 100,
  tools: [],
  rulesHash: 'none',
  timeoutMs: 1_000,
};

describe('branch pipeline adapter', () => {
  it('reviews the frozen diff with the branch modules', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({
      genericFindings: [{
        severity: 'HIGH',
        file: 'src/a.ts',
        line: 2,
        body: 'issue',
        suggestion: null,
      }],
      ruleFindings: [],
      thinking: null,
    });
    const pipeline = createBranchPipelineFromModules({
      apiKey: 'key',
      gemini: {
        GeminiClient: class {
          reviewDiff = reviewDiff;
        },
      },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'source diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: (result) => ({
          findings: result.genericFindings.map((finding) => ({
            ...finding,
            rule_id: null,
          })),
        }),
      },
    });

    const output = await pipeline.review(testCase, config);
    expect(reviewDiff).toHaveBeenCalledWith(
      'src/a.ts',
      'source diff',
      [],
      expect.objectContaining({ timeoutMs: 1_000 }),
      'full file content'
    );
    expect(output.rawFindings).toHaveLength(1);
    expect(output.finalFindings).toHaveLength(1);
    expect(output.providerCalls).toBe(1);
  });

  it('enforces the shared context budget', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({
      genericFindings: [],
      ruleFindings: [],
      thinking: null,
    });
    const pipeline = createBranchPipelineFromModules({
      gemini: {
        GeminiClient: class {
          reviewDiff = reviewDiff;
        },
      },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'd'.repeat(300)]]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });

    await pipeline.review(testCase, { ...config, contextBudget: 50 });
    expect(reviewDiff.mock.calls[0][1]).toHaveLength(200);
    expect(reviewDiff.mock.calls[0][4]).toBe('');
  });

  it('rejects unsupported tools and rules instead of ignoring them', async () => {
    const pipeline = createBranchPipelineFromModules({
      gemini: {
        GeminiClient: class {
          async reviewDiff() {
            return { genericFindings: [], ruleFindings: [], thinking: null };
          }
        },
      },
      review: {
        parseDiffByFile: () => new Map(),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });
    await expect(pipeline.review(testCase, {
      ...config,
      tools: ['repository'],
    })).rejects.toThrow('Eval v1 supports only empty tools and rules');
  });

  it('applies the same hard timeout to branch clients', async () => {
    const pipeline = createBranchPipelineFromModules({
      gemini: {
        GeminiClient: class {
          reviewDiff() {
            return new Promise<never>(() => {});
          }
        },
      },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });
    await expect(pipeline.review(testCase, {
      ...config,
      timeoutMs: 5,
    })).rejects.toThrow('Eval review timed out after 5ms');
  });

  it('passes the complete key pool to the branch client', async () => {
    const environments: Array<{ GEMINI_API_KEY?: string; GEMINI_API_KEYS?: string }> = [];
    const pipeline = createBranchPipelineFromModules({
      apiKeys: 'daily-key,capacity-key,working-key',
      gemini: {
        GeminiClient: class {
          constructor(env: { GEMINI_API_KEY?: string; GEMINI_API_KEYS?: string }) {
            environments.push(env);
          }

          async reviewDiff() {
            return { genericFindings: [], ruleFindings: [], thinking: null };
          }
        },
      },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });

    await expect(pipeline.review(testCase, config)).resolves.toMatchObject({
      providerCalls: 1,
    });
    expect(environments).toEqual([{
      GEMINI_API_KEY: undefined,
      GEMINI_API_KEYS: 'daily-key,capacity-key,working-key',
      GEMINI_GENERATION_MODEL: 'gemini-test',
    }]);
  });
});
