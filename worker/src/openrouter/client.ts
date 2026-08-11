/**
 * OpenRouter Client
 *
 * Calls the OpenRouter API (OpenAI-compatible) for all LLMProvider operations.
 * A fourth fallback provider in the chain — it routes across ~100 models and
 * has its own credit-based quota, so when Gemini + Groq + CF Workers AI are all
 * exhausted a review still has one more independent provider to try.
 *
 * Deliberately raw fetch (no openrouter-sdk dep): /chat/completions is
 * OpenAI-shaped and the codebase already uses raw fetch everywhere else.
 *
 * Reasoning capture (thinking) is NOT available — reviewDiff returns
 * thinking: null. OpenRouter has no embeddings API — generateEmbedding is
 * intentionally not implemented so the LLMClient chain skips it for embeddings.
 */

import type { Rule, Intent, Relationship, RulePriority, RuleMode } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import {
  AllKeysExhaustedError,
  DailyQuotaExhaustedError,
} from '../gemini/keyPool.js';
import { parseJson } from '../llm/parse-json.js';
import type { LLMProvider, RuleModeResult } from '../llm/provider.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1/chat/completions';

/** Auth credentials per-call from env (never kept on the instance). */
export interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_GENERATION_MODEL?: string;
}

/**
 * Default OpenRouter generation model. Env override: OPENROUTER_GENERATION_MODEL.
 * Prefer a stable, cheap model that is never hidden behind ":free" queues.
 */
export const DEFAULT_OPENROUTER_GENERATION_MODEL =
  'meta-llama/llama-3.3-70b-instruct';

function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export class OpenRouterClient implements LLMProvider {
  private generationModel: string;
  private budget: { spend(n?: number): void } | null = null;
  private envCreds: OpenRouterEnv;

  constructor(env: OpenRouterEnv) {
    this.envCreds = env;
    this.generationModel = env.OPENROUTER_GENERATION_MODEL ?? DEFAULT_OPENROUTER_GENERATION_MODEL;
  }

  setBudget(budget: { spend(n?: number): void }): void {
    this.budget = budget;
  }

  get modelName(): string {
    return this.generationModel;
  }

  get providerName(): 'openrouter' {
    return 'openrouter';
  }

  // ── Error Classification ─────────────────────────────────────────────

  /**
   * Map an OpenRouter HTTP error onto chain semantics:
   *   - 402 (insufficient credits) / 401 / 403 / 429 → AllKeysExhaustedError
   *     (or DailyQuotaExhaustedError for day-scale quota messages), so the
   *     chain quietly moves to the next provider.
   *   - 400/404 (model unavailable on this account) → exhaustion too.
   *   - 5xx → plain Error: transient infrastructure failure.
   */
  private classifyResponseError(status: number, text: string): Error {
    const lower = text.toLowerCase();
    const quota =
      lower.includes('quota') ||
      lower.includes('rate limit') ||
      lower.includes('credits') ||
      lower.includes('no endpoints available');
    const modelUnavailable =
      status === 404 || (status === 400 && lower.includes('model'));

    if (status === 402 || status === 401 || status === 403 || status === 429 || modelUnavailable) {
      const err = new Error(`[openrouter] ${status} ${text.slice(0, 300)}`);
      if (quota && (lower.includes('day') || lower.includes('daily'))) {
        return new DailyQuotaExhaustedError(err);
      }
      return new AllKeysExhaustedError(err);
    }
    return new Error(`[openrouter] ${status}: ${text.slice(0, 300)}`);
  }

  // ── Core Chat Call ────────────────────────────────────────────────────

  /**
   * One chat completion. `jsonOutput` enables OpenRouter's JSON response by
   * requesting `{"type":"json_object"}` where supported; parsing stays
   * tolerant across models that ignore it.
   */
  private async chat(prompt: string, opts: { json?: boolean } = {}): Promise<string> {
    if (!this.envCreds.OPENROUTER_API_KEY) {
      throw new AllKeysExhaustedError(
        new Error('OpenRouter API key is not configured'),
        'OpenRouter API key is not configured'
      );
    }
    this.budget?.spend(1);

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

    const response = await fetch(OPENROUTER_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.envCreds.OPENROUTER_API_KEY ?? ''}`,
        'X-Title': 'Parakh PR reviewer',
      },
      body: jsonStringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw this.classifyResponseError(response.status, text);
    }

    let data: {
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      data = await response.json() as typeof data;
    } catch {
      throw new Error('[openrouter] invalid JSON response');
    }
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new Error('[openrouter] empty completion');
    }
    return content;
  }

  // ── LLMProvider ───────────────────────────────────────────────────────

  async reviewDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[]
  ): Promise<ReviewResult> {
    const { buildReviewPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildReviewPrompt(fileName, diff, activeRules), {
      json: true,
    });
    const parsed = parseJson<{
      genericFindings?: ReviewResult['genericFindings'];
      ruleFindings?: ReviewResult['ruleFindings'];
    }>(raw);
    return {
      genericFindings: parsed.genericFindings || [],
      ruleFindings: parsed.ruleFindings || [],
      thinking: null,
    };
  }

  async classifyIntent(comment: string, parentBotComment: string): Promise<Intent> {
    const { buildIntentPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildIntentPrompt(comment, parentBotComment), { json: true });
    return parseJson<{ intent?: Intent }>(raw).intent ?? 'GENERAL';
  }

  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string }
  ): Promise<Relationship> {
    const { buildRelationshipPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildRelationshipPrompt(newRule, existingRule), { json: true });
    return parseJson<{ relationship?: Relationship }>(raw).relationship ?? 'UNRELATED';
  }

  async classifyPriority(ruleBody: string): Promise<RulePriority> {
    const { buildPriorityPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildPriorityPrompt(ruleBody), { json: true });
    return parseJson<{ priority?: RulePriority }>(raw).priority ?? 'normal';
  }

  /**
   * Classify a rule's enforcement mode and extract suppression patterns.
   * Returns "enforce"/"suppress" plus case-insensitive patterns for the
   * deterministic suppression post-filter.
   */
  async classifyRuleMode(ruleBody: string): Promise<RuleModeResult> {
    const { buildRuleModePrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildRuleModePrompt(ruleBody), { json: true });
    const parsed = parseJson<{ mode?: RuleMode; patterns?: string[] }>(raw);
    return {
      mode: parsed.mode ?? 'enforce',
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
    };
  }

  async draftReply(context: string, question: string): Promise<string> {
    const { buildReplyPrompt } = await import('../gemini/prompts.js');
    return this.chat(buildReplyPrompt(context, question));
  }
}
