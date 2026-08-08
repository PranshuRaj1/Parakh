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
} from '@parakh/shared';
import {
  reviewResponseSchema,
  intentResponseSchema,
  relationshipResponseSchema,
  priorityResponseSchema,
} from './schemas.js';
import {
  buildReviewPrompt,
  buildIntentPrompt,
  buildRelationshipPrompt,
  buildPriorityPrompt,
  buildReplyPrompt,
} from './prompts.js';
import { getKeyPool, isRateLimitError, isModelUnavailableError, AllKeysExhaustedError } from './keyPool.js';
import { sanitizeErrorText } from '../jobs/sanitize.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const GENERATION_MODEL = 'gemini-3-flash-preview';
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

export class GeminiClient {
  private keys: string[];

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

  constructor(env: {
    GEMINI_API_KEYS?: string;
    GEMINI_API_KEY: string;
    REASONING_CAPTURE_ENABLED?: string;
    REASONING_THINKING_BUDGET?: string;
  }) {
    this.keys = getKeyPool(env);
    this.reasoningEnabled = env.REASONING_CAPTURE_ENABLED !== 'false';
    const rawBudget = parseInt(env.REASONING_THINKING_BUDGET ?? '', 10);
    this.thinkingBudget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : DEFAULT_THINKING_BUDGET;
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
    const startIndex = this.sharedKeyHint;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const keyIndex = (startIndex + attempt) % this.keys.length;
      const apiKey = this.keys[keyIndex];

      try {
        const result = await fn(apiKey);
        // Success — update hint so future calls start from this key
        this.sharedKeyHint = keyIndex;
        return result;
      } catch (err) {
        if (!isRateLimitError(err)) {
          // A key that can't serve the current model (e.g. 404 "model not
          // available to new users") should be skipped, not allowed to abort
          // the whole call — otherwise one bad key silently kills every job.
          if (isModelUnavailableError(err)) {
            console.warn(
              `[gemini] Key ${keyIndex + 1}/${this.keys.length} cannot serve ${GENERATION_MODEL}, trying next...`
            );
            lastError = err as Error;
            continue;
          }
          throw err;
        }
        lastError = err as Error;
        console.warn(
          `[gemini] Key ${keyIndex + 1}/${this.keys.length} rate-limited, ` +
          `trying next...`
        );
      }
    }

    throw new AllKeysExhaustedError(lastError!);
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
        model: GENERATION_MODEL,
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
        model: GENERATION_MODEL,
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
        model: GENERATION_MODEL,
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
        model: GENERATION_MODEL,
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
        model: GENERATION_MODEL,
        generationConfig: {
          temperature: 0,
        },
      });

      const result = await model.generateContent(prompt);
      return result.response.text();
    });
  }
}
