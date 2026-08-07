/**
 * Gemini Response Schemas
 *
 * Defines the structured output schemas for each Gemini call.
 * Gemini's native responseSchema ensures the LLM returns exactly these shapes.
 *
 * CRITICAL DESIGN DECISION:
 * ruleFindings has NO severity field. Severity for rule violations is computed
 * in code from rules.priority, not trusted from the LLM. This is enforced by
 * the schema shape — the LLM literally cannot return a severity for rule findings
 * because the field doesn't exist in the schema it's generating into.
 */

import type { SchemaType } from '@google/generative-ai';

// We declare schema objects compatible with Gemini's Schema type.
// Using 'as const' for type safety with the SDK.

/**
 * Review schema — two arrays for the split finding types.
 *
 * genericFindings: LLM assigns severity (CRITICAL/HIGH/MEDIUM/LOW)
 * ruleFindings: NO severity field — severity computed in code from rule priority
 */
export const reviewResponseSchema = {
  type: 'OBJECT' as SchemaType,
  properties: {
    genericFindings: {
      type: 'ARRAY' as SchemaType,
      description: 'Code quality findings NOT tied to any stored rule.',
      items: {
        type: 'OBJECT' as SchemaType,
        properties: {
          severity: {
            type: 'STRING' as SchemaType,
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
            description: 'Severity classification for this generic finding.',
          },
          file: {
            type: 'STRING' as SchemaType,
            description: 'File path where the issue was found.',
          },
          line: {
            type: 'NUMBER' as SchemaType,
            description: 'Line number in the file.',
          },
          body: {
            type: 'STRING' as SchemaType,
            description: 'Description of the issue found.',
          },
          suggestion: {
            type: 'STRING' as SchemaType,
            nullable: true,
            description: 'Suggested fix or improvement.',
          },
        },
        required: ['severity', 'file', 'line', 'body'],
      },
    },
    ruleFindings: {
      type: 'ARRAY' as SchemaType,
      description: 'Findings that violate a stored coding rule. Do NOT include severity — it will be assigned by the system based on the rule priority.',
      items: {
        type: 'OBJECT' as SchemaType,
        properties: {
          file: {
            type: 'STRING' as SchemaType,
            description: 'File path where the rule violation was found.',
          },
          line: {
            type: 'NUMBER' as SchemaType,
            description: 'Line number in the file.',
          },
          body: {
            type: 'STRING' as SchemaType,
            description: 'Description of the rule violation.',
          },
          suggestion: {
            type: 'STRING' as SchemaType,
            nullable: true,
            description: 'Suggested fix to comply with the rule.',
          },
          rule_id: {
            type: 'STRING' as SchemaType,
            description: 'The UUID of the stored rule that was violated.',
          },
        },
        required: ['file', 'line', 'body', 'rule_id'],
      },
    },
  },
  required: ['genericFindings', 'ruleFindings'],
};

/**
 * Intent classification schema — four buckets.
 */
export const intentResponseSchema = {
  type: 'OBJECT' as SchemaType,
  properties: {
    intent: {
      type: 'STRING' as SchemaType,
      enum: ['CORRECTION', 'EXPLANATION', 'DISMISSAL', 'QUESTION', 'REVIEW_REQUEST', 'GENERAL'],
      description: 'The intent behind the user reply to the bot comment.',
    },
  },
  required: ['intent'],
};

/**
 * Relationship classification schema — four relationship types.
 */
export const relationshipResponseSchema = {
  type: 'OBJECT' as SchemaType,
  properties: {
    relationship: {
      type: 'STRING' as SchemaType,
      enum: ['DUPLICATE', 'REFINEMENT', 'CONTRADICTION', 'UNRELATED'],
      description: 'The relationship between the two rules.',
    },
  },
  required: ['relationship'],
};

/**
 * Priority classification schema — security/architecture vs style.
 */
export const priorityResponseSchema = {
  type: 'OBJECT' as SchemaType,
  properties: {
    priority: {
      type: 'STRING' as SchemaType,
      enum: ['high', 'normal'],
      description: 'Rule priority: "high" for security/architecture rules, "normal" for style/convention.',
    },
  },
  required: ['priority'],
};
