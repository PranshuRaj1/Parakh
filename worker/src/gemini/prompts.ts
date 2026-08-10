/**
 * Gemini Prompt Templates
 *
 * All prompt templates as pure string functions — no side effects, no network calls.
 * These are the single source of truth for what Gemini sees.
 */

import { SEVERITY_TAXONOMY } from '@parakh/shared';
import type { Rule } from '@parakh/shared';

// ─── Review Prompt ───────────────────────────────────────────────────────────

/**
 * Build the system prompt for a diff review call.
 *
 * Key instruction: for findings that violate a stored rule, return rule_id
 * and do NOT include severity. Severity is assigned by the system.
 */
export function buildReviewPrompt(
  fileName: string,
  diff: string,
  activeRules: Rule[]
): string {
  const severityTable = Object.entries(SEVERITY_TAXONOMY)
    .map(([level, info]) => `| ${level} | ${info.weight} | ${info.definition} | ${info.examples} |`)
    .join('\n');

  const rulesSection = activeRules.length > 0
    ? `
## Active Coding Rules for This Repository

The following rules are active coding standards. Only report a rule finding when the code
genuinely violates one of the rules listed below — never invent a violation of a rule, and
never reference a rule that is not in this list.

Report each violation as a rule finding with the rule's ID. Do NOT assign a severity to rule
findings — the system will assign severity based on the rule's priority setting.

${activeRules.map((r) => `- **[${r.id}]** (priority: ${r.priority}): ${r.body}`).join('\n')}
`
    : '';

  return `You are Parakh, an expert code reviewer. Review the following diff for the file "${fileName}".

## Severity Taxonomy

Classify each GENERIC finding (not tied to a stored rule) into exactly one of these severity levels:

| Severity | Weight | Definition | Examples |
|---|---|---|---|
| ${severityTable}

## What NOT to Flag

The following are explicitly NOT review findings. Do NOT report them as generic findings OR
as rule findings:

- Missing newline at the end of a file
- Trailing whitespace or trailing commas
- Generic "this comment could be clearer" style commentary
- Variable or function renames purely for naming style — only suggest a rename when the name is
  actively misleading and hurts comprehension

LOW findings should be reserved for issues that materially hurt readability or maintainability,
not pure style preferences. When in doubt, do not report it.

${rulesSection}

## Output Instructions

Return your findings in two separate arrays:

1. **genericFindings**: Code quality issues NOT tied to any stored rule above.
   Include: severity, file, line, body, suggestion (optional).

2. **ruleFindings**: Violations of the stored rules listed above.
   Include: file, line, body, suggestion (optional), rule_id.
   Do NOT include severity for rule findings — it will be assigned by the system.

If the code looks clean, return empty arrays for both.

## Diff to Review

\`\`\`diff
${diff}
\`\`\`
`;
}

// ─── Intent Classification Prompt ────────────────────────────────────────────

/**
 * Build the prompt for classifying the intent of a reply to a bot comment.
 */
export function buildIntentPrompt(
  comment: string,
  parentBotComment: string
): string {
  return `You are classifying the intent of a developer's reply to an automated code review comment.

## Bot's Original Comment (if applicable)

${parentBotComment || "(None — this is a standalone comment from the developer)"}

## Developer's Reply

${comment}

## Intent Categories

Classify the reply into exactly one of these six categories:

- **CORRECTION**: The developer is telling the bot it was wrong and providing the correct coding standard or practice. The reply contains information about how things should actually be done in this codebase. Examples: "No, we use Zustand here, not Redux", "Actually we handle cleanup globally in our test setup", "The convention here is to use snake_case for DB columns".

- **EXPLANATION**: The developer is explaining why their code is correct as-is, without asserting a new standard. They're providing context the bot lacked. Examples: "This is intentional because of X", "We're doing it this way because the API requires it", "That's handled by the middleware already".

- **DISMISSAL**: The developer is dismissing the bot's comment as unhelpful, irrelevant, or wrong WITHOUT providing a corrective standard or forward-looking instruction. Examples: "Not relevant", "Ignore this", "This is fine", "👎", "Nah".

## Disambiguation Rules

- **Forward-looking standards always win.** If the comment tells the bot how to behave in FUTURE reviews — e.g. it contains phrases like "in any future review", "stop flagging X", "never raise X", "don't flag X", "always do Y", "from now on" — classify it as **CORRECTION**, even if the tone is dismissive ("useless", "stop", "annoying", "don't"). The corrective standard is the forward-looking instruction.
- A dismissal is only **DISMISSAL** if it contains NO such standard. "This is useless" alone is DISMISSAL; "This is useless, stop flagging EOF newlines in future reviews" is CORRECTION.

- **QUESTION**: The developer is asking a follow-up question about the bot's suggestion. Examples: "What would you suggest instead?", "Can you explain why this is a problem?", "Would using X fix this?".

- **REVIEW_REQUEST**: The developer is manually asking the bot to re-review the pull request or a specific section. A comment that calls the bot's name (e.g. "@parakh") together with the word "review" is ALWAYS a REVIEW_REQUEST. Examples: "@parakh review", "@parakh review this again", "please re-review", "can you check this PR now?".

- **GENERAL**: The comment is a general conversation, casual acknowledgment, or doesn't fit the above categories. Examples: "lol nice catch", "thanks", "will fix", "I see what you mean", or chatter between developers.
`;
}

