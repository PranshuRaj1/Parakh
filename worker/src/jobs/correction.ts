/**
 * Correction Job — Comment-Driven Rule Creation
 *
 * When a developer tags @parakh with a CORRECTION (e.g. "we don't flag EOF
 * newline issues, drop that rule"), the standards extracted by the folded
 * intent+extraction LLM call become ACTIVE rules:
 * 1. Use the extracted standard as the rule text (one save per rule)
 * 2. Generate embedding
 * 3. Insert rule as ACTIVE with the LLM-classified priority (auto-activate,
 *    not suggest-and-wait)
 * 4. Enqueue contradiction check (same queue as dashboard rule creation)
 *
 * This mirrors rule-api.ts — both paths share the same ACTIVE-insert +
 * contradiction-queue pipeline so there's no divergence between "rule created
 * via PR comment" and "rule created via dashboard".
 */

import type { ContradictionJobPayload, RuleKind, RulePriority } from '@parakh/shared';
import { createLLMClients } from '../llm/factory.js';
import { isRepoCollaborator } from '../github/api.js';
import { insertRule } from '../db/rules.js';
import type { Env } from '../index.js';

/**
 * Phrasing that marks a correction as a SUPPRESSION directive rather than an
 * enforceable standard. If present, the rule is stored as kind='instruction':
 * excluded from the enforce list, rendered as a prompt suppression, and matched
 * deterministically to drop findings.
 */
const INSTRUCTION_HINTS = [
  'stop flagging',
  'stop raising',
  'stop reporting',
  'stop flag',
  'never flag',
  'never raise',
  "don't flag",
  'dont flag',
  'do not flag',
  "don't raise",
  'dont raise',
  'do not raise',
  'in any future review',
  'in future reviews',
];

export function isInstructionRule(ruleBody: string): boolean {
  const lower = ruleBody.toLowerCase();
  return INSTRUCTION_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Attempts to override, extract, or reveal the bot's own instructions/secrets
 * instead of stating a coding standard. A correction matching these must never
 * become a stored rule — it would poison future reviews.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:your|the|previous|prior|above)\s+instructions?/i,
  /disregard\s+(?:your|the|this|all)\s+instructions?/i,
  /system\s+prompt/i,
  /developer\s+mode/i,
  /jailbreak/i,
  /reveal\s+(?:your\s+)?(?:secrets?|api\s*[-_]?keys?|instructions?|prompts?)/i,
  /print\s+(?:your|the|all|my)\s+(?:secrets?|api\s*[-_]?keys?|instructions?|prompts?)/i,
  /show\s+(?:me\s+)?(?:your|the)\s+(?:secrets?|api\s*[-_]?keys?|system\s+prompt)/i,
  /(?:give|send|leak)\s+(?:me\s+)?(?:your\s+)?(?:secrets?|api\s*[-_]?keys?)/i,
];

export function containsInjectionAttempt(ruleBody: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(ruleBody));
}

/**
 * Thrown when a correction cannot become a rule — non-collaborator author,
 * missing author identity, or an injection-style body. The caller replies with
 * a canned refusal instead of the normal "Learned" confirmation.
 */
export class CorrectionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionRejectedError';
  }
}

/**
 * Save ONE extracted corrective standard as an ACTIVE rule and enqueue the
 * contradiction check. Called once per rule from a CORRECTION comment.
 * Returns the created rule (used by the caller to post a confirmation reply).
 *
 * @param token - Installation token used to verify the commenter is a repository
 *   collaborator. Rules may only be taught by trusted users.
 */
export async function saveCorrectionAsRule(
  input: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
ruleBody: string;
    priority?: RulePriority;
    createdBy?: string;
    initialStatus?: 'ACTIVE' | 'PENDING';
    commenterLogin?: string;
  },
  env: Env,
  token: string
) {
  const fullRepo = `${input.owner}/${input.repo}`;
  const ruleBody = input.ruleBody.trim();
  if (!ruleBody) throw new Error('Correction must include rule text');

  if (containsInjectionAttempt(ruleBody)) {
    throw new CorrectionRejectedError('Correction body looks like a prompt-injection attempt');
  }

  // Only repo collaborators may teach rules. Fail closed: missing identity
  // (e.g. queue message from before commenterLogin shipped) is a rejection.
  if (!input.commenterLogin) {
    throw new CorrectionRejectedError('Cannot verify commenter identity — correction rejected');
  }
  const isCollaborator = await isRepoCollaborator(input.owner, input.repo, input.commenterLogin, token);
  if (!isCollaborator) {
    throw new CorrectionRejectedError(
      `Non-collaborator ${input.commenterLogin} cannot add rules to ${fullRepo}`
    );
  }

  const { llm } = createLLMClients(env);

  // Generate embedding for similarity search
  const embedding = await llm.generateEmbedding(ruleBody);

  // Priority comes from the folded intent+extraction call; fail-open to
  // 'normal' on absence (a classification miss must never block rule creation).
  const priority: RulePriority = input.priority ?? 'normal';

  // Suppression directives ("stop flagging X") are stored as 'instruction' rules,
  // never enforced as standards.
  const kind: RuleKind = isInstructionRule(ruleBody) ? 'instruction' : 'standard';

  // Insert rule as ACTIVE or PENDING — auto-activate for OWNER/MEMBER, PENDING for COLLABORATOR
  const rule = await insertRule(
    {
      repo: fullRepo,
      body: ruleBody,
      embedding,
      status: input.initialStatus ?? 'ACTIVE',
      priority,
      kind,
      source_pr: input.prNumber,
      created_by: input.createdBy ?? null,
    },
    env
  );

  console.log(`[correction] Created ACTIVE rule ${rule.id} for ${fullRepo} (priority: ${priority}, kind: ${kind})`);

  // Enqueue contradiction check (async safety net, same queue as dashboard rules)
  const contradictionPayload: ContradictionJobPayload = {
    type: 'CONTRADICTION',
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    ruleId: rule.id,
    ruleBody,
    embedding: Array.from(embedding),
  };

  // Enqueue contradiction check (async safety net, same queue as dashboard rules).
  // Fail-open: the rule is already committed, so a queue hiccup must NOT cause
  // the job to retry and re-insert a duplicate rule. Log and move on.
  try {
    await env.WATCHDOG_QUEUE.send(contradictionPayload);
    console.log(`[correction] Enqueued contradiction check for rule ${rule.id}`);
  } catch (err) {
    console.error(`[correction] Failed to enqueue contradiction check for rule ${rule.id}:`, err);
  }

  return rule;
}
