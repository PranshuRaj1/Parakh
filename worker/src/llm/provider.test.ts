import { describe, expect, it } from 'vitest';
import { AllKeysExhaustedError, DailyQuotaExhaustedError } from '../gemini/keyPool.js';
import { LLMClient, resolveProviderChain, type LLMProvider, type ProviderName } from './provider.js';

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
    classifyIntent: async () => 'GENERAL',
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

  it('propagates non-exhaustion errors without trying further providers', async () => {
    const broken = makeProvider('gemini', 'g', 'boom');
    const fine = makeProvider('groq', 'q', 'ok');
    const client = new LLMClient([broken, fine]);
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toThrow('gemini boom');
    expect(client.modelName).toBe('g');
  });

  it('throws the last provider exhaustion when every provider is exhausted', async () => {
    const a = makeProvider('gemini', 'g', 'exhausted');
    const b = makeProvider('groq', 'q', 'exhausted');
    const client = new LLMClient([a, b]);
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toBeInstanceOf(AllKeysExhaustedError);
  });

  it('lets DailyQuotaExhaustedError escape when ONLY the last provider is daily-quota-bound', async () => {
    const a = makeProvider('gemini', 'g', 'exhausted');
    const b = makeProvider('groq', 'q', 'daily');
    const client = new LLMClient([a, b]);
    await expect(client.reviewDiff('f.ts', 'd', [])).rejects.toBeInstanceOf(DailyQuotaExhaustedError);
  });

  it('does not fall through to the next provider for non-exhaustion Gemini failures', async () => {
    const boom = makeProvider('gemini', 'g', 'boom');
    const ok = makeProvider('groq', 'q', 'ok');
    const client = new LLMClient([boom, ok]);
    await Promise.allSettled([client.reviewDiff('f.ts', 'd', [])]);
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

  it('propagates non-exhaustion embedding errors without trying further providers', async () => {
    const broken = makeEmbeddingProvider('gemini', 'g', 'boom');
    const fine = makeEmbeddingProvider('groq', 'q', 'ok');
    const client = new LLMClient([broken, fine]);

    await expect(client.generateEmbedding('x')).rejects.toThrow('gemini embedding boom');
  });

  it('throws the last exhaustion when no configured provider can embed', async () => {
    const a = makeEmbeddingProvider('gemini', 'g', 'exhausted');
    const b = makeProvider('groq', 'q', 'ok'); // no generateEmbedding at all
    const client = new LLMClient([a, b]);

    await expect(client.generateEmbedding('x')).rejects.toBeInstanceOf(AllKeysExhaustedError);
  });
});
