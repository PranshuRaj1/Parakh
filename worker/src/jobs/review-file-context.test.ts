import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import type { ReviewResult } from '../gemini/client.js';

const { resolveUserCredsMock } = vi.hoisted(() => ({ resolveUserCredsMock: vi.fn() }));

vi.mock('../github/auth.js', () => ({ getCachedToken: vi.fn() }));
vi.mock('../llm/user-creds.js', () => ({ resolveUserCreds: resolveUserCredsMock }));

vi.mock('../github/api.js', () => ({
  fetchDiff: vi.fn(),
  fetchDiffPinned: vi.fn(),
  getCompareStatus: vi.fn(),
  getPRDetails: vi.fn(),
  getFileContent: vi.fn(),
  postComment: vi.fn(),
  postCommentOnce: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  replyToReviewComment: vi.fn(),
  resolveReviewCommentRoot: vi.fn(),
  addCommentReaction: vi.fn(),
  removeCommentReaction: vi.fn(),
  findIssueCommentByMarker: vi.fn(),
  updateIssueComment: vi.fn(),
}));

vi.mock('./anchored-findings.js', () => ({ postAnchoredFindings: vi.fn() }));

vi.mock('../db/reviews.js', () => ({
  updateReviewStatus: vi.fn(),
  updateReviewResults: vi.fn(),
  updateReviewReactions: vi.fn(),
  getLatestReviewByPR: vi.fn(),
  getLatestCompletedReviewBefore: vi.fn(),
  insertReview: vi.fn(),
  getReview: vi.fn(),
  setTriggerCommentContext: vi.fn(),
  updateTriggerCommentReactionId: vi.fn(),
  updateReviewShaPin: vi.fn(),
  updateReviewCompatibilityMetadata: vi.fn(),
  updateReviewIncrementalPlan: vi.fn(),
  updateReviewEffectiveMode: vi.fn(),
  dbMarkDailyQuotaPaused: vi.fn(),
  recordReviewFileEvent: vi.fn(),
  recordIncrementalShadowRun: vi.fn(),
  saveReviewReconciliation: vi.fn(),
  markReviewIncomplete: vi.fn(),
  saveReviewReasonings: vi.fn(),
  dbStartStage: vi.fn(),
  dbCompleteStage: vi.fn(),
  dbFailStage: vi.fn(),
  dbUpdateReason: vi.fn(),
  dbUpdateReasonDetail: vi.fn(),
  dbUpdateHeartbeat: vi.fn(),
  dbTimeoutStage: vi.fn(),
  getLatestOverviewCommentId: vi.fn(),
  setReviewOverviewCommentId: vi.fn(),
}));

vi.mock('../db/rules.js', () => ({
  getActiveRules: vi.fn(),
  incrementEvidenceCount: vi.fn(),
}));

vi.mock('../llm/factory.js', () => ({ createLLMClients: vi.fn() }));

vi.mock('../redis.js', () => ({
  createRedisGet: vi.fn(),
  createRedisSet: vi.fn(),
  createRedisSetNX: vi.fn(),
  createRedisDel: vi.fn(),
}));

import { executeReviewJob } from './review.js';
import { getCachedToken } from '../github/auth.js';
import {
  fetchDiffPinned,
  getCompareStatus,
  getFileContent,
  postCommentOnce,
} from '../github/api.js';
import {
  getLatestCompletedReviewBefore,
  getLatestOverviewCommentId,
  getReview,
  setReviewOverviewCommentId,
  updateReviewResults,
} from '../db/reviews.js';
import { findIssueCommentByMarker, updateIssueComment } from '../github/api.js';
import { getActiveRules } from '../db/rules.js';
import { createLLMClients } from '../llm/factory.js';
import { createRedisGet, createRedisSet, createRedisSetNX, createRedisDel } from '../redis.js';
import { hashActiveRules, REVIEW_PIPELINE_VERSION } from '../review/compatibility.js';

const mocked = {
  getCachedToken: vi.mocked(getCachedToken),
  fetchDiffPinned: vi.mocked(fetchDiffPinned),
  getCompareStatus: vi.mocked(getCompareStatus),
  getFileContent: vi.mocked(getFileContent),
  postCommentOnce: vi.mocked(postCommentOnce),
  getLatestCompletedReviewBefore: vi.mocked(getLatestCompletedReviewBefore),
  getLatestOverviewCommentId: vi.mocked(getLatestOverviewCommentId),
  setReviewOverviewCommentId: vi.mocked(setReviewOverviewCommentId),
  findIssueCommentByMarker: vi.mocked(findIssueCommentByMarker),
  updateIssueComment: vi.mocked(updateIssueComment),
  getReview: vi.mocked(getReview),
  updateReviewResults: vi.mocked(updateReviewResults),
  getActiveRules: vi.mocked(getActiveRules),
  createLLMClients: vi.mocked(createLLMClients),
};

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: 'key',
    DATABASE_URL: 'postgres://x',
    UPSTASH_REDIS_URL: 'https://redis',
    UPSTASH_REDIS_TOKEN: 'token',
    REVIEW_FILE_CONTEXT_ENABLED: 'true',
    ...overrides,
  } as unknown as Env;
}

