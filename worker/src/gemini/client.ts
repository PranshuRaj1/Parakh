/**
 * Gemini Client
 *
 * Wraps the @google/generative-ai SDK for all Gemini API calls.
 * All generation calls use temperature: 0 and structured JSON output.
 *
 * This module ONLY handles Gemini communication. No business logic, no DB, no GitHub.
 *
 * Concurrency model: withKeyRotation() is safe under Promise.allSettled().
 * Each concurrent call iterates independently through the full key pool
 * starting from a shared hint index. The hint is updated only on success.
 * See v4 plan Bug 5 fix for rationale.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  Rule,
  RawGenericFinding,
  RawRuleFinding,
  Intent,
  Relationship,
  RulePriority,
  RuleMode,
} from '@parakh/shared';
import {
  reviewResponseSchema,
  intentResponseSchema,
  relationshipResponseSchema,
  priorityResponseSchema,
  ruleModeResponseSchema,
} from './schemas.js';
import {
  buildReviewPrompt,
  buildIntentPrompt,
  buildRelationshipPrompt,
  buildPriorityPrompt,
  buildRuleModePrompt,
  buildReplyPrompt,
} from './prompts.js';
import { getKeyPool, isRateLimitError, isModelUnavailableError, isDailyQuotaError, AllKeysExhaustedError, DailyQuotaExhaustedError, DAILY_QUOTA_COOLDOWN_MS } from './keyPool.js';
import { MemoryCooldownStore, type CooldownStore } from './cooldown-store.js';
import { sanitizeErrorText } from '../jobs/sanitize.js';
import type { LLMProvider, RuleModeResult } from '../llm/provider.js';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Default generation model. Env override: GEMINI_GENERATION_MODEL. */
export const DEFAULT_GEMINI_GENERATION_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'text-embedding-004';

// ─── Reasoning Capture Config ────────────────────────────────────────────────

/** Default cap on thinking tokens per review call — reasoning costs 2x input. */
const DEFAULT_THINKING_BUDGET = 1024;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewResult {
  genericFindings: RawGenericFinding[];
  ruleFindings: RawRuleFinding[];
  /** Raw model thinking for this file — null when reasoning capture is disabled. */
  thinking: string | null;
}

/**
 * Split a raw Gemini response into its structured text (the JSON) and its
 * thinking parts. The SDK's response.text() joins ALL text parts — including
 * thought parts — which would corrupt JSON.parse, so we must split manually.
 * Thinking parts are surfaced as `{ thought: true, text }` in the REST payload.
 */
export function extractResponseWithThinking(
  response: { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> }
): { jsonText: string; thinking: string } {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const thoughtParts: string[] = [];
  const textParts: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    if (part.thought === true && typeof part.text === 'string') {
      thoughtParts.push(part.text);
    } else if (typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }
  return { jsonText: textParts.join('\n'), thinking: thoughtParts.join('\n') };
}

// ─── Client Class ────────────────────────────────────────────────────────────

export class GeminiClient implements LLMProvider {
  private keys: string[];
  private generationModel: string;

  /**
   * Reasoning capture is opt-in via REASONING_CAPTURE_ENABLED and hard-capped by
   * REASONING_THINKING_BUDGET. Applied ONLY to reviewDiff calls (not intent /
   * priority / relationship classification) to keep the thinking-token spend low.
   */
  private reasoningEnabled: boolean;
  private thinkingBudget: number;

  /**
   * Shared hint: the index of the last key that succeeded.
   * Read at the START of each withKeyRotation call to avoid retrying
   * keys that are known-bad. Written ONLY on success.
   *
   * Safe under concurrency: reads are atomic (single JS number),
   * and the worst case of a stale read is trying a rate-limited key
   * one extra time — not skipping a working key.
   */
  private sharedKeyHint: number = 0;

  /**
   * Per-key cooldown: keyIndex -> ms timestamp until the key may be retried.
   * A rate-limited key is parked for COOLDOWN_MS so the rotation loop stops
   * hammering the whole pool on every file during a rate-limit storm. Each 429
   * is an outgoing subrequest — with 7 keys and 13 files that used to burn
   * ~90 subrequests of the 50-budget before the review even got going.
   *
   * Backed by a CooldownStore (Redis in production) so a queue redelivery that
   * constructs a FRESH client inherits the parked keys instead of re-burning
   * the whole pool. Defaults to memory so standalone/tests keep the old
   * behavior.
   */
  private static COOLDOWN_MS = 60_000;
  private cooldowns: CooldownStore;

  /**
   * Optional subrequest budget. When attached, EVERY real key attempt (each
   * 429 retry and each success) spends from it — so the budget guard counts
   * the true number of outgoing Gemini calls, not 1 per logical reviewDiff.
   */
  private budget: { spend(n?: number): void } | null = null;

