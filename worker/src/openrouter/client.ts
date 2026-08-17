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

import type { Finding, IncrementalReviewResult, Rule, Relationship, RulePriority, CommentAnalysis } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import {
  AllKeysExhaustedError,
  DailyQuotaExhaustedError,
} from '../gemini/keyPool.js';
import { parseJson } from '../llm/parse-json.js';
import type { LLMProvider } from '../llm/provider.js';
import { classifyHttpFailure, ProviderResponseError, type LLMRequestContext } from '../llm/errors.js';

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
    if (status === 408 || status === 524 || status >= 500) {
      return classifyHttpFailure('openrouter', status, text.slice(0, 300));
    }
    return new Error(`[openrouter] ${status}: ${text.slice(0, 300)}`);
  }

  // ── Core Chat Call ────────────────────────────────────────────────────

  /**
   * One chat completion. `jsonOutput` enables OpenRouter's JSON response by
   * requesting `{"type":"json_object"}` where supported; parsing stays
   * tolerant across models that ignore it.
   */
  private async chat(prompt: string, opts: { json?: boolean } = {}, context?: LLMRequestContext): Promise<string> {
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
      signal: context?.signal,
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
      throw new ProviderResponseError('openrouter', 'openrouter returned invalid JSON');
    }
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new ProviderResponseError('openrouter', 'openrouter returned an empty completion', 'missing');
    }
    return content;
  }

  // ── LLMProvider ───────────────────────────────────────────────────────

  async reviewDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[],
    context?: LLMRequestContext,
    referenceFileContent?: string,
    attentionFocus?: string
  ): Promise<ReviewResult> {
    const { buildReviewPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildReviewPrompt(fileName, diff, activeRules, referenceFileContent, attentionFocus), {
      json: true,
    }, context);
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

  async reviewIncrementalDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[],
    priorFindings: Finding[],
    context?: LLMRequestContext,
    referenceFileContent?: string,
    attentionFocus?: string
  ): Promise<IncrementalReviewResult> {
    const { buildIncrementalReviewPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(
      buildIncrementalReviewPrompt(fileName, diff, activeRules, priorFindings, referenceFileContent, attentionFocus),
      { json: true }, context
    );
    const parsed = parseJson<Partial<IncrementalReviewResult>>(raw);
    return {
      genericFindings: parsed.genericFindings || [],
      ruleFindings: parsed.ruleFindings || [],
      priorFindingResolutions: parsed.priorFindingResolutions ?? null,
      thinking: null,
    };
  }

  async reviewFocus(diff: string, context?: LLMRequestContext): Promise<unknown> {
    const { buildReviewFocusPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildReviewFocusPrompt(diff), { json: true }, context);
    return parseJson(raw);
  }

  async classifyIntent(comment: string, parentBotComment: string, context?: LLMRequestContext): Promise<CommentAnalysis> {
    const { buildIntentPrompt } = await import('../gemini/prompts.js');
    const { normalizeAnalysis } = await import('../llm/analysis.js');
    const raw = await this.chat(buildIntentPrompt(comment, parentBotComment), { json: true }, context);
    return normalizeAnalysis(parseJson(raw));
  }

  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string },
    context?: LLMRequestContext
  ): Promise<Relationship> {
    const { buildRelationshipPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildRelationshipPrompt(newRule, existingRule), { json: true }, context);
    return parseJson<{ relationship?: Relationship }>(raw).relationship ?? 'UNRELATED';
  }

  async classifyPriority(ruleBody: string, context?: LLMRequestContext): Promise<RulePriority> {
    const { buildPriorityPrompt } = await import('../gemini/prompts.js');
    const raw = await this.chat(buildPriorityPrompt(ruleBody), { json: true }, context);
    return parseJson<{ priority?: RulePriority }>(raw).priority ?? 'normal';
  }

  async draftReply(context: string, question: string, requestContext?: LLMRequestContext): Promise<string> {
    const { buildReplyPrompt } = await import('../gemini/prompts.js');
    return this.chat(buildReplyPrompt(context, question), {}, requestContext);
  }
}
