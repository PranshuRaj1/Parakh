/**
 * Normalization for the folded intent + rule-extraction call.
 *
 * Every provider client (gemini, groq, cfai, openrouter) parses the raw model
 * response into the same CommentAnalysis shape. This helper is defensive
 * against malformed or missing fields from any provider: unknown intents
 * default to GENERAL, rules are capped at MAX_RULES_PER_COMMENT, and empty or
 * non-string entries are dropped.
 */

import { MAX_RULES_PER_COMMENT } from '@parakh/shared';
import type { CommentAnalysis, Intent } from '@parakh/shared';

const VALID_INTENTS: readonly Intent[] = [
  'CORRECTION', 'EXPLANATION', 'DISMISSAL', 'QUESTION', 'REVIEW_REQUEST', 'GENERAL',
];

export function normalizeAnalysis(raw: unknown): CommentAnalysis {
  const obj = (raw ?? {}) as Record<string, unknown>;

  const intent: Intent = VALID_INTENTS.includes(obj.intent as Intent)
    ? (obj.intent as Intent)
    : 'GENERAL';

  const rules: CommentAnalysis['rules'] = [];
  if (Array.isArray(obj.rules)) {
    for (const item of obj.rules) {
      if (rules.length >= MAX_RULES_PER_COMMENT) break;
      const rule = (item ?? {}) as Record<string, unknown>;
      const body = typeof rule.body === 'string' ? rule.body.trim() : '';
      if (!body) continue;
      rules.push({
        body,
        priority: rule.priority === 'high' ? 'high' : 'normal',
      });
    }
  }

  const ignored = (Array.isArray(obj.ignored) ? obj.ignored : [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());

  return { intent, rules, ignored };
}
