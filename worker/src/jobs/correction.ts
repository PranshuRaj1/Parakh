/**
 * Correction Job — Comment-Driven Rule Creation
 *
 * When a developer tags @parakh with a CORRECTION (e.g. "we don't flag EOF
 * newline issues, drop that rule"), the correction becomes a rule:
 * 1. Use the comment body as the rule text (the correction IS the rule)
 * 2. Generate embedding
 * 3. Classify priority (security/architecture → high, style → normal)
 * 4. Insert rule as ACTIVE (auto-activate, not suggest-and-wait)
 * 5. Enqueue contradiction check (same queue as dashboard rule creation)
 *
 * This mirrors rule-api.ts — both paths share the same ACTIVE-insert +
 * contradiction-queue pipeline so there's no divergence between "rule created
 * via PR comment" and "rule created via dashboard".
 */

import type { ContradictionJobPayload, RuleKind, RulePriority } from '@parakh/shared';
import { createLLMClients } from '../llm/factory.js';
import { insertRule } from '../db/rules.js';
import { truncateBody } from './truncate.js';
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
 * Save a correction comment as an ACTIVE rule and enqueue the contradiction check.
 * Returns the created rule (used by the caller to post a confirmation reply).
 */
export async function saveCorrectionAsRule(
  input: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    commentBody: string;
    createdBy?: string;
    initialStatus?: 'ACTIVE' | 'PENDING';
  },
  env: Env
) {
  const fullRepo = `${input.owner}/${input.repo}`;

  // The comment body is the rule text — the @parakh command prefix (and any
  // optional "correction:" label) is stripped so the stored rule reads clean.
  const ruleBody = input.commentBody
    .replace(/^\s*@parakh\b(?:\s+correction\b)?\s*[:,-]?\s*/i, '')
    .trim();
  if (!ruleBody) throw new Error('Correction must include rule text');

  const { llm } = createLLMClients(env);

  // Generate embedding for similarity search
  const embedding = await llm.generateEmbedding(ruleBody);

  // Classify priority. Fail-open to 'normal' on error: a classifier outage
  // must never block rule creation (mirrors the fail-open rule-mode logic
  // below). Log for manual review.
  let priority: RulePriority = 'normal';
  try {
    priority = (await llm.classifyPriority(ruleBody)) ?? 'normal';
  } catch (err) {
    console.error(
      `[correction] Priority classification failed for "${truncateBody(ruleBody)}" — defaulting to normal:`,
      err
    );
  }

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