function fileDiff(path: string, addition: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 111..222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    addition,
  ].join('\n');
}

let nextReviewResult: ReviewResult;

function makeLlm() {
  return {
    servedProvider: 'gemini' as const,
    modelName: 'test-model',
    reviewDiff: vi.fn(async (): Promise<ReviewResult> => nextReviewResult),
    reviewIncrementalDiff: vi.fn(async (): Promise<ReviewResult & { priorFindingResolutions: [] }> => ({
      ...nextReviewResult,
      priorFindingResolutions: [],
    })),
  };
}

async function runJob(env: Env, requestedMode?: 'full' | 'incremental'): Promise<void> {
  await executeReviewJob(
    { type: 'REVIEW', installationId: 1, owner: 'acme', repo: 'app', prNumber: 7, reviewId: 'review-1', requestedMode },
    env,
    1
  );
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  nextReviewResult = { genericFindings: [], ruleFindings: [], thinking: null };

  mocked.getCachedToken.mockResolvedValue('token');
  resolveUserCredsMock.mockResolvedValue({
    githubLogin: 'installer-user',
    geminiKeys: ['fake-gemini-key'],
    groqKeys: [],
    cfaiAccountId: null,
    cfaiToken: null,
    openrouterKey: null,
  });
  mocked.getActiveRules.mockResolvedValue([]);
  mocked.getReview.mockResolvedValue({
    id: 'review-1',
    status: 'RUNNING',
    stage_attempt: 1,
    worker_heartbeat_at: new Date().toISOString(),
    head_sha: 'head-sha',
    base_sha: 'base-sha',
  } as never);
  mocked.fetchDiffPinned.mockResolvedValue(fileDiff('src/example.ts', '+const x = 1;'));
  mocked.getFileContent.mockResolvedValue('const x = 1;\n');
  mocked.postCommentOnce.mockResolvedValue(undefined);
  mocked.getLatestCompletedReviewBefore.mockResolvedValue(null);
  // Finalization upserts the persistent PR overview comment — serve it from
  // the stored-ID path so tests never hit comment creation.
  mocked.getLatestOverviewCommentId.mockResolvedValue(42);
  mocked.setReviewOverviewCommentId.mockResolvedValue(undefined);
  mocked.updateIssueComment.mockResolvedValue(undefined as never);
  vi.mocked(createRedisGet).mockReturnValue((async () => null) as never);
  vi.mocked(createRedisSet).mockReturnValue((async () => undefined) as never);
  vi.mocked(createRedisSetNX).mockReturnValue((async () => true) as never);
  vi.mocked(createRedisDel).mockReturnValue((async () => undefined) as never);

  const llm = makeLlm();
  mocked.createLLMClients.mockReturnValue({ llm } as never);
});

