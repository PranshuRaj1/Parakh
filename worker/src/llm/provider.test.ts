import { describe, expect, it } from 'vitest';
import { AllKeysExhaustedError, DailyQuotaExhaustedError } from '../gemini/keyPool.js';
import { LLMClient, resolveProviderChain, type LLMProvider, type ProviderName } from './provider.js';
import { AllProvidersFailedError, ProviderHealthError, ProviderResponseError } from './errors.js';

/** Build a fake provider that records calls and throws/returns per script. */
function makeProvider(
  name: ProviderName,
  model: string,
  onReview: 'ok' | 'exhausted' | 'daily' | 'boom'
): LLMProvider {
  return {
    providerName: name,
    modelName: model,
    reviewDiff: async () => {
      if (onReview === 'exhausted') throw new AllKeysExhaustedError(new Error(`${name} rate-limited`));
      if (onReview === 'daily') throw new DailyQuotaExhaustedError(new Error(`${name} daily quota`));
      if (onReview === 'boom') throw new Error(`${name} boom`);
      return { genericFindings: [{ severity: 'LOW', file: 'x.ts', line: 1 }], ruleFindings: [], thinking: null };
    },
    reviewIncrementalDiff: async () => {
      if (onReview === 'exhausted') throw new AllKeysExhaustedError(new Error(`${name} rate-limited`));
      if (onReview === 'daily') throw new DailyQuotaExhaustedError(new Error(`${name} daily quota`));
      if (onReview === 'boom') throw new Error(`${name} boom`);
      return {
        genericFindings: [], ruleFindings: [], thinking: null,
        priorFindingResolutions: [{ findingId: 'prior-1', status: 'STILL_PRESENT' }],
      };
    },
    classifyIntent: async () => ({ intent: 'GENERAL' as const, rules: [], ignored: [] }),
    classifyRelationship: async () => 'UNRELATED',
    classifyPriority: async () => 'normal',
    draftReply: async () => 'ok',
  };
}

/** Fake provider that DOES implement generateEmbedding, per an onEmbed script. */
function makeEmbeddingProvider(
  name: ProviderName,
  model: string,
  onEmbed: 'ok' | 'exhausted' | 'boom'
): LLMProvider {
  return {
    ...makeProvider(name, model, 'ok'),
    generateEmbedding: async () => {
      if (onEmbed === 'exhausted') throw new AllKeysExhaustedError(new Error(`${name} embedding rate-limited`));
      if (onEmbed === 'boom') throw new Error(`${name} embedding boom`);
      return Array(768).fill(0.1);
    },
  };
}

describe('resolveProviderChain', () => {
  it('defaults to gemini -> groq, then appends other providers in priority order', () => {
    const chain = resolveProviderChain({} as never);
    expect(chain).toEqual(['gemini', 'groq', 'cfai', 'openrouter']);
  });

  it('keeps the named primary/fallback first and dedupes', () => {
    const chain = resolveProviderChain({ LLM_PRIMARY: 'groq', LLM_FALLBACK: 'none' } as never);
    expect(chain).toEqual(['groq', 'gemini', 'cfai', 'openrouter']);
  });

  it('honors a custom fallback that is not the default', () => {
    const chain = resolveProviderChain({ LLM_PRIMARY: 'gemini', LLM_FALLBACK: 'cfai' } as never);
    expect(chain).toEqual(['gemini', 'cfai', 'groq', 'openrouter']);
  });
});

