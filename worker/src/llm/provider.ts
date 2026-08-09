/**
 * LLM Provider Abstraction
 *
 * Single interface for every model call in Parakh. GeminiClient, GroqClient,
 * CfaAiClient and OpenRouterClient all implement LLMProvider, and LLMClient
 * (the facade) walks them as an ORDERED CHAIN: each call runs on the first
 * provider; when a provider exhausts every key/quota (AllKeysExhaustedError)
 * the call falls through to the next provider in the chain.
 *
 * Chain resolution (see resolveProviderChain):
 *   LLM_PRIMARY   (default gemini)  — first provider tried
 *   LLM_FALLBACK  (default groq)    — second
 *   ...then every other CONFIGURED provider in a fixed priority order, so a
 *   Gemini + Groq storm still has quiet fail-safes (Cloudflare Workers AI,
 *   OpenRouter) with no extra config required.
 *
 * Non-exhaustion errors propagate immediately — they are real failures, not
 * provider-health signals, so we never hide a bad request behind a failover.
 */

import type { Rule, Intent, Relationship, RulePriority } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import type { Env } from '../index.js';
import { AllKeysExhaustedError } from '../gemini/keyPool.js';

export type ProviderName = 'gemini' | 'groq' | 'cfai' | 'openrouter';

export interface LLMProvider {
  /** Review a file diff against active rules. */
  reviewDiff(fileName: string, diff: string, activeRules: Rule[]): Promise<ReviewResult>;
  /** Classify the intent of a reply to a bot comment. */
  classifyIntent(comment: string, parentBotComment: string): Promise<Intent>;
  /** Classify the relationship between two rules. */
  classifyRelationship(newRule: { body: string }, existingRule: { body: string }): Promise<Relationship>;
  /** Classify a rule's priority. */
  classifyPriority(ruleBody: string): Promise<RulePriority>;
  /** Draft a free-text reply to a developer's question. */
  draftReply(context: string, question: string): Promise<string>;
  /**
   * Optional: generate an embedding vector for rule similarity search.
   * Absent on providers without an embeddings endpoint (e.g. OpenRouter);
   * the chain skips such providers and falls through to ones that have it.
   */
  generateEmbedding?(text: string): Promise<number[]>;
  /** Human/model name — used for reasoning-capture labels. */
  modelName: string;
  /** Stable provider identifier for chain routing + logging. */
  providerName: ProviderName;
}

/**
 * Fixed priority used to append providers that aren't named by
 * LLM_PRIMARY/LLM_FALLBACK but ARE configured in the environment. This is
 * what gives a storm a quiet 3rd/4th fallback without new config.
 */
const PROVIDER_PRIORITY: readonly ProviderName[] = ['gemini', 'groq', 'cfai', 'openrouter'];

function parseProviderName(value: string | undefined): ProviderName | null {
  if (!value) return null;
  const v = value.toLowerCase() as ProviderName;
  return PROVIDER_PRIORITY.includes(v) ? v : null;
}

/**
 * Resolve the ordered provider chain from env:
 *   [LLM_PRIMARY, LLM_FALLBACK, ...rest of PROVIDER_PRIORITY]
 * The factory later filters this down to the providers that are actually
 * configured (have credentials) — this function only decides the ORDER.
 */
export function resolveProviderChain(env: Env): ProviderName[] {
  const primary = parseProviderName(env.LLM_PRIMARY) ?? 'gemini';
  const fallback = env.LLM_FALLBACK?.toLowerCase() === 'none' ? null : parseProviderName(env.LLM_FALLBACK);
  const chain: ProviderName[] = [primary];
  if (fallback && !chain.includes(fallback)) chain.push(fallback);
  for (const name of PROVIDER_PRIORITY) {
    if (!chain.includes(name)) chain.push(name);
  }
  return chain;
}

