import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { mockGenerateEmbedding, mockClassifyPriority, mockConsoleError, sqlImpl, getDbMock } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(),
  mockClassifyPriority: vi.fn(),
  mockConsoleError: vi.fn(),
  sqlImpl: vi.fn(),
  getDbMock: vi.fn(() => sqlImpl),
}));

// Stub the LLM factory so rule creation can run without a real model call:
// classifyPriority is used when no priority override is supplied, and
// generateEmbedding produces the embedding vector stored on the new rule.
vi.mock('../llm/factory.js', () => ({
  createLLMClients: () => ({
    llm: {
      classifyPriority: mockClassifyPriority,
      generateEmbedding: mockGenerateEmbedding,
    },
    gemini: {},
    groq: {},
  }),
}));

vi.mock('./contradiction.js', () => ({ executeContradictionJob: vi.fn() }));
vi.mock('../db/rules.js', () => ({ insertRule: vi.fn() }));
vi.mock('../db/client.js', () => ({ getDb: getDbMock }));

import { handleCreateRule, handleApproveRule, handleRejectRule } from './rule-api.js';
import { executeContradictionJob } from './contradiction.js';
import { insertRule } from '../db/rules.js';
import { getDb } from '../db/client.js';

const mocked = {
  executeContradictionJob: vi.mocked(executeContradictionJob),
  insertRule: vi.mocked(insertRule),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
} as unknown as Env;

function makeCtx() {
  return { waitUntil: vi.fn() } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(mockConsoleError);
  mockConsoleError.mockReset();
  mocked.executeContradictionJob.mockReset().mockResolvedValue(undefined);
  mocked.insertRule.mockReset().mockResolvedValue({ id: 'rule-1' } as never);
  mockGenerateEmbedding.mockReset().mockResolvedValue([0.1, 0.2]);
  mockClassifyPriority.mockReset().mockResolvedValue('normal');
});

describe('handleCreateRule', () => {
  it('rejects requests missing repo or body', async () => {
    await expect(handleCreateRule({ repo: '', body: 'x' }, env)).rejects.toThrow('Missing required fields');
    await expect(handleCreateRule({ repo: 'acme/app', body: '' }, env)).rejects.toThrow('Missing required fields');
  });

  it('uses the supplied priority override without asking the LLM', async () => {
    await handleCreateRule({ repo: 'acme/app', body: 'Never store secrets', priority: 'high' }, env, makeCtx());

    expect(mockClassifyPriority).not.toHaveBeenCalled();
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/app', body: 'Never store secrets', status: 'ACTIVE', priority: 'high' }),
      env
    );
  });

  it('classifies priority when not supplied', async () => {
    await handleCreateRule({ repo: 'acme/app', body: 'Never store secrets' }, env, makeCtx());
    expect(mockClassifyPriority).toHaveBeenCalledWith('Never store secrets');
  });

  it('fails open to normal priority when priority classification errors', async () => {
    mockClassifyPriority.mockRejectedValue(new Error('timeout'));

    await handleCreateRule({ repo: 'acme/app', body: 'Never store secrets' }, env, makeCtx());

    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'normal' }),
      env
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Priority classification failed for "Never store secrets" (repo: acme/app)'),
      expect.objectContaining({ message: 'timeout' })
    );
  });

  it('inserts the rule with the generated embedding and enqueues a contradiction check', async () => {
    const ctx = makeCtx();
    const result = await handleCreateRule(
      { repo: 'acme/app', body: 'Never store secrets', scope: { include: ['src/**'] } },
      env,
      ctx
    );

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('Never store secrets');
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/app',
        embedding: [0.1, 0.2],
        scope: { include: ['src/**'] },
      }),
      env
    );
    expect(mocked.executeContradictionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONTRADICTION',
        ruleId: 'rule-1',
        owner: 'acme',
        repo: 'app',
        prNumber: 0,
        ruleBody: 'Never store secrets',
        embedding: [0.1, 0.2],
      }),
      env
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rule: expect.objectContaining({ id: 'rule-1' }), contradictionCheckEnqueued: true });
  });

  it('does not run the contradiction check without an execution context', async () => {
    const result = await handleCreateRule({ repo: 'acme/app', body: 'x' }, env);
    expect(mocked.executeContradictionJob).not.toHaveBeenCalled();
    expect(result.contradictionCheckEnqueued).toBe(true);
  });
});

describe('handleApproveRule / handleRejectRule', () => {
  const VALID_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  it('rejects a malformed rule id before touching the database', async () => {
    sqlImpl.mockReset();
    getDbMock.mockClear();

    await expect(handleApproveRule('not-a-uuid; DROP TABLE rules', env)).rejects.toThrow('Invalid rule id');
    await expect(handleRejectRule('', env)).rejects.toThrow('Invalid rule id');
    expect(getDb).not.toHaveBeenCalled();
  });

  it('approves a PENDING rule by flipping it to ACTIVE', async () => {
    sqlImpl.mockReset().mockResolvedValueOnce([{ id: VALID_UUID }]);

    await expect(handleApproveRule(VALID_UUID, env)).resolves.toBeUndefined();

    const [strings, ...values] = sqlImpl.mock.calls[0];
    expect(strings.join('')).toContain('WHERE id =');
    expect(values[0]).toBe('ACTIVE');
    expect(values[1]).toBe(VALID_UUID);
  });

  it('rejects a PENDING rule by flipping it to INACTIVE', async () => {
    sqlImpl.mockReset().mockResolvedValueOnce([{ id: VALID_UUID }]);

    await expect(handleRejectRule(VALID_UUID, env)).resolves.toBeUndefined();

    const [strings, ...values] = sqlImpl.mock.calls[0];
    expect(strings.join('')).toContain('WHERE id =');
    expect(values[0]).toBe('INACTIVE');
    expect(values[1]).toBe(VALID_UUID);
  });

  it('errors when the rule does not exist or is not PENDING', async () => {
    sqlImpl.mockReset().mockResolvedValueOnce([]);

    await expect(handleApproveRule(VALID_UUID, env)).rejects.toThrow('not found or not in PENDING');
  });
});
