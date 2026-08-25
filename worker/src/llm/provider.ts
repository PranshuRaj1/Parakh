import type { Finding, IncrementalReviewResult, Rule, Relationship, RulePriority, CommentAnalysis } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import type { Env } from '../index.js';
import { AllKeysExhaustedError, DailyQuotaExhaustedError } from '../gemini/keyPool.js';
import {
  AllProvidersFailedError,
  ProviderResponseError,
  ProviderTimeoutError,
  composeAbortSignals,
  isRetryableProviderError,
  normalizeProviderError,
  parseTimeoutMs,
  type LLMOperation,
  type LLMRequestContext,
} from './errors.js';

export type ProviderName = 'gemini' | 'groq' | 'cfai' | 'openrouter';
export const DEFAULT_PROVIDER_TIMEOUT_MS = 45_000;
export const DEFAULT_OPERATION_TIMEOUT_MS = 90_000;
const PROVIDER_TRANSITION_RESERVE_MS = 250;

export interface LLMProvider {
  reviewDiff(fileName: string, diff: string, activeRules: Rule[], context?: LLMRequestContext, referenceFileContent?: string, attentionFocus?: string): Promise<ReviewResult>;
  reviewIncrementalDiff(fileName: string, diff: string, activeRules: Rule[], priorFindings: Finding[], context?: LLMRequestContext, referenceFileContent?: string, attentionFocus?: string): Promise<IncrementalReviewResult>;
  /** One review-start call per delivery — produces the attention focus. */
  reviewFocus(diff: string, context?: LLMRequestContext): Promise<unknown>;
  classifyIntent(comment: string, parentBotComment: string, context?: LLMRequestContext): Promise<CommentAnalysis>;
  classifyRelationship(newRule: { body: string }, existingRule: { body: string }, context?: LLMRequestContext): Promise<Relationship>;
  classifyPriority(ruleBody: string, context?: LLMRequestContext): Promise<RulePriority>;
  draftReply(context: string, question: string, requestContext?: LLMRequestContext): Promise<string>;
  generateEmbedding?(text: string, context?: LLMRequestContext): Promise<number[]>;
  modelName: string;
  providerName: ProviderName;
}

const PROVIDER_PRIORITY: readonly ProviderName[] = ['gemini', 'groq', 'cfai', 'openrouter'];

function parseProviderName(value: string | undefined): ProviderName | null {
  if (!value) return null;
  const name = value.toLowerCase() as ProviderName;
  return PROVIDER_PRIORITY.includes(name) ? name : null;
}

/** Resolve the configured provider order; review execution tries this chain in order. */
export function resolveProviderChain(env: Env): ProviderName[] {
  const primary = parseProviderName(env.LLM_PRIMARY) ?? 'gemini';
  const fallback = env.LLM_FALLBACK?.toLowerCase() === 'none' ? null : parseProviderName(env.LLM_FALLBACK);
  const chain: ProviderName[] = [primary];
  if (fallback && !chain.includes(fallback)) chain.push(fallback);
  for (const name of PROVIDER_PRIORITY) if (!chain.includes(name)) chain.push(name);
  return chain;
}

export class LLMClient {
  private served: LLMProvider | null = null;
  private dailyQuotaUnavailable = new Map<ProviderName, DailyQuotaExhaustedError>();

  constructor(
    private providers: LLMProvider[],
    private timeouts = { providerMs: DEFAULT_PROVIDER_TIMEOUT_MS, operationMs: DEFAULT_OPERATION_TIMEOUT_MS }
  ) {}

  static fromEnv(env: Env, providerMap: Partial<Record<ProviderName, LLMProvider>>): LLMClient {
    const providers = resolveProviderChain(env)
      .map((name) => providerMap[name])
      .filter((provider): provider is LLMProvider => !!provider);
    return new LLMClient(providers, {
      providerMs: parseTimeoutMs(env.LLM_PROVIDER_TIMEOUT_MS, DEFAULT_PROVIDER_TIMEOUT_MS),
      operationMs: parseTimeoutMs(env.LLM_OPERATION_TIMEOUT_MS, DEFAULT_OPERATION_TIMEOUT_MS),
    });
  }

  get providersConfigured(): ProviderName[] {
    return this.providers.map((provider) => provider.providerName);
  }

  get modelName(): string {
    return (this.served ?? this.providers[0])?.modelName ?? 'unknown';
  }

  get servedProvider(): ProviderName | null {
    return this.served?.providerName ?? null;
  }

