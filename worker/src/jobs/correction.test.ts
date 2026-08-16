import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { mockGenerateEmbedding, mockClassifyPriority } = vi.hoisted(() => ({
  mockGenerateEmbedding: vi.fn(),
  mockClassifyPriority: vi.fn(),
}));

// Stub the LLM factory so the correction path can run without a real model:
// generateEmbedding produces the stored embedding. classifyPriority is stubbed
// but must NOT be called anymore — priority comes from the folded call.
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

vi.mock('../db/rules.js', () => ({ insertRule: vi.fn() }));

import { saveCorrectionAsRule, isInstructionRule } from './correction.js';
import { insertRule } from '../db/rules.js';

const mocked = {
  insertRule: vi.mocked(insertRule),
};

const env = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'key',
  UPSTASH_REDIS_URL: 'https://redis',
  UPSTASH_REDIS_TOKEN: 't',
  WATCHDOG_QUEUE: { send: vi.fn() },
} as unknown as Env;

function makeInput(overrides: Partial<{ ruleBody: string; priority: 'high' | 'normal'; prNumber: number }> = {}) {
  return {
    installationId: 1,
    owner: 'acme',
    repo: 'app',
    prNumber: 7,
    ruleBody: 'never flag EOF newline issues',
    priority: 'normal' as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocked.insertRule.mockReset().mockResolvedValue({ id: 'rule-9' } as never);
  mockGenerateEmbedding.mockReset().mockResolvedValue([0.1, 0.2]);
  mockClassifyPriority.mockReset().mockResolvedValue('normal');
  vi.mocked(env.WATCHDOG_QUEUE.send).mockReset().mockResolvedValue(undefined);
});

describe('saveCorrectionAsRule', () => {
  it('embeds the extracted rule body, inserts an ACTIVE rule with source_pr, and enqueues a contradiction check', async () => {
    await saveCorrectionAsRule(makeInput(), env);

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('never flag EOF newline issues');
    expect(mockClassifyPriority).not.toHaveBeenCalled();
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/app',
        body: 'never flag EOF newline issues',
        embedding: [0.1, 0.2],
        status: 'ACTIVE',
        priority: 'normal',
        kind: 'instruction',
        source_pr: 7,
      }),
      env
    );
    expect(env.WATCHDOG_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CONTRADICTION',
        installationId: 1,
        owner: 'acme',
        repo: 'app',
        prNumber: 7,
        ruleId: 'rule-9',
        ruleBody: 'never flag EOF newline issues',
        embedding: [0.1, 0.2],
      })
    );
  });

  it('does not re-classify priority — uses the priority from the folded call, fallback normal', async () => {
    await saveCorrectionAsRule(makeInput({ priority: 'high' }), env);
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'high' }),
      env
    );

    await saveCorrectionAsRule(makeInput({ priority: undefined }), env);
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'normal' }),
      env
    );
  });

  it('still saves the rule when enqueueing the contradiction check fails', async () => {
    vi.mocked(env.WATCHDOG_QUEUE.send).mockRejectedValue(new Error('queue down'));

    const rule = await saveCorrectionAsRule(makeInput(), env);

    expect(mocked.insertRule).toHaveBeenCalled();
    expect(rule).toMatchObject({ id: 'rule-9' });
  });

  it('keeps the extracted rule body verbatim (no @parakh stripping — the LLM extracts clean bodies)', async () => {
    await saveCorrectionAsRule(makeInput({ ruleBody: 'use snake_case for database columns' }), env);

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('use snake_case for database columns');
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'use snake_case for database columns' }),
      env
    );
    expect(env.WATCHDOG_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ ruleBody: 'use snake_case for database columns' })
    );
  });

  it('rejects an empty extracted rule body', async () => {
    await expect(saveCorrectionAsRule(makeInput({ ruleBody: '   ' }), env)).rejects.toThrow(
      'Correction must include rule text'
    );
    expect(mocked.insertRule).not.toHaveBeenCalled();
  });

  it('stores forward-looking suppression directives as instruction rules', async () => {
    await saveCorrectionAsRule(
      makeInput({ ruleBody: 'stop flagging "No newline at the end of the file" in any future review' }),
      env
    );

    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'instruction' }),
      env
    );
  });

  it('stores ordinary corrections as standard rules', async () => {
    await saveCorrectionAsRule(makeInput({ ruleBody: 'use snake_case for database columns' }), env);

    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'standard' }),
      env
    );
  });
});

describe('isInstructionRule', () => {
  it('detects suppression phrasing', () => {
    expect(isInstructionRule('stop flagging EOF newlines')).toBe(true);
    expect(isInstructionRule('do not raise unbounded loops in future reviews')).toBe(true);
    expect(isInstructionRule('never flag X')).toBe(true);
  });

  it('treats plain standards as non-instructions', () => {
    expect(isInstructionRule('use snake_case for database columns')).toBe(false);
    expect(isInstructionRule('always handle promise rejections')).toBe(false);
  });
});