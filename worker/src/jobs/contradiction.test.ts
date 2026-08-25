import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { classifyRelationshipMock, mockResolveUserCreds } = vi.hoisted(() => ({
  classifyRelationshipMock: vi.fn(),
  mockResolveUserCreds: vi.fn(),
}));

// BYO-keys: the contradiction path resolves the installing user's keys before
// building the client stack. Stubbed to an installed user WITH keys.
vi.mock('../llm/user-creds.js', () => ({
  resolveUserCreds: mockResolveUserCreds,
  isSharedLLMKeyAccount: () => true,
}));

// Stub the LLM factory: only classifyRelationship drives the contradiction
// paths under test. gemini/groq get full LLMProvider-shaped vi.fn()s so any
// future call into them fails loudly instead of a silent TypeError on {}.
vi.mock('../llm/factory.js', () => ({
  createLLMClients: () => ({
    llm: {
      classifyRelationship: classifyRelationshipMock,
    },
    gemini: {
      reviewDiff: vi.fn(),
      classifyIntent: vi.fn(),
      classifyRelationship: vi.fn(),
      classifyPriority: vi.fn(),
      draftReply: vi.fn(),
      generateEmbedding: vi.fn(),
    },
    groq: {
      reviewDiff: vi.fn(),
      classifyIntent: vi.fn(),
      classifyRelationship: vi.fn(),
      classifyPriority: vi.fn(),
      draftReply: vi.fn(),
    },
  }),
}));

vi.mock('../github/auth.js', () => ({ getCachedToken: vi.fn() }));
vi.mock('../github/api.js', () => ({ postComment: vi.fn() }));
vi.mock('../db/rules.js', () => ({
  findSimilarRules: vi.fn(),
  updateRuleStatus: vi.fn(),
  setRuleSupersedes: vi.fn(),
  incrementReinforcementCount: vi.fn(),
  insertRuleRelationship: vi.fn(),
}));

import { executeContradictionJob } from './contradiction.js';
import { postComment } from '../github/api.js';
import { getCachedToken } from '../github/auth.js';
import {
  findSimilarRules,
  updateRuleStatus,
  setRuleSupersedes,
  incrementReinforcementCount,
  insertRuleRelationship,
} from '../db/rules.js';

const mocked = {
  findSimilarRules: vi.mocked(findSimilarRules),
  updateRuleStatus: vi.mocked(updateRuleStatus),
  setRuleSupersedes: vi.mocked(setRuleSupersedes),
  incrementReinforcementCount: vi.mocked(incrementReinforcementCount),
  insertRuleRelationship: vi.mocked(insertRuleRelationship),
  postComment: vi.mocked(postComment),
  getCachedToken: vi.mocked(getCachedToken),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
} as unknown as Env;

function payload(overrides: Partial<{ prNumber: number; installationId: number }> = {}) {
  return {
    type: 'CONTRADICTION' as const,
    installationId: 0,
    owner: 'acme',
    repo: 'app',
    prNumber: 0,
    ruleId: 'new-rule',
    ruleBody: 'Use Zustand',
    embedding: [1, 2, 3],
    ...overrides,
  };
}

function candidate(id: string) {
  return {
    id,
    repo: 'acme/app',
    body: 'Use Redux',
    status: 'ACTIVE' as const,
    scope: {},
    priority: 'normal' as const,
    supersedes: null,
    superseded_by: null,
    source_pr: null,
    evidence_count: 0,
    reinforcement_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    superseded_at: null,
    similarity: 0.9,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const fn of Object.values(mocked)) fn.mockReset();
  mocked.getCachedToken.mockResolvedValue('token');
  mockResolveUserCreds.mockReset().mockResolvedValue({
    githubLogin: 'installer-user',
    geminiKeys: ['fake-gemini-key'],
    groqKeys: [],
    cfaiAccountId: null,
    cfaiToken: null,
    openrouterKey: null,
  });
});