  private async route<T>(
    operation: LLMOperation,
    eligible: LLMProvider[],
    invoke: (provider: LLMProvider, context: LLMRequestContext) => Promise<T>,
    parentSignal?: AbortSignal
  ): Promise<T> {
    const configuredEligible = eligible;
    eligible = eligible.filter((provider) => !this.dailyQuotaUnavailable.has(provider.providerName));
    if (eligible.length === 0) {
      const lastDailyQuotaError = [...this.dailyQuotaUnavailable.values()].at(-1);
      if (lastDailyQuotaError) throw lastDailyQuotaError;
    }
    const deadline = Date.now() + this.timeouts.operationMs;
    const operationAbort = composeAbortSignals(parentSignal, this.timeouts.operationMs);
    let lastError: Error | null = null;
    let responseError: ProviderResponseError | null = null;
    const attempted: string[] = [];

    try {
      for (let index = 0; index < eligible.length; index++) {
        const provider = eligible[index];
        const remainingProviders = eligible.length - index;
        const remainingMs = deadline - Date.now();
        const transitionReserve = Math.min(
          PROVIDER_TRANSITION_RESERVE_MS,
          Math.max(1, Math.floor(this.timeouts.operationMs / Math.max(1, eligible.length) / 10))
        );
        const reserveMs = Math.max(0, remainingProviders - 1) * transitionReserve;
        const sliceMs = Math.max(1, Math.min(
          this.timeouts.providerMs,
          Math.floor((remainingMs - reserveMs) / remainingProviders)
        ));
        const startedAt = Date.now();
        const abort = composeAbortSignals(operationAbort.signal, sliceMs);
        attempted.push(provider.providerName);

        try {
          const result = await Promise.race([
            invoke(provider, { signal: abort.signal, timeoutMs: sliceMs, operation }),
            new Promise<never>((_, reject) => {
              // An already-aborted signal fires no 'abort' event, so reject
              // directly or a pre-expired deadline hangs the race forever.
              if (abort.signal.aborted) reject(abort.signal.reason);
              else abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
            }),
          ]);
          this.served = provider;
          this.logLatency(provider, operation, 'success', startedAt, sliceMs, null);
          return result;
        } catch (error) {
          const normalized = operationAbort.timedOut()
            ? new ProviderTimeoutError(provider.providerName, sliceMs, { cause: error })
            : normalizeProviderError(provider.providerName, error, sliceMs, abort.timedOut());
          if (normalized instanceof DailyQuotaExhaustedError) {
            this.dailyQuotaUnavailable.set(provider.providerName, normalized);
          }
          const retryable = normalized instanceof AllKeysExhaustedError || isRetryableProviderError(normalized);
          const status = normalized && typeof normalized === 'object' && 'status' in normalized && typeof normalized.status === 'number'
            ? normalized.status
            : null;
          this.logLatency(provider, operation, retryable ? 'fallback' : 'failed', startedAt, sliceMs, status);
          // A failed provider never aborts the chain while another provider
          // remains untried. Even non-retryable errors (e.g. Groq HTTP 400
          // json_validate failures) fall through so cfai/openrouter get a
          // chance as last-resort providers; the last error surfaces via
          // AllProvidersFailedError if the entire chain fails.
          lastError = normalized instanceof Error ? normalized : new Error(String(normalized));
          if (normalized instanceof ProviderResponseError) responseError = normalized;
        } finally {
          abort.cleanup();
        }
      }

      if (configuredEligible.every((provider) => this.dailyQuotaUnavailable.has(provider.providerName))) {
        const lastDailyQuotaError = [...this.dailyQuotaUnavailable.values()].at(-1);
        if (lastDailyQuotaError) throw lastDailyQuotaError;
      }
      throw new AllProvidersFailedError(responseError ?? lastError, attempted);
    } finally {
      operationAbort.cleanup();
    }
  }

  private logLatency(provider: LLMProvider, operation: LLMOperation, outcome: string, startedAt: number, timeoutMs: number, status: number | null): void {
    console.log(`[llm-latency] ${JSON.stringify({ provider: provider.providerName, model: provider.modelName, operation, outcome, durationMs: Date.now() - startedAt, timeoutMs, status })}`);
  }

  reviewDiff(fileName: string, diff: string, rules: Rule[], signal?: AbortSignal, referenceFileContent?: string, attentionFocus?: string): Promise<ReviewResult> {
    return this.route('review', this.providers, async (provider, context) => {
      const result = await provider.reviewDiff(fileName, diff, rules, context, referenceFileContent, attentionFocus);
      if (!Array.isArray(result.genericFindings) || !Array.isArray(result.ruleFindings)) {
        throw new ProviderResponseError(provider.providerName, `${provider.providerName} returned malformed review findings`);
      }
      return result;
    }, signal);
  }

  reviewIncrementalDiff(fileName: string, diff: string, rules: Rule[], findings: Finding[], signal?: AbortSignal, referenceFileContent?: string, attentionFocus?: string): Promise<IncrementalReviewResult> {
    return this.route('incremental_review', this.providers, async (provider, context) => {
      const result = await provider.reviewIncrementalDiff(fileName, diff, rules, findings, context, referenceFileContent, attentionFocus);
      if (!Array.isArray(result.genericFindings) || !Array.isArray(result.ruleFindings)) {
        throw new ProviderResponseError(provider.providerName, `${provider.providerName} returned malformed incremental findings`);
      }
      if (findings.length > 0 && !Array.isArray(result.priorFindingResolutions)) {
        throw new ProviderResponseError(
          provider.providerName,
          `${provider.providerName} omitted prior finding resolutions`,
          'missing',
          result
        );
      }
      return result;
    }, signal);
  }

  reviewFocus(diff: string, signal?: AbortSignal): Promise<unknown> {
    return this.route('review_focus', this.providers, async (provider, context) => {
      return provider.reviewFocus(diff, context);
    }, signal);
  }

  classifyIntent(comment: string, parent: string): Promise<CommentAnalysis> {
    return this.route('intent', this.providers, (provider, context) => provider.classifyIntent(comment, parent, context));
  }

  classifyRelationship(next: { body: string }, existing: { body: string }): Promise<Relationship> {
    return this.route('relationship', this.providers, (provider, context) => provider.classifyRelationship(next, existing, context));
  }

  classifyPriority(body: string): Promise<RulePriority> {
    return this.route('priority', this.providers, (provider, context) => provider.classifyPriority(body, context));
  }

  draftReply(context: string, question: string): Promise<string> {
    return this.route('reply', this.providers, (provider, requestContext) => provider.draftReply(context, question, requestContext));
  }

  generateEmbedding(text: string): Promise<number[]> {
    const eligible = this.providers.filter((provider) => typeof provider.generateEmbedding === 'function');
    return this.route('embedding', eligible, (provider, context) => provider.generateEmbedding!(text, context));
  }
}