  constructor(env: {
    GEMINI_API_KEYS?: string;
    GEMINI_API_KEY: string;
    GEMINI_GENERATION_MODEL?: string;
    REASONING_CAPTURE_ENABLED?: string;
    REASONING_THINKING_BUDGET?: string;
  }, cooldowns?: CooldownStore) {
    this.keys = getKeyPool(env);
    this.generationModel = env.GEMINI_GENERATION_MODEL ?? DEFAULT_GEMINI_GENERATION_MODEL;
    // Reasoning capture is OFF unless explicitly enabled — thinking tokens
    // cost 2x input and ~halve daily throughput, so it is a per-review opt-in.
    this.reasoningEnabled = env.REASONING_CAPTURE_ENABLED === 'true';
    const rawBudget = parseInt(env.REASONING_THINKING_BUDGET ?? '', 10);
    this.thinkingBudget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : DEFAULT_THINKING_BUDGET;
    this.cooldowns = cooldowns ?? new MemoryCooldownStore();
  }

  /**
   * Attach the subrequest budget so real key attempts are counted.
   * Called once at construction time by the pipeline.
   */
  setBudget(budget: { spend(n?: number): void }): void {
    this.budget = budget;
  }

  get modelName(): string {
    return this.generationModel;
  }

  get providerName(): 'gemini' {
    return 'gemini';
  }

  // ── Key Rotation ────────────────────────────────────────────────────

