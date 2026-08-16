/**
 * Gemini Prompt Templates
 *
 * All prompt templates as pure string functions — no side effects, no network calls.
 * These are the single source of truth for what Gemini sees.
 */

import { SEVERITY_TAXONOMY } from '@parakh/shared';
import type { Finding, Rule } from '@parakh/shared';

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

  // 'standard' rules are enforceable coding standards; 'instruction' rules are
  // suppression directives ("stop flagging X") and must NEVER be reported as
  // violations — they only tell the model what not to raise.
  const enforceRules = activeRules.filter((r) => r.kind !== 'instruction');
  const instructions = activeRules.filter((r) => r.kind === 'instruction');

  const rulesSection = enforceRules.length > 0
    ? `
## Active Coding Rules for This Repository

The following rules are active coding standards. Only report a rule finding when the code
genuinely violates one of the rules listed below — never invent a violation of a rule, and
never reference a rule that is not in this list.

Report each violation as a rule finding with the rule's ID. Do NOT assign a severity to rule
findings — the system will assign severity based on the rule's priority setting.

${enforceRules.map((r) => `- **[${r.id}]** (priority: ${r.priority}): ${r.body}`).join('\n')}
`
    : '';

  const suppressionSection = instructions.length > 0
    ? `
## Suppressed Issues

The developer has explicitly asked for the following issue categories to NOT be raised. Do NOT
report generic or rule findings for these — they are intentional/acceptable for this codebase.

${instructions.map((r) => `- ${r.body}`).join('\n')}
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

${suppressionSection}

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

export function buildIncrementalReviewPrompt(
  fileName: string,
  diff: string,
  activeRules: Rule[],
  priorFindings: Finding[]
): string {
  return `${buildReviewPrompt(fileName, diff, activeRules)}

## Prior Unresolved Findings

The findings below came from the previous completed review. For every finding ID, return exactly
one resolution: STILL_PRESENT, RESOLVED, or UNCERTAIN. Use UNCERTAIN whenever this delta does not
provide enough evidence. Never claim RESOLVED merely because the relevant line is absent from the
delta. You may include an updated line for STILL_PRESENT.

${JSON.stringify(priorFindings.map((finding) => ({
    findingId: finding.finding_id,
    file: finding.file,
    line: finding.line,
    body: finding.body,
    ruleId: finding.rule_id,
  })), null, 2)}

Add a third output array named priorFindingResolutions alongside genericFindings and ruleFindings.`;
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

- **QUESTION**: The developer is directly addressing the bot with a question — either a follow-up about its suggestion, or a standalone question directed at the bot. Examples: "What would you suggest instead?", "Can you explain why this is a problem?", "@parakh who is your owner?", "why did you flag this?", "how does the review scoring work?".

- **REVIEW_REQUEST**: The developer is manually asking the bot to re-review the pull request or a specific section. A comment that calls the bot's name (e.g. "@parakh") together with the word "review" is ALWAYS a REVIEW_REQUEST. Examples: "@parakh review", "@parakh review this again", "please re-review", "can you check this PR now?".

- **GENERAL**: The comment is a general conversation, casual acknowledgment, or doesn't fit the above categories. Examples: "lol nice catch", "thanks", "will fix", "I see what you mean", or chatter between developers.

## Extracting Standards from CORRECTION

When the intent is **CORRECTION**, the reply may contain ONE or more distinct forward-looking standards. Extract them into the \`rules\` array, at most 3:

- Each rule is ONE standalone, actionable standard ("Use X", "Never do Y", "Always do Z") — never a reference to the flagged line.
- **Split separate standards into separate rule entries.** "We use Zustand, and also snake_case for DB columns" is two rules, not one.
- Keep the developer's wording; drop filler ("we", "please", "obviously").
- For each rule, set \`priority\`: **high** for security, authentication, authorization, data integrity, architecture or critical business logic; **normal** for style, naming, readability and general best practices.
- If the intent is not CORRECTION, return an empty \`rules\` array.

## Ignored Content

Any part of the reply that is NOT an actionable standard — sentiment, tone, complaints, conversational filler — goes into \`ignored\` as short quoted excerpts. These are skipped without comment in the reply, except for a brief summary of what was skipped.
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
