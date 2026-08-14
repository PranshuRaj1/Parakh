/**
 * Review Pipeline Resilience Integration Tests
 *
 * Tests the critical failure paths from production logs at the service level.
 * Focuses on:
 * 1. DB retry wrapper handles Neon timeout errors
 * 2. Provider fallback chain works when Gemini quota exhausted
 * 3. LLM client routing survives provider failures
 *
 * These complement the existing pipeline-smoke.test.ts by specifically
 * protecting against the DB timeout + quota exhaustion failure mode.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { withDbRetry, isTransientDbError } from '../db/db-retry.js';
import { LLMClient, type LLMProvider, type ProviderName } from '../llm/provider.js';
import { AllKeysExhaustedError, DailyQuotaExhaustedError } from '../gemini/keyPool.js';
import { AllProvidersFailedError } from '../llm/errors.js';

// ─── Fake provider factory ─────────────────────────────────────────────────

function makeProvider(
  name: ProviderName,
  model: string,
  behavior: { reviewDiff?: 'ok' | 'daily' | 'exhausted' } = {}
): LLMProvider {
  return {
    providerName: name,
    modelName: model,
    reviewDiff: async () => {
      if (behavior.reviewDiff === 'daily') {
        throw new DailyQuotaExhaustedError(new Error(`${name} daily quota`));
      }
      if (behavior.reviewDiff === 'exhausted') {
        throw new AllKeysExhaustedError(new Error(`${name} all keys exhausted`));
      }
      return {
        genericFindings: [{ severity: 'LOW', file: `${name}-file.ts`, line: 1 }],
        ruleFindings: [],
        thinking: null,
      };
    },
    reviewIncrementalDiff: async () => ({
      genericFindings: [],
      ruleFindings: [],
      thinking: null,
      priorFindingResolutions: [],
    }),
    classifyIntent: async () => 'GENERAL',
    classifyRelationship: async () => 'UNRELATED',
    classifyPriority: async () => 'normal',
    draftReply: async () => 'ok',
  };
}

// ─── DB Retry: Neon timeout simulation ─────────────────────────────────────

describe('DB resilience: Neon timeout → retry → success', () => {
  it('retries NeonDbError timeout and recovers', async () => {
    let calls = 0;
    const result = await withDbRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new Error('NeonDbError: Error connecting to database: The operation was aborted due to timeout');
        }
        return 'recovered';
      },
      { maxAttempts: 3, baseDelayMs: 1 }
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('retries multiple Neon timeout errors before succeeding', async () => {
    let calls = 0;
    const result = await withDbRetry(
      async () => {
        calls++;
        if (calls <= 2) {
          throw new Error('NeonDbError: Error connecting to database: The operation was aborted due to timeout');
        }
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 1 }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('exhausts retries on persistent Neon timeout', async () => {
    await expect(
      withDbRetry(
        async () => {
          throw new Error('NeonDbError: Error connecting to database: The operation was aborted due to timeout');
        },
        { maxAttempts: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrow('timeout');
  });
});

// ─── Provider fallback: Exact production scenario ───────────────────────────

describe('Provider fallback: Gemini daily quota → Groq success', () => {
  it('completes review when Gemini exhausts daily quota', async () => {
    const gemini = makeProvider('gemini', 'gemini-2.0-flash', { reviewDiff: 'daily' });
    const groq = makeProvider('groq', 'llama-3.3-70b-versatile', { reviewDiff: 'ok' });

    const client = new LLMClient([gemini, groq]);
    const result = await client.reviewDiff('test.ts', 'diff', []);

    expect(result.genericFindings).toHaveLength(1);
    expect(result.genericFindings[0].file).toBe('groq-file.ts');
    expect(client.servedProvider).toBe('groq');
  });

  it('Gemini stays unavailable after daily quota for subsequent calls', async () => {
    const gemini = makeProvider('gemini', 'gemini-2.0-flash', { reviewDiff: 'daily' });
    const groq = makeProvider('groq', 'llama-3.3-70b-versatile', { reviewDiff: 'ok' });

    const client = new LLMClient([gemini, groq]);

    await client.reviewDiff('file1.ts', 'diff1', []);
    await client.reviewDiff('file2.ts', 'diff2', []);
    await client.reviewDiff('file3.ts', 'diff3', []);

    expect(client.servedProvider).toBe('groq');
  });
});

// ─── Provider fallback: All providers exhausted ─────────────────────────────

describe('Provider fallback: all providers exhausted', () => {
  it('throws when every provider hits daily quota', async () => {
    const gemini = makeProvider('gemini', 'gem', { reviewDiff: 'daily' });
    const groq = makeProvider('groq', 'groq', { reviewDiff: 'daily' });
    const cfai = makeProvider('cfai', 'cf', { reviewDiff: 'daily' });

    const client = new LLMClient([gemini, groq, cfai]);

    await expect(client.reviewDiff('test.ts', 'diff', [])).rejects.toThrow();
  });
});

// ─── Provider fallback: Mixed success across files ──────────────────────────

describe('Provider fallback: mixed failures across review pipeline', () => {
  it('handles Gemini failure on first file, then Groq for remaining', async () => {
    const gemini = makeProvider('gemini', 'gemini-2.0-flash', { reviewDiff: 'daily' });
    const groq = makeProvider('groq', 'llama-3.3-70b-versatile', { reviewDiff: 'ok' });

    const client = new LLMClient([gemini, groq]);

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await client.reviewDiff(`file${i}.ts`, `diff${i}`, []));
    }

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.genericFindings).toHaveLength(1);
      expect(result.genericFindings[0].file).toBe('groq-file.ts');
    }
  });
});

// ─── Combined: DB retry + provider fallback ─────────────────────────────────

describe('Combined resilience: DB retry + provider fallback', () => {
  it('DB timeout retry succeeds, then provider fallback works', async () => {
    // Step 1: DB retry recovers from Neon timeout
    let dbCalls = 0;
    const dbResult = await withDbRetry(
      async () => {
        dbCalls++;
        if (dbCalls === 1) {
          throw new Error('NeonDbError: timeout');
        }
        return [{ id: 'rule-1', body: 'test rule' }];
      },
      { maxAttempts: 3, baseDelayMs: 1 }
    );
    expect(dbResult).toHaveLength(1);
    expect(dbCalls).toBe(2);

    // Step 2: Provider fallback handles Gemini quota exhaustion
    const gemini = makeProvider('gemini', 'gem', { reviewDiff: 'daily' });
    const groq = makeProvider('groq', 'groq', { reviewDiff: 'ok' });
    const client = new LLMClient([gemini, groq]);

    const reviewResult = await client.reviewDiff('test.ts', 'diff', []);
    expect(reviewResult.genericFindings[0].file).toBe('groq-file.ts');
    expect(client.servedProvider).toBe('groq');
  });

  it('DB timeout on all attempts + provider fallback = graceful failure', async () => {
    // DB completely unavailable
    await expect(
      withDbRetry(
        async () => {
          throw new Error('NeonDbError: timeout');
        },
        { maxAttempts: 3, baseDelayMs: 1 }
      )
    ).rejects.toThrow('timeout');

    // Even if DB was available, provider fallback would still work
    const gemini = makeProvider('gemini', 'gem', { reviewDiff: 'daily' });
    const groq = makeProvider('groq', 'groq', { reviewDiff: 'ok' });
    const client = new LLMClient([gemini, groq]);

    const reviewResult = await client.reviewDiff('test.ts', 'diff', []);
    expect(client.servedProvider).toBe('groq');
  });
});