  /**
   * Execute fn(apiKey), rotating through the key pool on rate-limit errors.
   *
   * Each call iterates independently through ALL keys starting from the
   * shared hint. Concurrent calls may redundantly try the same keys —
   * that's correct. A redundant 429 is cheap; a skipped working key is not.
   *
   * The hint is updated only on success, so it gravitates toward
   * the last key that actually worked.
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
        // Count THIS real outgoing call against the subrequest budget (the
        // pipeline attaches one; the guard otherwise undercounts during storms).
        this.budget?.spend(1);
        const result = await fn(apiKey);
        // Success — update hint so future calls start from this key
        this.sharedKeyHint = keyIndex;
        this.cooldowns.clear(keyIndex);
        // Persist the clear so a fresh delivery tries this key again. No-op
        // when the store wasn't dirty (common success path).
        await this.cooldowns.flush();
        return result;
      } catch (err) {
        // Model-access errors (404 "model not supported for this key") must be
        // classified BEFORE the rate-limit checks — some providers surface them
        // with 429/quota-like text that would otherwise count the key toward
        // "daily quota exhausted". A key that 404s on this model can NEVER
        // serve it, so skip it and never let it abort the whole call.
        if (isModelUnavailableError(err)) {
          unavailable++;
          lastError = err as Error;
          console.warn(
            `[gemini] Key ${keyIndex + 1}/${this.keys.length} cannot serve ${this.generationModel}, trying next...`
          );
          continue;
        }
        if (!isRateLimitError(err)) {
          throw err;
        }
        lastError = err as Error;
        const dailyQuota = isDailyQuotaError(err);
        failed++;
        if (dailyQuota) dailyQuotaFailures++;
        // Park this key so we stop retrying it (and burning subrequests)
        // during a rate-limit storm. Daily-quota exhaustion gets a LONG park —
        // it doesn't recover in 60s, so retrying only thrashes.
        const parkMs = dailyQuota ? DAILY_QUOTA_COOLDOWN_MS : GeminiClient.COOLDOWN_MS;
        this.cooldowns.park(keyIndex, { until: Date.now() + parkMs, dailyQuota });
        console.warn(
          `[gemini] Key ${keyIndex + 1}/${this.keys.length} ` +
          `${dailyQuota ? 'daily-quota-exhausted' : 'rate-limited'}, ` +
          `cooling down ${Math.round(parkMs / 1000)}s...`
        );
      }
    }

    // Persist parked state so a fresh client/delivery inherits it. No-op when
    // nothing changed, so success paths cost nothing extra.
    await this.cooldowns.flush();

    // Every key is now accounted for: parked at loop start, failed just now, or
    // skipped as model-unavailable. Decide whether retrying can EVER succeed.
    const accounted = coolingDown + failed + unavailable;
    const usableKeys = accounted - unavailable;
    const dailyQuotaKeys = dailyQuotaBlocked + dailyQuotaFailures;
    if (accounted === this.keys.length) {
      if (usableKeys === 0) {
        // No key in the pool can serve the configured model. Retrying burns one
        // guaranteed 404 (a subrequest) per key per call — surface a clear
        // exhaustion instead of a misleading "rate limited" one.
        throw new AllKeysExhaustedError(
          lastError ?? new Error(`No key can serve ${this.generationModel}`),
          `No Gemini API key can serve model ${this.generationModel}`
        );
      }
      // Daily-quota exhaustion always wins over plain rate-limit at the gate:
      // a daily quota does NOT recover in 60s, so the review should park
      // instead of burning a queue delivery in backoff.
      if (dailyQuotaKeys === usableKeys) {
        throw new DailyQuotaExhaustedError(
          lastError ?? new Error('All Gemini API keys exhausted their daily quota')
        );
      }
    }
    throw new AllKeysExhaustedError(
      lastError ?? new Error('All Gemini API keys are cooling down from rate limits')
    );
  }

  // ── Diff Review ──────────────────────────────────────────────────────

  /**
   * Review a file diff against active rules.
   *
   * Returns two arrays:
   * - genericFindings: LLM-assigned severity (CRITICAL/HIGH/MEDIUM/LOW)
   * - ruleFindings: NO severity — computed in code from rule priority
   *
   * This is the ONLY call that requests model thinking (capped by the budget).
   */
  async reviewDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[]
  ): Promise<ReviewResult> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildReviewPrompt(fileName, diff, activeRules);

      const generationConfig: Record<string, unknown> = {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: reviewResponseSchema,
      };
      // Hard cost ceiling — Gemini 2.5 otherwise uses a large dynamic budget.
      if (this.reasoningEnabled) {
        generationConfig.thinkingConfig = { thinkingBudget: this.thinkingBudget };
      }

      const model = genAI.getGenerativeModel({
        model: this.generationModel,
        generationConfig: generationConfig as never,
      });

      const result = await model.generateContent(prompt);
      const { jsonText, thinking } = extractResponseWithThinking(result.response as unknown as Parameters<typeof extractResponseWithThinking>[0]);
      const text = jsonText || result.response.text();
      const parsed = JSON.parse(text) as ReviewResult;

      return {
        genericFindings: parsed.genericFindings || [],
        ruleFindings: parsed.ruleFindings || [],
        // Scrub secrets before persisting — same pass as error stacks.
        thinking: this.reasoningEnabled && thinking ? sanitizeErrorText(thinking) : null,
      };
    });
  }

  // ── Intent Classification ────────────────────────────────────────────

  /**
   * Classify the intent of a reply to a bot comment.
   * Returns one of: CORRECTION, EXPLANATION, DISMISSAL, QUESTION.
   */
  async classifyIntent(
    comment: string,
    parentBotComment: string
  ): Promise<Intent> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildIntentPrompt(comment, parentBotComment);

      const model = genAI.getGenerativeModel({
        model: this.generationModel,
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: intentResponseSchema as Parameters<typeof model.generateContent>[0] extends { generationConfig?: { responseSchema?: infer S } } ? S : never,
        },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text) as { intent: Intent };
      return parsed.intent;
    });
  }

  // ── Relationship Classification ──────────────────────────────────────

  /**
   * Classify the relationship between two rules.
   * Returns one of: DUPLICATE, REFINEMENT, CONTRADICTION, UNRELATED.
   */
  async classifyRelationship(
    newRule: { body: string },
    existingRule: { body: string }
  ): Promise<Relationship> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildRelationshipPrompt(newRule, existingRule);

      const model = genAI.getGenerativeModel({
        model: this.generationModel,
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: relationshipResponseSchema as Parameters<typeof model.generateContent>[0] extends { generationConfig?: { responseSchema?: infer S } } ? S : never,
        },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text) as { relationship: Relationship };
      return parsed.relationship;
    });
  }

  // ── Priority Classification ──────────────────────────────────────────

  /**
   * Classify the priority of a rule body.
   * Returns "high" (security/architecture) or "normal" (style/convention).
   */
  async classifyPriority(ruleBody: string): Promise<RulePriority> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildPriorityPrompt(ruleBody);

      const model = genAI.getGenerativeModel({
        model: this.generationModel,
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: priorityResponseSchema as Parameters<typeof model.generateContent>[0] extends { generationConfig?: { responseSchema?: infer S } } ? S : never,
        },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text) as { priority: RulePriority };
      return parsed.priority;
    });
  }

  // ── Rule Mode Classification ─────────────────────────────────────────

  /**
   * Classify a rule's enforcement mode and extract suppression patterns.
   * Returns "enforce"/"suppress" plus case-insensitive patterns for the
   * deterministic suppression post-filter.
   */
  async classifyRuleMode(ruleBody: string): Promise<RuleModeResult> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildRuleModePrompt(ruleBody);

      const model = genAI.getGenerativeModel({
        model: this.generationModel,
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: ruleModeResponseSchema as Parameters<typeof model.generateContent>[0] extends { generationConfig?: { responseSchema?: infer S } } ? S : never,
        },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text) as { mode?: RuleMode; patterns?: string[] };
      return {
        mode: parsed.mode ?? 'enforce',
        patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
      };
    });
  }

  // ── Embedding ────────────────────────────────────────────────────────

  /**
   * Generate a 768-dimensional embedding vector using text-embedding-004.
   * Used for rule similarity search in the contradiction engine.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
      const result = await model.embedContent(text);
      return result.embedding.values;
    });
  }

  // ── Free-text Reply ──────────────────────────────────────────────────

  /**
   * Draft a free-text reply for the QUESTION intent branch.
   * Not structured output — just a natural language response.
   */
  async draftReply(context: string, question: string): Promise<string> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildReplyPrompt(context, question);

      const model = genAI.getGenerativeModel({
        model: this.generationModel,
        generationConfig: {
          temperature: 0,
        },
      });

      const result = await model.generateContent(prompt);
      return result.response.text();
    });
  }
}
