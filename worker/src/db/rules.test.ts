/**
 * Rules DB Layer Unit Tests
 *
 * Focus: the fail-fast embedding dimension guard on insertRule — the
 * regression that shipped as a silent Neon `expected 768 dimensions, not 1024`
 * runtime failure when a provider returned a wrong-width embedding. The guard
 * must reject mismatched embeddings BEFORE any SQL is built, and accept the
 * exact 768-dim width the vector(768) column expects.
 *
 * getDb is mocked to a tagged-template stub so the SQL is never executed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import { EMBEDDING_DIMENSIONS } from '@parakh/shared';

vi.mock('./client.js', () => ({ getDb: vi.fn() }));

import { getDb } from './client.js';
import { insertRule, findSimilarRules } from './rules.js';

const mockedGetDb = vi.mocked(getDb);

const env = { DATABASE_URL: 'postgres://x' } as unknown as Env;

function ruleInput(embedding: number[]) {
  return {
    repo: 'acme/app',
    body: 'never flag EOF newline issues',
    embedding,
    status: 'ACTIVE' as const,
    priority: 'normal' as const,
    mode: 'suppress' as const,
    patterns: ['newline'],
    source_pr: 7,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mockedGetDb.mockReset();
});

describe('insertRule embedding dimension guard', () => {
  it('throws before running SQL when the embedding is not 768-dim', async () => {
    mockedGetDb.mockReturnValue((() => {
      throw new Error('getDb should never be called for a mismatched embedding');
    }) as never);

    await expect(
      insertRule(ruleInput(Array(1024).fill(0.1)), env)
    ).rejects.toThrow(/Embedding dimension mismatch: got 1024, expected 768/);
    expect(mockedGetDb).not.toHaveBeenCalled();
  });

  it('throws for a zero-length embedding too', async () => {
    await expect(insertRule(ruleInput([]), env)).rejects.toThrow(
      /got 0, expected 768/
    );
    expect(mockedGetDb).not.toHaveBeenCalled();
  });

  it('accepts a 768-dim embedding and passes the vector string to the query', async () => {
    const embedding = Array(EMBEDDING_DIMENSIONS).fill(0.5);
    const sql = vi.fn().mockResolvedValue([{ id: 'rule-9' }]);
    mockedGetDb.mockReturnValue(sql as never);

    const rule = await insertRule(ruleInput(embedding), env);

    expect(mockedGetDb).toHaveBeenCalledWith('postgres://x');
    expect(rule.id).toBe('rule-9');
    const [strings, ...values] = sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('')).toContain('INSERT INTO rules');
    expect(values).toContain(`[${embedding.join(',')}]`);
  });
});

describe('findSimilarRules', () => {
  it('passes repo, embedding vector, threshold, limit and exclude id into the query', async () => {
    const embedding = Array(EMBEDDING_DIMENSIONS).fill(0.2);
    const sql = vi.fn().mockResolvedValue([{ id: 'old-rule', similarity: 0.9 }]);
    mockedGetDb.mockReturnValue(sql as never);

    const rows = await findSimilarRules('acme/app', embedding, 0.7, 5, env, 'new-rule');

    expect(mockedGetDb).toHaveBeenCalledWith('postgres://x');
    expect(rows[0].similarity).toBe(0.9);
    const [strings, ...values] = sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('')).toContain('embedding <=>');
    expect(values).toContain(`[${embedding.join(',')}]`);
    expect(values).toContain(0.7);
    expect(values).toContain(5);
  });
});
