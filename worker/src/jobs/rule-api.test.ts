import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { generateEmbeddingMock, classifyPriorityMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(),
  classifyPriorityMock: vi.fn(),
}));

vi.mock('../llm/factory.js', () => ({
  createLLMClients: () => ({
    llm: {
      classifyPriority: classifyPriorityMock,
    },
    gemini: {
      generateEmbedding: generateEmbeddingMock,
    },
    groq: {},
  }),
}));

vi.mock('./contradiction.js', () => ({ executeContradictionJob: vi.fn() }));
vi.mock('../db/rules.js', () => ({ insertRule: vi.fn() }));

import { handleCreateRule } from './rule-api.js';
import { executeContradictionJob } from './contradiction.js';
import { insertRule } from '../db/rules.js';

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
  mocked.executeContradictionJob.mockReset().mockResolvedValue(undefined);
  mocked.insertRule.mockReset().mockResolvedValue({ id: 'rule-1' } as never);
  generateEmbeddingMock.mockReset().mockResolvedValue([0.1, 0.2]);
  classifyPriorityMock.mockReset().mockResolvedValue('normal');
});

describe('handleCreateRule', () => {
  it('rejects requests missing repo or body', async () => {
    await expect(handleCreateRule({ repo: '', body: 'x' }, env)).rejects.toThrow('Missing required fields');
    await expect(handleCreateRule({ repo: 'acme/app', body: '' }, env)).rejects.toThrow('Missing required fields');
  });

  it('uses the supplied priority override without asking the LLM', async () => {
    await handleCreateRule({ repo: 'acme/app', body: 'Never store secrets', priority: 'high' }, env, makeCtx());

    expect(classifyPriorityMock).not.toHaveBeenCalled();
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/app', body: 'Never store secrets', status: 'ACTIVE', priority: 'high' }),
      env
    );
  });

  it('classifies priority when not supplied', async () => {
    await handleCreateRule({ repo: 'acme/app', body: 'Never store secrets' }, env, makeCtx());
    expect(classifyPriorityMock).toHaveBeenCalledWith('Never store secrets');
  });

  it('inserts the rule with the generated embedding and enqueues a contradiction check', async () => {
    const ctx = makeCtx();
    const result = await handleCreateRule(
      { repo: 'acme/app', body: 'Never store secrets', scope: { include: ['src/**'] } },
      env,
      ctx
    );

    expect(generateEmbeddingMock).toHaveBeenCalledWith('Never store secrets');
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
