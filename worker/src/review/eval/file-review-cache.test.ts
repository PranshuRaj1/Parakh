import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileReviewCache } from './file-review-cache.test-helper.js';
import {
  reviewRunCacheKey,
  runEvalCase,
} from './runner.js';
import type {
  EvalCase,
  EvalPipeline,
  EvalRun,
  EvalRunConfig,
  PipelineVersion,
  ReviewCache,
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

const version: PipelineVersion = {
  label: 'old',
  branchRef: 'main',
  resolvedSha: 'a'.repeat(40),
};

describe('FileReviewCache', () => {
  it('persists complete runs across instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parakh-eval-'));
    const path = join(directory, 'review.json');
    const run: EvalRun = {
      caseId: testCase.id,
      caseSnapshotHash: 'snapshot',
      isNegativeControl: false,
      goldSetVersion: 'gold-v1',
      pipeline: version,
      config,
      output: {
        rawFindings: [],
        finalFindings: [],
        inputTokens: 1,
        outputTokens: 2,
        providerCalls: 3,
      },
      latencyMs: 42,
    };
    await new FileReviewCache(path).set('key', run);

    expect(await new FileReviewCache(path).get('key')).toEqual(run);
  });
});

describe('runEvalCase review caching', () => {
  it('skips the pipeline review when a cached run matches the slot', async () => {
    const pipeline: EvalPipeline = {
      review: vi.fn(async () => ({
        rawFindings: [],
        finalFindings: [],
        inputTokens: 1,
        outputTokens: 1,
        providerCalls: 1,
      })),
    };
    const cache: ReviewCache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    };

    const first = await runEvalCase(
      pipeline,
      version,
      testCase,
      'gold-v1',
      config,
      undefined,
      cache,
      'oldA'
    );
    expect(cache.set).toHaveBeenCalledWith(
      reviewRunCacheKey({
        slot: 'oldA',
        version,
        caseSnapshotHash: first.caseSnapshotHash,
        config,
      }),
      first
    );

    cache.get = vi.fn(async (key: string) =>
      key === reviewRunCacheKey({
        slot: 'oldA',
        version,
        caseSnapshotHash: first.caseSnapshotHash,
        config,
      })
        ? first
        : null
    );
    const second = await runEvalCase(
      pipeline,
      version,
      testCase,
      'gold-v1',
      config,
      undefined,
      cache,
      'oldA'
    );
    expect(second).toEqual(first);
    expect(pipeline.review).toHaveBeenCalledTimes(1);
  });

  it('uses distinct cache keys for each slot', () => {
    const snapshot = 's'.repeat(64);
    const oldASh = reviewRunCacheKey({ slot: 'oldA', version, caseSnapshotHash: snapshot, config });
    const oldBSh = reviewRunCacheKey({ slot: 'oldB', version, caseSnapshotHash: snapshot, config });
    expect(oldASh).not.toBe(oldBSh);
  });
});