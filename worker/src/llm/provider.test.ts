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
    classifyIntent: async () => 'GENERAL',
    classifyRelationship: async () => 'UNRELATED',
    classifyPriority: async () => 'normal',
    draftReply: async () => 'ok',
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