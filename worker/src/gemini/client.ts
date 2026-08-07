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
import { getKeyPool, isRateLimitError, AllKeysExhaustedError } from './keyPool.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const GENERATION_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'text-embedding-004';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewResult {
  genericFindings: RawGenericFinding[];
  ruleFindings: RawRuleFinding[];
}

// ─── Client Class ────────────────────────────────────────────────────────────

export class GeminiClient {
  private keys: string[];

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

  constructor(env: { GEMINI_API_KEYS?: string; GEMINI_API_KEY: string }) {
    this.keys = getKeyPool(env);
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
        if (!isRateLimitError(err)) throw err;
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
   */
  async reviewDiff(
    fileName: string,
    diff: string,
    activeRules: Rule[]
  ): Promise<ReviewResult> {
    return this.withKeyRotation(async (apiKey) => {
      const genAI = new GoogleGenerativeAI(apiKey);
      const prompt = buildReviewPrompt(fileName, diff, activeRules);

      const model = genAI.getGenerativeModel({
        model: GENERATION_MODEL,
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: reviewResponseSchema as Parameters<typeof model.generateContent>[0] extends { generationConfig?: { responseSchema?: infer S } } ? S : never,
        },
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text) as ReviewResult;

      return {
        genericFindings: parsed.genericFindings || [],
        ruleFindings: parsed.ruleFindings || [],
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
