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

export const incrementalReviewResponseSchema = {
  ...reviewResponseSchema,
  properties: {
    ...reviewResponseSchema.properties,
    priorFindingResolutions: {
      type: 'ARRAY' as SchemaType,
      items: {
        type: 'OBJECT' as SchemaType,
        properties: {
          findingId: { type: 'STRING' as SchemaType },
          status: {
            type: 'STRING' as SchemaType,
            enum: ['STILL_PRESENT', 'RESOLVED', 'UNCERTAIN'],
          },
          line: { type: 'NUMBER' as SchemaType, nullable: true },
        },
        required: ['findingId', 'status'],
      },
    },
  },
  required: ['genericFindings', 'ruleFindings', 'priorFindingResolutions'],
};

/**
 * Intent classification schema — folded: one call returns the intent AND the
 * corrective standards extracted from a CORRECTION comment (multi-rule split).
 */
export const intentResponseSchema = {
  type: 'OBJECT' as SchemaType,
  properties: {
    intent: {
      type: 'STRING' as SchemaType,
      enum: ['CORRECTION', 'EXPLANATION', 'DISMISSAL', 'QUESTION', 'REVIEW_REQUEST', 'GENERAL', 'META'],
      description: 'The intent behind the user reply to the bot comment.',
    },
    rules: {
      type: 'ARRAY' as SchemaType,
      items: {
        type: 'OBJECT' as SchemaType,
        properties: {
          body: {
            type: 'STRING' as SchemaType,
            description: 'A single distinct corrective standard, phrased as a forward-looking actionable rule.',
          },
          priority: {
            type: 'STRING' as SchemaType,
            enum: ['high', 'normal'],
            description: 'high for security/architecture/data integrity, normal for style/convention.',
          },
        },
        required: ['body', 'priority'],
      },
      description: 'Distinct corrective standards from the comment, at most 3. Empty when intent is not CORRECTION.',
    },
    ignored: {
      type: 'ARRAY' as SchemaType,
      items: { type: 'STRING' as SchemaType },
      description: 'Short quoted excerpts of the comment that are NOT actionable standards (sentiment, tone, complaints).',
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
