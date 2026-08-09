/**
 * Cloudflare Workers AI Client
 *
 * Calls Cloudflare's Workers AI REST API (raw fetch — no SDK dep) for all
 * LLMProvider operations. It's a third fallback provider in the chain, behind
 * Gemini + Groq: it has its own account-level quota bucket, so when every
 * Gemini key AND every Groq key are exhausted a PR review can still make
 * progress instead of stalling.
 *
 * Endpoint: POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
 * Docs: https://developers.cloudflare.com/workers-ai/models/text-generation/
 *
 * Reasoning capture (thinking) is NOT available — reviewDiff returns
 * thinking: null, same as Groq.
 */

import type { Rule, Intent, Relationship, RulePriority } from '@parakh/shared';
import type { ReviewResult } from '../gemini/client.js';
import { AllKeysExhaustedError, DailyQuotaExhaustedError } from '../gemini/keyPool.js';
import { parseJson } from '../llm/parse-json.js';
import type { LLMProvider } from '../llm/provider.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Auth credentials are passed per-call from env (kept off the instance so
 * secrets never survive on a client object). Fields are optional so the
 * factory can construct lazily; calls require creds to be present. */
export interface CfaAiEnv {
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CFAI_GENERATION_MODEL?: string;
}

const CFAI_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Default Workers AI generation model — generally available on the paid tier
 * (which hosts this worker). Env override: CFAI_GENERATION_MODEL.
 */
export const DEFAULT_CFAI_GENERATION_MODEL =
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** Embedding model for rule similarity — BGE large (1024-dim). */
const CFAI_EMBEDDING_MODEL = '@cf/baai/bge-large-en-v1.5';

function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

export class CfaAiClient implements LLMProvider {
  private generationModel: string;
  private budget: { spend(n?: number): void } | null = null;
  private envCreds: CfaAiEnv;

  constructor(env: CfaAiEnv) {
    this.envCreds = env;
    this.generationModel = env.CFAI_GENERATION_MODEL ?? DEFAULT_CFAI_GENERATION_MODEL;
  }

  setBudget(budget: { spend(n?: number): void }): void {
    this.budget = budget;
  }

  get modelName(): string {
    return this.generationModel;
  }

  get providerName(): 'cfai' {
    return 'cfai';
  }

  // ── Error Classification ─────────────────────────────────────────────

  /**
   * Map a CF Workers AI HTTP error onto chain semantics:
   *   - 429 / quota-style messages and 401/403 (bad token, no credits) →
   *     AllKeysExhaustedError, so the chain quietly moves to the next provider.
   *   - 400/404 (model unavailable for this account/plan) → also exhaustion:
   *     the provider can't serve this model at all, retrying won't help.
   *   - 5xx → plain Error: transient infra failure, let the pipeline retry.
   */
  private classifyResponseError(status: number, body: unknown): Error {
    const text =
      typeof body === 'string' ? body : JSON.stringify(body).slice(0, 300);
    const lower = text.toLowerCase();
    const quota = lower.includes('quota') || lower.includes('rate limit') || lower.includes('exceeded');
    const modelUnavailable = status === 404 || status === 400 && lower.includes('model');

    if (status === 429 || status === 401 || status === 403 || status === 402 || modelUnavailable) {
      const err = new Error(`[cfai] ${status} ${text}`);
      if (quota && (lower.includes('day') || lower.includes('daily'))) {
        return new DailyQuotaExhaustedError(err);
      }
      return new AllKeysExhaustedError(err);
    }
    return new Error(`[cfai] ${status}: ${text}`);
  }

  // ── Core Call ─────────────────────────────────────────────────────────

  /**
   * Run one text-generation request. `jsonOutput` asks the model to emit a
   * single JSON object (Cloudflare has no strict response_format — parsing is
   * tolerant).
   */
  private async run(model: string, prompt: string, jsonOutput?: boolean): Promise<string> {
    this.budget?.spend(1);

    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'user',
          content: jsonOutput
            ? `${prompt}\n\nReturn your answer as a single valid JSON object. Do not include any text outside the JSON.`
            : prompt,
        },
      ],
    };

    const response = await fetch(
      `${CFAI_API_BASE}/${this.envCreds.CF_ACCOUNT_ID}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.envCreds.CF_API_TOKEN}`,
        },
        body: jsonStringify(body),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw this.classifyResponseError(response.status, text);
    }

    const data = (await response.json()) as {
      result?: { response?: string };
    };
    const content = data.result?.response ?? '';
    if (!content) {
      throw new Error(`[cfai] empty completion from ${model}`);
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
    const raw = await this.run(
      this.generationModel,
      buildReviewPrompt(fileName, diff, activeRules),
      true
    );
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
    const raw = await this.run(
      this.generationModel,
      buildIntentPrompt(comment, parentBotComment),
      true
    );
    return parseJson<{ intent?: Intent }>(raw).intent ?? 'GENERAL';
  }

  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string }
  ): Promise<Relationship> {
    const { buildRelationshipPrompt } = await import('../gemini/prompts.js');
    const raw = await this.run(
      this.generationModel,
      buildRelationshipPrompt(newRule, existingRule),
      true
    );
    return parseJson<{ relationship?: Relationship }>(raw).relationship ?? 'UNRELATED';
  }

  async classifyPriority(ruleBody: string): Promise<RulePriority> {
    const { buildPriorityPrompt } = await import('../gemini/prompts.js');
    const raw = await this.run(
      this.generationModel,
      buildPriorityPrompt(ruleBody),
      true
    );
    return parseJson<{ priority?: RulePriority }>(raw).priority ?? 'normal';
  }

  async draftReply(context: string, question: string): Promise<string> {
    const { buildReplyPrompt } = await import('../gemini/prompts.js');
    return this.run(this.generationModel, buildReplyPrompt(context, question));
  }

  /** Generate a 1024-dim embedding via bge-large-en-v1.5. */
  async generateEmbedding(text: string): Promise<number[]> {
    this.budget?.spend(1);

    const response = await fetch(
      `${CFAI_API_BASE}/${this.envCreds.CF_ACCOUNT_ID}/ai/run/${CFAI_EMBEDDING_MODEL}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.envCreds.CF_API_TOKEN}`,
        },
        body: jsonStringify({ text }),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw this.classifyResponseError(response.status, text);
    }

    const data = (await response.json()) as {
      result?: { data?: Array<{ text?: string; data?: number[][] } | number[] | { text?: string; embedding?: number[] }> };
    };
    const first = data.result?.data?.[0];
    const vector =
      Array.isArray(first)
        ? first
        : (first as { embedding?: number[] })?.embedding;
    if (!vector || vector.length === 0) {
      throw new Error('[cfai] Empty embedding result from bge-large-en-v1.5');
    }
    return vector;
  }
}