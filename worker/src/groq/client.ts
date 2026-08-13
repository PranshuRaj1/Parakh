/**
 * Groq Client
 *
 * Calls the Groq API (OpenAI-compatible) for all LLMProvider operations.
 * Used as the secondary provider behind Gemini — it gives an independent
 * rate-limit bucket, so when every Gemini key is exhausted the review can
 * still make progress instead of stalling.
 *
 * Deliberately raw fetch (no groq-sdk dep): Groq's /chat/completions endpoint
 * is OpenAI-shaped, and the codebase already uses raw fetch for every other
 * external service.
 *
 * Reasoning capture (thinking) is NOT available on Groq — reviewDiff returns
 * thinking: null. Reasoning stays Gemini-only.
 */

import type { Finding, IncrementalReviewResult, Rule, Intent, Relationship, RulePriority } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import {
  getGroqKeyPool,
  isRateLimitError,
  isModelUnavailableError,
  isDailyQuotaError,
  AllKeysExhaustedError,
  DailyQuotaExhaustedError,
  DAILY_QUOTA_COOLDOWN_MS,
} from '../gemini/keyPool.js';
import { MemoryCooldownStore, type CooldownStore } from '../gemini/cooldown-store.js';
import { parseJson } from '../llm/parse-json.js';
import type { LLMProvider } from '../llm/provider.js';
import { classifyHttpFailure, type LLMRequestContext } from '../llm/errors.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';

/** Default Groq generation model. Env override: GROQ_GENERATION_MODEL. */
export const DEFAULT_GROQ_GENERATION_MODEL = 'llama-3.3-70b-versatile';