describe('review job file context', () => {
  it('performs no fetch when the flag is off', async () => {
    await runJob(makeEnv({ REVIEW_FILE_CONTEXT_ENABLED: 'false' }));

    expect(mocked.getFileContent).not.toHaveBeenCalled();
  });

  it('fetches the exact reviewed file at the pinned head SHA', async () => {
    await runJob(makeEnv());

    expect(mocked.getFileContent).toHaveBeenCalledWith('acme', 'app', 'src/example.ts', 'head-sha', 'token');
  });

  it('gives full reviews bounded prompt context but untruncated verification content', async () => {
    const padded = `${'// padding\n'.repeat(6000)}const lateIdentifier = 1;\n`;
    mocked.getFileContent.mockResolvedValue(padded);
    nextReviewResult = {
      genericFindings: [
        { severity: 'MEDIUM', file: 'src/example.ts', line: 1, body: 'Uses `lateIdentifier` without a guard.', suggestion: null },
        { severity: 'HIGH', file: 'src/example.ts', line: 1, body: '`ghostSymbol` is never released.', suggestion: null },
        { severity: 'LOW', file: 'src/example.ts', line: 2, body: 'Returned promise is ignored.', suggestion: null },
      ],
      ruleFindings: [],
      thinking: null,
    };

    await runJob(makeEnv());

    const llm = (mocked.createLLMClients.mock.results[0].value as { llm: ReturnType<typeof makeLlm> }).llm;
    const promptContext = llm.reviewDiff.mock.calls[0][4];
    expect(promptContext.length).toBeLessThanOrEqual(60_000);
    expect(promptContext).not.toContain('lateIdentifier');

    const persisted = mocked.updateReviewResults.mock.calls[0][2] as Array<{ body: string }>;
    const bodies = persisted.map((finding) => finding.body);
    // Verification saw the FULL content: the identifier past the prompt cap
    // was confirmed, the absent one was dropped as fabrication.
    expect(bodies.some((body) => body.includes('lateIdentifier'))).toBe(true);
    expect(bodies.some((body) => body.includes('ghostSymbol'))).toBe(false);
    expect(bodies.some((body) => body.includes('promise is ignored'))).toBe(true);
  });

  it('keeps unverifiable findings when nothing can be checked', async () => {
    nextReviewResult = {
      genericFindings: [
        { severity: 'LOW', file: 'src/example.ts', line: 1, body: 'Error handling looks thin here.', suggestion: null },
      ],
      ruleFindings: [],
      thinking: null,
    };

    await runJob(makeEnv());

    const persisted = mocked.updateReviewResults.mock.calls[0][2] as Array<{ body: string }>;
    expect(persisted.map((finding) => finding.body)).toContain('Error handling looks thin here.');
  });

  it('continues with a diff-only review when GitHub fetch fails', async () => {
    mocked.getFileContent.mockRejectedValue(new Error('GitHub 502'));

    await runJob(makeEnv());

    const llm = (mocked.createLLMClients.mock.results[0].value as { llm: ReturnType<typeof makeLlm> }).llm;
    expect(llm.reviewDiff.mock.calls[0][4]).toBeUndefined();
    expect(mocked.updateReviewResults).toHaveBeenCalledTimes(1);
  });

  it('skips the fetch once the subrequest budget is exhausted', async () => {
    const { reviewSingleFile } = await import('./review.js');
    const { SubrequestBudget } = await import('./subrequest-budget.js');
    const { ReviewBaselineCollector } = await import('../review/baseline/metrics.js');
    const { DEFAULT_FEATURE_FLAGS } = await import('../config/feature-flags.js');

    const budget = new SubrequestBudget(44);
    budget.spend(43); // one short of the limit — no room for the fetch
    const llm = makeLlm();
    const result = await reviewSingleFile(
      llm as never,
      'src/example.ts',
      new Map([['src/example.ts', fileDiff('src/example.ts', '+const x = 1;')]]),
      [],
      [],
      makeEnv(),
      new AbortController().signal,
      'review-1',
      1,
      1,
      false,
      14,
      [],
      budget,
      new ReviewBaselineCollector('review-1', 1, {
        ...DEFAULT_FEATURE_FLAGS,
        reviewFileContext: true,
      }),
      null,
      'head-sha',
      { ...DEFAULT_FEATURE_FLAGS, reviewFileContext: true },
      'acme',
      'app',
      'token',
      null
    );

    expect(mocked.getFileContent).not.toHaveBeenCalled();
    expect(llm.reviewDiff.mock.calls[0][4]).toBeUndefined();
    expect(result.findings).toEqual([]);
  });

  it('gives incremental reviews bounded prompt context', async () => {
    const rulesHash = await hashActiveRules([]);
    mocked.getLatestCompletedReviewBefore.mockResolvedValue({
      id: 'parent-1',
      status: 'COMPLETED',
      head_sha: 'parent-head',
      base_sha: 'base-sha',
      active_rules_hash: rulesHash,
      pipeline_version: REVIEW_PIPELINE_VERSION,
      findings: [],
      score: 4,
    } as never);
    mocked.getCompareStatus.mockResolvedValue('ahead');
    const padded = `${'// padding\n'.repeat(6000)}const lateIdentifier = 1;\n`;
    mocked.getFileContent.mockResolvedValue(padded);

    await runJob(makeEnv({ INCREMENTAL_REVIEW_ENABLED: 'true' }), 'incremental');

    const llm = (mocked.createLLMClients.mock.results[0].value as { llm: ReturnType<typeof makeLlm> }).llm;
    expect(llm.reviewIncrementalDiff).toHaveBeenCalledTimes(1);
    const promptContext = llm.reviewIncrementalDiff.mock.calls[0][5];
    expect(promptContext.length).toBeLessThanOrEqual(60_000);
    expect(promptContext).not.toContain('lateIdentifier');
  });
});
