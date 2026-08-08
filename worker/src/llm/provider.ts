/**
 * LLM Provider Abstraction
 *
 * Single interface for every model call in Parakh. Both GeminiClient and
 * GroqClient implement this, and LLMClient (the facade) routes each call:
 * primary provider first, fall back to the other when the primary is
 * exhausted (AllKeysExhaustedError — i.e. every key rate-limited).
 *
 * This is the layer that makes "swap providers" a config change:
 *   LLM_PRIMARY=gemini|groq   (default gemini)
 *   LLM_FALLBACK=groq|gemini|none (default groq)
 */

import type { Rule, Intent, Relationship, RulePriority } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import type { Env } from '../index.js';
import { AllKeysExhaustedError } from '../gemini/keyPool.js';

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
}

export type LLMPrimary = 'gemini' | 'groq';
export type LLMFallback = LLMPrimary | 'none';

export function resolveProviderOrder(env: Env): { primary: LLMPrimary; fallback: LLMFallback } {
  const primary = (env.LLM_PRIMARY ?? 'gemini').toLowerCase() as LLMPrimary;
  const fallback = (env.LLM_FALLBACK ?? 'groq').toLowerCase() as LLMFallback;
  return { primary: primary === 'groq' ? 'groq' : 'gemini', fallback };
}

/**
 * Facade over the primary + fallback providers.
 *
 * Each method runs on the primary provider. If the primary throws
 * AllKeysExhaustedError (every key rate-limited), the call retries on the
 * fallback. Any other error propagates untouched — non-rate-limit failures
 * are real failures, not provider-health signals.
 *
 * All reasoning capture stays Gemini-only: Groq has no thinking parts.
 */
export class LLMClient {
  constructor(
    private primary: LLMProvider,
    private fallback: LLMProvider | null
  ) {}

  static fromEnv(env: Env, gemini: LLMProvider, groq: LLMProvider): LLMClient {
    const { primary, fallback } = resolveProviderOrder(env);
    const primaryClient = primary === 'groq' ? groq : gemini;
    const fallbackClient =
      fallback === 'none' ? null : fallback === 'groq' ? groq : gemini;
    return new LLMClient(primaryClient, fallbackClient);
  }

  private async route<T>(fn: (p: LLMProvider) => Promise<T>): Promise<T> {
    try {
      return await fn(this.primary);
    } catch (err) {
      if (err instanceof AllKeysExhaustedError && this.fallback) {
        console.warn(
          `[llm] Primary provider exhausted (${err.message}) — falling back to secondary provider`
        );
        return await fn(this.fallback);
      }
      throw err;
    }
  }

  /** Model name of the active primary provider — used for reasoning capture labels. */
  get modelName(): string {
    const withName = this.primary as unknown as { modelName?: string };
    return withName.modelName ?? 'unknown';
  }

  async reviewDiff(fileName: string, diff: string, activeRules: Rule[]): Promise<ReviewResult> {
    return this.route(p => p.reviewDiff(fileName, diff, activeRules));
  }

  async classifyIntent(comment: string, parentBotComment: string): Promise<Intent> {
    return this.route(p => p.classifyIntent(comment, parentBotComment));
  }

  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string }
  ): Promise<Relationship> {
    return this.route(p => p.classifyRelationship(newRule, existingRule));
  }

  async classifyPriority(ruleBody: string): Promise<RulePriority> {
    return this.route(p => p.classifyPriority(ruleBody));
  }

  async draftReply(context: string, question: string): Promise<string> {
    return this.route(p => p.draftReply(context, question));
  }
}