/** Serialize an object for the payload without silently dropping fields. */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export class GroqClient implements LLMProvider {
  private keys: string[];
  private generationModel: string;

  /**
   * Shared hint: index of the last key that succeeded (see GeminiClient).
   */
  private sharedKeyHint: number = 0;
  private static COOLDOWN_MS = 60_000;
  private cooldowns: CooldownStore;

  private budget: { spend(n?: number): void } | null = null;

  constructor(env: {
    GROQ_API_KEYS?: string;
    GROQ_API_KEY?: string;
    GROQ_GENERATION_MODEL?: string;
  }, cooldowns?: CooldownStore) {
    this.keys = getGroqKeyPool(env);
    this.generationModel = env.GROQ_GENERATION_MODEL ?? DEFAULT_GROQ_GENERATION_MODEL;
    this.cooldowns = cooldowns ?? new MemoryCooldownStore();
  }

  setBudget(budget: { spend(n?: number): void }): void {
    this.budget = budget;
  }

  get modelName(): string {
    return this.generationModel;
  }

  get providerName(): 'groq' {
    return 'groq';
  }

  // ── Key Rotation ────────────────────────────────────────────────────

  /**
   * Same rotation semantics as GeminiClient: iterate the pool, park
   * rate-limited keys in a cooldown, skip keys that can't serve the model,
   * and throw AllKeysExhaustedError when every key is parked or failed.
   */
  private async withKeyRotation<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
    // Inherit parked keys persisted by a previous delivery/client (Redis).
    // Idempotent — subsequent calls on the same client are no-ops.
    await this.cooldowns.load();
    const startIndex = this.sharedKeyHint;
    let lastError: Error | null = null;
    let coolingDown = 0;
    let dailyQuotaBlocked = 0;
    let failed = 0;
    let dailyQuotaFailures = 0;
    let unavailable = 0;

    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const keyIndex = (startIndex + attempt) % this.keys.length;
      const entry = this.cooldowns.get(keyIndex);
      if (entry && entry.until > Date.now()) {
        coolingDown++;
        if (entry.dailyQuota) dailyQuotaBlocked++;
        continue;
      }
      const apiKey = this.keys[keyIndex];

      try {
        const result = await fn(apiKey);
        this.budget?.spend(1);
        this.sharedKeyHint = keyIndex;
        this.cooldowns.clear(keyIndex);
        await this.cooldowns.flush();
        return result;
      } catch (err) {
        // Model-access errors MUST be classified before the rate-limit checks —
        // a 404 "model not supported" can never serve this model and would
        // otherwise corrupt the daily-quota / exhaustion accounting.
        if (isModelUnavailableError(err)) {
          unavailable++;
          lastError = err as Error;
          console.warn(
            `[groq] Key ${keyIndex + 1}/${this.keys.length} cannot serve ${this.generationModel}, trying next...`
          );
          continue;
        }
        if (!isRateLimitError(err)) {
          await this.cooldowns.flush();
          throw err;
        }
        lastError = err as Error;
        const dailyQuota = isDailyQuotaError(err);
        failed++;
        if (dailyQuota) dailyQuotaFailures++;
        const parkMs = dailyQuota ? DAILY_QUOTA_COOLDOWN_MS : GroqClient.COOLDOWN_MS;
        this.cooldowns.park(keyIndex, { until: Date.now() + parkMs, dailyQuota });
        console.warn(
          `[groq] Key ${keyIndex + 1}/${this.keys.length} ` +
          `${dailyQuota ? 'daily-quota-exhausted' : 'rate-limited'}, ` +
          `cooling down ${Math.round(parkMs / 1000)}s...`
        );
      }
    }

    await this.cooldowns.flush();

    // Every key is now accounted for: parked at loop start, failed just now, or
    // skipped as model-unavailable. Decide whether retrying can EVER succeed.
    const accounted = coolingDown + failed + unavailable;
    const usableKeys = accounted - unavailable;
    const dailyQuotaKeys = dailyQuotaBlocked + dailyQuotaFailures;
    if (accounted === this.keys.length) {
      if (usableKeys === 0) {
        throw new AllKeysExhaustedError(
          lastError ?? new Error(`No key can serve ${this.generationModel}`),
          `No Groq API key can serve model ${this.generationModel}`
        );
      }
      if (dailyQuotaKeys === usableKeys) {
        throw new DailyQuotaExhaustedError(
          lastError ?? new Error('All Groq API keys exhausted their daily quota')
        );
      }
    }
    throw new AllKeysExhaustedError(
      lastError ?? new Error('All Groq API keys are cooling down from rate limits')
    );
  }

  // ── Core Chat Call ──────────────────────────────────────────────────

  /**
   * One chat completion. `json` enables JSON mode (response_format json_object)
   * which guarantees syntactically valid JSON; schema adherence is best-effort
   * (strict mode is only available on gpt-oss models).
   */
  private async chat(
    apiKey: string,
    prompt: string,
    opts: { json?: boolean } = {},
    context?: LLMRequestContext
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.generationModel,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: opts.json
            ? `${prompt}\n\nReturn your answer as a single valid JSON object. Do not include any text outside the JSON.`
            : prompt,
        },
      ],
    };
    if (opts.json) {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetch(GROQ_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: jsonStringify(payload),
      signal: context?.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw classifyHttpFailure('groq', response.status);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new Error('[Groq] empty completion');
    }
    return content;
  }

  /** Parse model JSON output, tolerating fenced code blocks. */
  private parseJson<T>(raw: string): T {
    return parseJson<T>(raw);
  }

  // ── LLMProvider ─────────────────────────────────────────────────────

  async reviewDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[],
    context?: LLMRequestContext
  ): Promise<ReviewResult> {
    // Build the same prompt the Gemini path uses so review semantics match.
    const { buildReviewPrompt } = await import('../gemini/prompts.js');
    const prompt = buildReviewPrompt(fileName, diff, activeRules);

    return this.withKeyRotation(async (apiKey) => {
      const raw = await this.chat(apiKey, prompt, { json: true });
      const parsed = this.parseJson<{
        genericFindings?: ReviewResult['genericFindings'];
        ruleFindings?: ReviewResult['ruleFindings'];
      }>(raw);
      return {
        genericFindings: parsed.genericFindings || [],
        ruleFindings: parsed.ruleFindings || [],
        // Groq has no thinking parts — reasoning capture is Gemini-only.
        thinking: null,
      };
    });
  }

  async reviewIncrementalDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[],
    priorFindings: Finding[],
    context?: LLMRequestContext
  ): Promise<IncrementalReviewResult> {
    const { buildIncrementalReviewPrompt } = await import('../gemini/prompts.js');
    const prompt = buildIncrementalReviewPrompt(fileName, diff, activeRules, priorFindings);
    return this.withKeyRotation(async (apiKey) => {
      const raw = await this.chat(apiKey, prompt, { json: true }, context);
      const parsed = this.parseJson<Partial<IncrementalReviewResult>>(raw);
      return {
        genericFindings: parsed.genericFindings || [],
        ruleFindings: parsed.ruleFindings || [],
        priorFindingResolutions: parsed.priorFindingResolutions ?? null,
        thinking: null,
      };
    });
  }

  async classifyIntent(comment: string, parentBotComment: string, context?: LLMRequestContext): Promise<Intent> {
    const { buildIntentPrompt } = await import('../gemini/prompts.js');
    const prompt = buildIntentPrompt(comment, parentBotComment);

    return this.withKeyRotation(async (apiKey) => {
      const raw = await this.chat(apiKey, prompt, { json: true }, context);
      const parsed = this.parseJson<{ intent?: Intent }>(raw);
      return parsed.intent ?? 'GENERAL';
    });
  }

  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string },
    context?: LLMRequestContext
  ): Promise<Relationship> {
    const { buildRelationshipPrompt } = await import('../gemini/prompts.js');
    const prompt = buildRelationshipPrompt(newRule, existingRule);

    return this.withKeyRotation(async (apiKey) => {
      const raw = await this.chat(apiKey, prompt, { json: true }, context);
      const parsed = this.parseJson<{ relationship?: Relationship }>(raw);
      return parsed.relationship ?? 'UNRELATED';
    });
  }

  async classifyPriority(ruleBody: string, context?: LLMRequestContext): Promise<RulePriority> {
    const { buildPriorityPrompt } = await import('../gemini/prompts.js');
    const prompt = buildPriorityPrompt(ruleBody);

    return this.withKeyRotation(async (apiKey) => {
      const raw = await this.chat(apiKey, prompt, { json: true }, context);
      const parsed = this.parseJson<{ priority?: RulePriority }>(raw);
      return parsed.priority ?? 'normal';
    });
  }

  async draftReply(context: string, question: string, requestContext?: LLMRequestContext): Promise<string> {
    const { buildReplyPrompt } = await import('../gemini/prompts.js');
    const prompt = buildReplyPrompt(context, question);

    return this.withKeyRotation(async (apiKey) => {
      return this.chat(apiKey, prompt, {}, requestContext);
    });
  }
}
