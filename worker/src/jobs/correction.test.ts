import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';

const { generateEmbeddingMock, classifyPriorityMock } = vi.hoisted(() => ({
  generateEmbeddingMock: vi.fn(),
  classifyPriorityMock: vi.fn(),
}));

vi.mock('../gemini/client.js', () => ({
  GeminiClient: class {
    generateEmbedding = generateEmbeddingMock;
    classifyPriority = classifyPriorityMock;
  },
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

function input(overrides: Partial<{ commentBody: string; prNumber: number }> = {}) {
  return {
    installationId: 1,
    owner: 'acme',
    repo: 'app',
    prNumber: 7,
    commentBody: 'never flag EOF newline issues',
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocked.insertRule.mockReset().mockResolvedValue({ id: 'rule-9' } as never);
  generateEmbeddingMock.mockReset().mockResolvedValue([0.1, 0.2]);
  classifyPriorityMock.mockReset().mockResolvedValue('normal');
  vi.mocked(env.WATCHDOG_QUEUE.send).mockReset().mockResolvedValue(undefined);
});

describe('saveCorrectionAsRule', () => {
  it('embeds, classifies priority, inserts an ACTIVE rule with source_pr, and enqueues a contradiction check', async () => {
    await saveCorrectionAsRule(input(), env);

    expect(generateEmbeddingMock).toHaveBeenCalledWith('never flag EOF newline issues');
    expect(classifyPriorityMock).toHaveBeenCalledWith('never flag EOF newline issues');
    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'acme/app',
        body: 'never flag EOF newline issues',
        embedding: [0.1, 0.2],
        status: 'ACTIVE',
        priority: 'normal',
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

  it('removes the @parakh command metadata before storing and embedding the rule', async () => {
    await saveCorrectionAsRule(input({ commentBody: '@parakh we never flag EOF newline issues' }), env);

    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'we never flag EOF newline issues' }),
      env
    );
    expect(env.WATCHDOG_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ ruleBody: 'we never flag EOF newline issues' })
    );
  });

  it('stores forward-looking suppression directives as instruction rules', async () => {
    await saveCorrectionAsRule(
      input({ commentBody: '@parakh stop flagging "No newline at the end of the file" in any future review' }),
      env
    );

    expect(mocked.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'instruction' }),
      env
    );
  });

  it('stores ordinary corrections as standard rules', async () => {
    await saveCorrectionAsRule(input({ commentBody: 'use snake_case for database columns' }), env);

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