describe('LLMClient chain routing', () => {
  it('routes incremental reviews through the same provider chain', async () => {
    const exhausted = makeProvider('gemini', 'g', 'exhausted');
    const healthy = makeProvider('groq', 'q', 'ok');
    const client = new LLMClient([exhausted, healthy]);
    const result = await client.reviewIncrementalDiff('f.ts', 'd', [], []);
    expect(result.priorFindingResolutions).toEqual([
      { findingId: 'prior-1', status: 'STILL_PRESENT' },
    ]);
    expect(client.servedProvider).toBe('groq');
  });

  it('falls through providers only on exhaustion, serving from the first healthy one', async () => {
    const slow = makeProvider('gemini', 'g', 'daily');
    const mid = makeProvider('groq', 'q', 'exhausted');
    const fast = makeProvider('cfai', 'c', 'ok');
    const client = new LLMClient([slow, mid, fast]);

    const result = await client.reviewDiff('f.ts', 'd', []);
    expect(result.genericFindings[0].file).toBe('x.ts');
    // Label reports the provider that actually served the call.
    expect(client.modelName).toBe('c');
  });

  it('opens a delivery-local circuit after daily quota exhaustion', async () => {
    let geminiCalls = 0;
    let groqCalls = 0;
    const exhausted = makeProvider('gemini', 'g', 'daily');
    exhausted.reviewDiff = async () => {
      geminiCalls++;
      throw new DailyQuotaExhaustedError(new Error('gemini daily quota'));
    };
    const healthy = makeProvider('groq', 'q', 'ok');
    const healthyReview = healthy.reviewDiff;
    healthy.reviewDiff = async (...args) => {
      groqCalls++;
      return healthyReview(...args);
    };
    const client = new LLMClient([exhausted, healthy]);

    await client.reviewDiff('a.ts', 'd', []);
    await client.reviewDiff('b.ts', 'd', []);
    await client.reviewDiff('c.ts', 'd', []);

    expect(geminiCalls).toBe(1);
    expect(groqCalls).toBe(3);
  });

  it('throws daily quota when every configured provider circuit is open', async () => {
    let geminiCalls = 0;
    let groqCalls = 0;
    const gemini = makeProvider('gemini', 'g', 'daily');
    const groq = makeProvider('groq', 'q', 'daily');
    const geminiReview = gemini.reviewDiff;
    const groqReview = groq.reviewDiff;
    gemini.reviewDiff = async (...args) => {
      geminiCalls++;
      return geminiReview(...args);
    };
    groq.reviewDiff = async (...args) => {
      groqCalls++;
      return groqReview(...args);
    };
    const client = new LLMClient([gemini, groq]);

    await expect(client.reviewDiff('a.ts', 'd', [])).rejects.toBeInstanceOf(DailyQuotaExhaustedError);
    await expect(client.reviewDiff('b.ts', 'd', [])).rejects.toBeInstanceOf(DailyQuotaExhaustedError);

    expect(geminiCalls).toBe(1);
    expect(groqCalls).toBe(1);
  });

  it('falls through non-exhaustion errors to the next provider', async () => {
    const broken = makeProvider('gemini', 'g', 'boom');
    const fine = makeProvider('groq', 'q', 'ok');
    const client = new LLMClient([broken, fine]);
    await expect(client.reviewDiff('f.ts', 'd', [])).resolves.toBeDefined();
    expect(client.servedProvider).toBe('groq');
  });

  it('throws the last provider error when every provider in the chain fails', async () => {
    const a = makeProvider('gemini', 'g', 'boom');
    const b = makeProvider('groq', 'q', 'boom');
    const client = new LLMClient([a, b]);
    try {
      await client.reviewDiff('f.ts', 'd', []);
      throw new Error('expected chain failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AllProvidersFailedError);
      const failure = error as AllProvidersFailedError;
      expect(failure.lastError?.message).toContain('groq boom');
    }
  });

  it('throws an aggregate failure when every provider is exhausted', async () => {
    const a = makeProvider('gemini', 'g', 'exhausted');
    const b = makeProvider('groq', 'q', 'exhausted');
    const client = new LLMClient([a, b]);
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('does not report total daily quota exhaustion when only the last provider is quota-bound', async () => {
    const a = makeProvider('gemini', 'g', 'exhausted');
    const b = makeProvider('groq', 'q', 'daily');
    const client = new LLMClient([a, b]);
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toBeInstanceOf(AllProvidersFailedError);
  });

  it('falls through retryable provider-health errors', async () => {
    const unhealthy = makeProvider('gemini', 'g', 'ok');
    unhealthy.reviewDiff = async () => { throw new ProviderHealthError('gemini', 503, 'unavailable'); };
    const healthy = makeProvider('groq', 'q', 'ok');
    const client = new LLMClient([unhealthy, healthy]);
    await expect(client.reviewDiff('f.ts', 'd', [])).resolves.toBeDefined();
    expect(client.servedProvider).toBe('groq');
  });

  it('falls back when a provider returns malformed review arrays', async () => {
    const malformed = makeProvider('gemini', 'g', 'ok');
    malformed.reviewDiff = async () => ({ genericFindings: null, ruleFindings: [], thinking: null } as never);
    const healthy = makeProvider('groq', 'q', 'ok');
    const client = new LLMClient([malformed, healthy]);
    await expect(client.reviewDiff('f.ts', 'd', [])).resolves.toBeDefined();
    expect(client.servedProvider).toBe('groq');
  });

  it('classifies missing incremental resolutions after provider exhaustion', async () => {
    const missing = makeProvider('gemini', 'g', 'ok');
    missing.reviewIncrementalDiff = async () => ({
      genericFindings: [], ruleFindings: [], priorFindingResolutions: null, thinking: null,
    });
    const client = new LLMClient([missing]);
    const prior = [{ id: 'prior-1', severity: 'HIGH', file: 'f.ts', line: 1, body: 'issue' }] as never;
    try {
      await client.reviewIncrementalDiff('f.ts', 'd', [], prior);
      throw new Error('expected provider exhaustion');
    } catch (error) {
      expect(error).toBeInstanceOf(AllProvidersFailedError);
      const failure = error as AllProvidersFailedError;
      expect(failure.lastError).toBeInstanceOf(ProviderResponseError);
      expect((failure.lastError as ProviderResponseError).reason).toBe('missing');
    }
  });

  it('gives every configured provider a bounded slice inside the operation deadline', async () => {
    const calls: string[] = [];
    const hanging = (name: ProviderName) => {
      const provider = makeProvider(name, name, 'ok');
      provider.reviewDiff = async () => {
        calls.push(name);
        return new Promise<never>(() => undefined);
      };
      return provider;
    };
    const client = new LLMClient(
      [hanging('gemini'), hanging('groq'), hanging('cfai'), hanging('openrouter')],
      { providerMs: 40, operationMs: 120 }
    );
    const started = Date.now();
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toBeInstanceOf(AllProvidersFailedError);
    expect(calls).toEqual(['gemini', 'groq', 'cfai', 'openrouter']);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('single failing provider surfaces its error as the chain failure', async () => {
    const boom = makeProvider('gemini', 'g', 'boom');
    const client = new LLMClient([boom]);
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toBeInstanceOf(AllProvidersFailedError);
  });
});

describe('LLMClient generateEmbedding chain', () => {
  it('skips providers without generateEmbedding and serves from the first embed-capable one', async () => {
    // OpenRouter has no embedding endpoint — the chain must skip it, not abort.
    const noEmbed = makeProvider('openrouter', 'o', 'ok');
    const yesEmbed = makeEmbeddingProvider('cfai', 'c', 'ok');
    const client = new LLMClient([noEmbed, yesEmbed]);

    const vector = await client.generateEmbedding('never flag EOF newlines');
    expect(vector).toHaveLength(768);
    expect(client.servedProvider).toBe('cfai');
  });

  it('falls through on exhaustion to the next embed-capable provider', async () => {
    const exhausted = makeEmbeddingProvider('gemini', 'g', 'exhausted');
    const fallback = makeEmbeddingProvider('groq', 'q', 'ok');
    const client = new LLMClient([exhausted, fallback]);

    const vector = await client.generateEmbedding('x');
    expect(vector).toHaveLength(768);
    expect(client.servedProvider).toBe('groq');
  });

  it('falls through non-exhaustion embedding errors to the next embed-capable provider', async () => {
    const broken = makeEmbeddingProvider('gemini', 'g', 'boom');
    const fine = makeEmbeddingProvider('groq', 'q', 'ok');
    const client = new LLMClient([broken, fine]);

    const vector = await client.generateEmbedding('x');
    expect(vector).toHaveLength(768);
    expect(client.servedProvider).toBe('groq');
  });

  it('throws the last exhaustion when no configured provider can embed', async () => {
    const a = makeEmbeddingProvider('gemini', 'g', 'exhausted');
    const b = makeProvider('groq', 'q', 'ok'); // no generateEmbedding at all
    const client = new LLMClient([a, b]);

    await expect(client.generateEmbedding('x')).rejects.toBeInstanceOf(AllProvidersFailedError);
  });
});