// ─── Relationship Classification Prompt ──────────────────────────────────────

/**
 * Build the prompt for classifying the relationship between two rules.
 * Uses few-shot examples for each relationship type.
 */
export function buildRelationshipPrompt(
  newRule: { body: string },
  existingRule: { body: string }
): string {
  return `You are comparing two coding rules to determine their relationship.

## Rule A (NEW — just created)

${newRule.body}

## Rule B (EXISTING — already active in the system)

${existingRule.body}

## Relationship Types

Classify the relationship into exactly one of:

- **DUPLICATE**: Both rules express the same standard in different words. Neither adds information the other lacks.
  Example: Rule A: "Use camelCase for variable names" / Rule B: "Variables should be in camelCase format"

- **REFINEMENT**: Rule A narrows, extends, or adds a specific case to Rule B, but doesn't contradict it. Both can coexist.
  Example: Rule A: "Use PascalCase for React component files" / Rule B: "Use camelCase for all file names"
  (A refines B by adding a specific exception for React components)

- **CONTRADICTION**: Rule A and Rule B are mutually exclusive — following one means violating the other. They cannot both be correct simultaneously.
  Example: Rule A: "Use Zustand for state management" / Rule B: "Use Redux for state management"
  Example: Rule A: "Clean up after each test individually" / Rule B: "Use global cleanup in test setup, not per-test cleanup"

- **UNRELATED**: The two rules address completely different aspects of the codebase with no overlap.
  Example: Rule A: "Use snake_case for database columns" / Rule B: "Always handle promise rejections"
`;
}

// ─── Priority Classification Prompt ──────────────────────────────────────────

/**
 * Build the prompt for classifying a rule's priority.
 */
export function buildPriorityPrompt(ruleBody: string): string {
  return `You are classifying the priority of a coding rule.

## Rule

${ruleBody}

## Priority Levels

- **high**: This rule relates to security, authentication, authorization, data integrity, architecture decisions, or critical business logic. Violations could cause security vulnerabilities, data loss, or systemic issues.
  Examples: "Always validate JWT tokens before processing requests", "Never store passwords in plain text", "Use database transactions for multi-table writes", "All API endpoints must have rate limiting".

- **normal**: This rule relates to code style, naming conventions, readability, non-critical patterns, or general best practices. Violations affect code quality but not system integrity.
  Examples: "Use camelCase for variable names", "Add JSDoc comments to exported functions", "Prefer const over let when the variable is not reassigned", "Use early returns to reduce nesting".
`;
}

// ─── Rule Mode Classification Prompt ─────────────────────────────────────────

/**
 * Build the prompt for classifying a rule's enforcement mode and extracting
 * its suppression patterns.
 *
 * A rule is either 'enforce' (a standard code must comply with) or 'suppress'
 * (a class of issue the reviewer must stop flagging). Suppress rules must
 * NEVER be sent to the LLM as enforceable standards — doing that made old
 * "never flag X" rules backfire (the model reported X as a violation OF the
 * rule). Instead they drive a deterministic post-filter.
 */
export function buildRuleModePrompt(ruleBody: string): string {
  return `You are classifying whether a coding rule is an 'enforce' rule or a 'suppress' rule.

## Rule

${ruleBody}

## Rule Modes

- **enforce**: The rule states a standard that code must comply with; violations should be flagged.
  Examples: "Use camelCase for variable names", "All API endpoints must have rate limiting".

- **suppress**: The rule instructs the reviewer to STOP flagging a class of issue. It is usually
  phrased negatively: "never/don't/stop flagging X", "ignore X", "don't raise X", "don't report X".
  It names something to suppress, not a standard to comply with.
  Examples: "Never flag missing newline at end of file", "Don't report style nits about trailing commas".

## Suppression Patterns

If the mode is 'suppress', extract the concrete topics that should be suppressed as short,
case-insensitive patterns (the thing NOT to flag). Patterns are matched against finding bodies, so
use the concrete nouns/verbs — NOT the instruction wording, and NOT negation words like "never",
"don't", "stop", "ignore", "no".

Examples:
- "Never flag missing newline at end of file" → patterns: ["newline", "end of the file"]
- "Don't report style nits about trailing commas" → patterns: ["trailing comma"]
- "Stop raising EOF newline issues" → patterns: ["newline"]

If the mode is 'enforce', return an empty patterns array.

Return exactly this JSON shape:
{"mode": "enforce" or "suppress", "patterns": ["..."]}
`;
}

// ─── Reply Prompt ────────────────────────────────────────────────────────────

/**
 * Build the prompt for drafting a reply to a developer's question.
 */
export function buildReplyPrompt(
  context: string,
  question: string
): string {
  return `You are Parakh, an AI code review assistant. A developer asked a follow-up question about one of your review comments.

## Context (Your Original Comment)

${context}

## Developer's Question

${question}

## Instructions

Draft a helpful, concise response to the developer's question. Be specific and actionable.
Keep your response under 200 words. Use code examples if they would help clarify.
`;
}
