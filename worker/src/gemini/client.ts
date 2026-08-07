/**
 * Gemini Client
 *
 * Wraps the @google/generative-ai SDK for all Gemini API calls.
 * All generation calls use temperature: 0 and structured JSON output.
 *
 * This module ONLY handles Gemini communication. No business logic, no DB, no GitHub.
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

// ─── Configuration ───────────────────────────────────────────────────────────

const GENERATION_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'embedding-001';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReviewResult {
  genericFindings: RawGenericFinding[];
  ruleFindings: RawRuleFinding[];
}

// ─── Client Class ────────────────────────────────────────────────────────────

export class GeminiClient {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
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
    const prompt = buildReviewPrompt(fileName, diff, activeRules);

    const model = this.genAI.getGenerativeModel({
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
    const prompt = buildIntentPrompt(comment, parentBotComment);

    const model = this.genAI.getGenerativeModel({
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
    const prompt = buildRelationshipPrompt(newRule, existingRule);

    const model = this.genAI.getGenerativeModel({
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
  }

  // ── Priority Classification ──────────────────────────────────────────

  /**
   * Classify the priority of a rule body.
   * Returns "high" (security/architecture) or "normal" (style/convention).
   */
  async classifyPriority(ruleBody: string): Promise<RulePriority> {
    const prompt = buildPriorityPrompt(ruleBody);

    const model = this.genAI.getGenerativeModel({
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
  }

  // ── Embedding ────────────────────────────────────────────────────────

  /**
   * Generate a 768-dimensional embedding vector using text-embedding-004.
   * Used for rule similarity search in the contradiction engine.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const model = this.genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }

  // ── Free-text Reply ──────────────────────────────────────────────────

  /**
   * Draft a free-text reply for the QUESTION intent branch.
   * Not structured output — just a natural language response.
   */
  async draftReply(context: string, question: string): Promise<string> {
    const prompt = buildReplyPrompt(context, question);

    const model = this.genAI.getGenerativeModel({
      model: GENERATION_MODEL,
      generationConfig: {
        temperature: 0,
      },
    });

    const result = await model.generateContent(prompt);
    return result.response.text();
  }
}