describe('executeContradictionJob', () => {
  it('leaves the rule alone when there are no similar candidates', async () => {
    mocked.findSimilarRules.mockResolvedValue([]);
    await executeContradictionJob(payload(), env);

    expect(mocked.findSimilarRules).toHaveBeenCalledWith(
      'acme/app', [1, 2, 3], 0.7, 5, env, 'new-rule'
    );
    expect(mocked.updateRuleStatus).not.toHaveBeenCalled();
    expect(mocked.insertRuleRelationship).not.toHaveBeenCalled();
  });

  it('skips the classification when the installing user has no keys (BYO-keys gate)', async () => {
    mocked.findSimilarRules.mockResolvedValue([candidate('old-rule')]);
    mockResolveUserCreds.mockResolvedValue(null);

    await executeContradictionJob(payload(), env);

    expect(classifyRelationshipMock).not.toHaveBeenCalled();
    expect(mocked.updateRuleStatus).not.toHaveBeenCalled();
    expect(mocked.insertRuleRelationship).not.toHaveBeenCalled();
  });

  it('supersedes the old rule on CONTRADICTION and notifies the PR', async () => {
    mocked.findSimilarRules.mockResolvedValue([candidate('old-rule')]);
    classifyRelationshipMock.mockResolvedValue('CONTRADICTION');

    await executeContradictionJob(payload({ prNumber: 7, installationId: 5 }), env);

    expect(mocked.updateRuleStatus).toHaveBeenCalledWith('old-rule', 'SUPERSEDED', env, 'new-rule');
    expect(mocked.setRuleSupersedes).toHaveBeenCalledWith('new-rule', 'old-rule', env);
    // token is fetched for the payload's installation, not a hardcoded 0
    expect(mocked.getCachedToken).toHaveBeenCalledWith(5, '123', 'key', expect.any(Object));
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7,
      expect.stringContaining('Superseded rule'),
      'token'
    );
  });

  it('does not post a comment for a CONTRADICTION without a PR', async () => {
    mocked.findSimilarRules.mockResolvedValue([candidate('old-rule')]);
    classifyRelationshipMock.mockResolvedValue('CONTRADICTION');

    await executeContradictionJob(payload(), env);
    expect(mocked.postComment).not.toHaveBeenCalled();
  });

  it('deactivates the new rule on DUPLICATE and stops checking further candidates', async () => {
    mocked.findSimilarRules.mockResolvedValue([candidate('c1'), candidate('c2')]);
    classifyRelationshipMock.mockResolvedValueOnce('DUPLICATE');

    await executeContradictionJob(payload({ prNumber: 7 }), env);

    expect(mocked.updateRuleStatus).toHaveBeenCalledWith('new-rule', 'INACTIVE', env);
    expect(mocked.incrementReinforcementCount).toHaveBeenCalledWith('c1', env);
    expect(mocked.insertRuleRelationship).toHaveBeenCalledWith('new-rule', 'c1', 'DUPLICATE', env);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Duplicate rule detected'), 'token'
    );
    // short-circuit: the second candidate is never classified or processed
    expect(classifyRelationshipMock).toHaveBeenCalledTimes(1);
    expect(mocked.setRuleSupersedes).not.toHaveBeenCalled();
  });

  it('links both rules on REFINEMENT and keeps checking remaining candidates', async () => {
    mocked.findSimilarRules.mockResolvedValue([candidate('c1'), candidate('c2')]);
    classifyRelationshipMock
      .mockResolvedValueOnce('REFINEMENT')
      .mockResolvedValueOnce('UNRELATED');

    await executeContradictionJob(payload({ prNumber: 7 }), env);

    expect(mocked.insertRuleRelationship).toHaveBeenCalledWith('new-rule', 'c1', 'REFINEMENT', env);
    expect(mocked.postComment).toHaveBeenCalledWith(
      'acme', 'app', 7, expect.stringContaining('Refines existing rule'), 'token'
    );
    expect(classifyRelationshipMock).toHaveBeenCalledTimes(2);
  });

  it('takes no action for UNRELATED relationships', async () => {
    mocked.findSimilarRules.mockResolvedValue([candidate('c1')]);
    classifyRelationshipMock.mockResolvedValue('UNRELATED');

    await executeContradictionJob(payload(), env);

    expect(mocked.updateRuleStatus).not.toHaveBeenCalled();
    expect(mocked.insertRuleRelationship).not.toHaveBeenCalled();
    expect(mocked.postComment).not.toHaveBeenCalled();
  });
});