/**
 * Facade over an ordered provider chain.
 *
 * Each method walks the chain: try the current provider; if it throws
 * AllKeysExhaustedError (every key rate-limited / daily-quota'd / unavailable),
 * log and move to the next. Any other error propagates untouched.
 *
 * Because DailyQuotaExhaustedError extends AllKeysExhaustedError, a Gemini
 * daily-quota exhaustion also falls through to Groq/CF AI/OpenRouter — a daily
 * quota on ONE provider shouldn't stall the whole review. Only when the LAST
 * configured provider is daily-quota'd does DailyQuotaExhaustedError escape to
 * the pipeline (which parks the review instead of retry-thrashing).
 */
export class LLMClient {
  /** Provider that last served a successful call — for modelName labels. */
  private served: LLMProvider | null = null;

  constructor(private providers: LLMProvider[]) {}

  static fromEnv(
    env: Env,
    providerMap: Partial<Record<ProviderName, LLMProvider>>
  ): LLMClient {
    const chain = resolveProviderChain(env)
      .map((name) => providerMap[name])
      .filter((p): p is LLMProvider => !!p);
    return new LLMClient(chain);
  }

  get providersConfigured(): ProviderName[] {
    return this.providers.map((p) => p.providerName);
  }

  get modelName(): string {
    const ref = this.served ?? this.providers[0];
    return ref?.modelName ?? 'unknown';
  }

  /** Name of the provider that served the last successful call (labels/telemetry). */
  get servedProvider(): ProviderName | null {
    return this.served?.providerName ?? null;
  }

  private async route<T>(fn: (p: LLMProvider) => Promise<T>): Promise<T> {
    let lastExhaustion: AllKeysExhaustedError | null = null;
    for (const provider of this.providers) {
      try {
        const result = await fn(provider);
        this.served = provider;
        return result;
      } catch (err) {
        if (err instanceof AllKeysExhaustedError) {
          lastExhaustion = err;
          console.warn(
            `[llm] ${provider.providerName} exhausted (${err.message}) — trying next provider`
          );
          continue;
        }
        throw err;
      }
    }
    throw lastExhaustion ?? new AllKeysExhaustedError(
      new Error('No LLM providers are configured'),
      'No LLM providers are configured — set at least one provider credential'
    );
  }

  async reviewDiff(fileName: string, diff: string, activeRules: Rule[]): Promise<ReviewResult> {
    return this.route((p) => p.reviewDiff(fileName, diff, activeRules));
  }

  async classifyIntent(comment: string, parentBotComment: string): Promise<Intent> {
    return this.route((p) => p.classifyIntent(comment, parentBotComment));
  }

  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string }
  ): Promise<Relationship> {
    return this.route((p) => p.classifyRelationship(newRule, existingRule));
  }

  async classifyPriority(ruleBody: string): Promise<RulePriority> {
    return this.route((p) => p.classifyPriority(ruleBody));
  }

  async draftReply(context: string, question: string): Promise<string> {
    return this.route((p) => p.draftReply(context, question));
  }

  /**
   * Embeddings are not supported by every provider (OpenRouter has none).
   * Walk the chain but only call providers that implement generateEmbedding;
   * exhaustions and "unsupported" providers fall through. If no configured
   * provider can embed, surface the last exhaustion as a real failure.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    let lastExhaustion: AllKeysExhaustedError | null = null;
    for (const provider of this.providers) {
      if (typeof provider.generateEmbedding !== 'function') continue;
      try {
        const result = await provider.generateEmbedding(text);
        this.served = provider;
        return result;
      } catch (err) {
        if (err instanceof AllKeysExhaustedError) {
          lastExhaustion = err;
          console.warn(
            `[llm] ${provider.providerName} embedding exhausted (${err.message}) — trying next provider`
          );
          continue;
        }
        throw err;
      }
    }
    throw lastExhaustion ?? new AllKeysExhaustedError(
      new Error('No configured provider supports embeddings'),
      'No configured provider supports embeddings'
    );
  }
}
