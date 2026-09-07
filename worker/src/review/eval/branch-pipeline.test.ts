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
  it('keeps reliable groups when another file needs fallback', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const reviewBehaviorGroup = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const pipeline = createBranchPipelineFromModules({
      strategy: 'grouped',
      gemini: { GeminiClient: class { reviewDiff = reviewDiff; reviewBehaviorGroup = reviewBehaviorGroup; } },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'a diff'], ['config.yaml', 'config diff']]),
        isIgnoredLockfile: () => false, resolveReviewResult: () => ({ findings: [] }),
      },
    });
    const output = await pipeline.review({
      ...testCase,
      diff: ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
        '@@ -1,3 +1,3 @@', ' export function first() {', '-  return 1;', '+  return 2;', ' }',
        '@@ -4,3 +4,3 @@', ' export function second() {', '-  return 1;', '+  return 2;', ' }',
        'diff --git a/config.yaml b/config.yaml', '--- a/config.yaml', '+++ b/config.yaml',
        '@@ -1 +1 @@', '-timeout: 1', '+timeout: 2'].join('\n'),
      files: { 'src/a.ts': 'export function first() {\n  return 2;\n}\nexport function second() {\n  return 2;\n}', 'config.yaml': 'timeout: 2' },
    }, { ...config, contextBudget: 12000 });
    expect(reviewBehaviorGroup).toHaveBeenCalledTimes(1);
    expect(reviewBehaviorGroup.mock.calls[0][0]).toContain('@@ -4,3 +4,3 @@');
    expect(reviewDiff).toHaveBeenCalledTimes(1);
    expect(reviewDiff.mock.calls[0][0]).toBe('config.yaml');
    expect(output.retrieval?.fallbackRate).toBe(0.5);
  });

  it('reuses the provider client across review calls', async () => {
    let constructed = 0;
    const reviewDiff = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    class GeminiClient {
      reviewDiff = reviewDiff;
      constructor() { constructed++; }
    }
    const pipeline = createBranchPipelineFromModules({
      strategy: 'file',
      gemini: { GeminiClient },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });

    await pipeline.review(testCase, config);
    await pipeline.review(testCase, config);

    expect(constructed).toBe(1);
    expect(reviewDiff).toHaveBeenCalledTimes(2);
  });

  it('renders an unchanged callee and measures its retrieval', async () => {
    const reviewBehaviorGroup = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const pipeline = createBranchPipelineFromModules({
      strategy: 'grouped',
      gemini: { GeminiClient: class { reviewDiff = vi.fn(); reviewBehaviorGroup = reviewBehaviorGroup; } },
      review: {
        parseDiffByFile: () => new Map([['src/api.ts', 'api diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });
    const output = await pipeline.review({
      ...testCase,
      expectedRelatedFiles: ['src/service.ts'],
      files: {
        'src/api.ts': "import { save } from './service';\nexport function update() {\n  return save(false);\n}",
        'src/service.ts': 'export function save(authorized) {\n  if (!authorized) throw new Error("authorization required");\n  return true;\n}',
        'src/unrelated.ts': 'export function other() { return "unrelated sentinel"; }',
      },
      diff: ['diff --git a/src/api.ts b/src/api.ts', '--- a/src/api.ts', '+++ b/src/api.ts',
        '@@ -1,4 +1,4 @@', " import { save } from './service';", ' export function update() {',
        '-  return save(true);', '+  return save(false);', ' }'].join('\n'),
    }, { ...config, contextBudget: 12000 });
    expect(reviewBehaviorGroup.mock.calls[0][0]).toContain('authorization required');
    expect(reviewBehaviorGroup.mock.calls[0][0]).not.toContain('unrelated sentinel');
    expect(output.retrieval).toMatchObject({
      retrievedFiles: ['src/service.ts'], renderedFiles: ['src/service.ts'], recall: 1,
    });
    expect(output.retrieval?.diagnostics).toEqual([
      expect.objectContaining({
        file: 'src/service.ts',
        sourcePresent: true,
        changed: false,
        extractedSymbols: ['src/service.ts#save'],
        bridgePaths: expect.arrayContaining([
          expect.stringContaining('src/service.ts#save <- change:'),
        ]),
        rendered: true,
        truncated: false,
      }),
    ]);
  });

  it('reviews planner-generated behavior groups without changing the file adapter', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({
      genericFindings: [],
      ruleFindings: [],
      thinking: null,
    });
    const reviewBehaviorGroup = vi.fn().mockResolvedValue({
      genericFindings: [],
      ruleFindings: [],
      thinking: null,
    });
    const pipeline = createBranchPipelineFromModules({
      strategy: 'grouped',
      apiKey: 'key',
      gemini: {
        GeminiClient: class {
          reviewDiff = reviewDiff;
          reviewBehaviorGroup = reviewBehaviorGroup;
        },
      },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'raw file diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });

    const output = await pipeline.review({
      ...testCase,
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,3 @@',
        ' export function update() {',
        '-  return value == null;',
        '+  return value !== null;',
        '}',
      ].join('\n'),
      files: { 'src/a.ts': 'export function update() {\n  return value !== null;\n}' },
    }, config);

    expect(reviewBehaviorGroup).toHaveBeenCalledWith(
      expect.stringContaining('BEHAVIOR_GROUP:'),
      [],
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    expect(reviewDiff).not.toHaveBeenCalled();
    expect(output.planningGroups).toBe(1);
    expect(output.planningChanges).toBe(1);
    expect(output.providerCalls).toBe(1);
  });

  it('uses the raw file diff for low-confidence fallback groups', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const reviewBehaviorGroup = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const rawDiff = 'raw markdown diff';
    const pipeline = createBranchPipelineFromModules({
      strategy: 'grouped',
      gemini: { GeminiClient: class { reviewDiff = reviewDiff; reviewBehaviorGroup = reviewBehaviorGroup; } },
      review: {
        parseDiffByFile: () => new Map([['README.md', rawDiff]]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });

    const output = await pipeline.review({
      ...testCase,
      diff: ['diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
      files: { 'README.md': 'new' },
    }, config);

    expect(reviewDiff.mock.calls[0][0]).toBe('README.md');
    expect(reviewDiff.mock.calls[0][1]).toContain('@@ -1 +1 @@');
    expect(reviewDiff.mock.calls[0][1]).not.toBe(rawDiff);
    expect(reviewDiff.mock.calls[0][4]).toBe('new');
    expect(reviewBehaviorGroup).not.toHaveBeenCalled();
    expect(output.providerCalls).toBe(1);
  });

  it('falls back to file review when semantic groups would increase calls', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const reviewBehaviorGroup = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const rawDiff = 'one raw file review';
    const pipeline = createBranchPipelineFromModules({
      strategy: 'grouped',
      gemini: { GeminiClient: class { reviewDiff = reviewDiff; reviewBehaviorGroup = reviewBehaviorGroup; } },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', rawDiff]]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });

    const output = await pipeline.review({
      ...testCase,
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,3 @@',
        ' export function first() {',
        '-  return 1;',
        '+  return 2;',
        ' }',
        '@@ -5,3 +5,3 @@',
        ' export function second() {',
        '-  return 1;',
        '+  return 2;',
        ' }',
      ].join('\n'),
      files: { 'src/a.ts': 'export function first() { return 2; }\n\nexport function second() { return 2; }' },
    }, config);

    expect(reviewDiff).toHaveBeenCalledTimes(1);
    expect(reviewDiff.mock.calls[0][0]).toBe('src/a.ts');
    expect(reviewDiff.mock.calls[0][1]).toContain('@@ -1,3 +1,3 @@');
    expect(reviewDiff.mock.calls[0][1]).toContain('@@ -5,3 +5,3 @@');
    expect(reviewDiff.mock.calls[0][1]).not.toBe(rawDiff);
    expect(reviewBehaviorGroup).not.toHaveBeenCalled();
    expect(output.providerCalls).toBe(1);
  });

  it('sends only demoted hunks to fallback when a file also has a reliable group', async () => {
    const reviewDiff = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const reviewBehaviorGroup = vi.fn().mockResolvedValue({ genericFindings: [], ruleFindings: [], thinking: null });
    const pipeline = createBranchPipelineFromModules({
      strategy: 'grouped',
      gemini: { GeminiClient: class { reviewDiff = reviewDiff; reviewBehaviorGroup = reviewBehaviorGroup; } },
      review: {
        parseDiffByFile: () => new Map([['src/a.ts', 'raw file diff']]),
        isIgnoredLockfile: () => false,
        resolveReviewResult: () => ({ findings: [] }),
      },
    });
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      "-import { oldSave } from './service';",
      "+import { save } from './service';",
      '@@ -3,3 +3,3 @@',
      ' export function update() {',
      '-  return oldSave();',
      '+  return save();',
      ' }',
    ].join('\n');
    const output = await pipeline.review({
      ...testCase,
      diff,
      files: {
        'src/a.ts': "import { save } from './service';\n\nexport function update() {\n  return save();\n}",
      },
    }, { ...config, contextBudget: 12000 });

    expect(reviewBehaviorGroup).toHaveBeenCalledTimes(1);
    expect(reviewBehaviorGroup.mock.calls[0][0]).toContain('@@ -3,3 +3,3 @@');
    expect(reviewBehaviorGroup.mock.calls[0][0]).not.toContain('@@ -1 +1 @@');
    expect(reviewDiff).toHaveBeenCalledTimes(1);
    expect(reviewDiff.mock.calls[0][1]).toContain('@@ -1 +1 @@');
    expect(reviewDiff.mock.calls[0][1]).not.toContain('@@ -3,3 +3,3 @@');
    expect(output.providerCalls).toBe(2);
  });

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
