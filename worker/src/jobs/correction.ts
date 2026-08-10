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

import type { ContradictionJobPayload } from '@parakh/shared';
import { createLLMClients } from '../llm/factory.js';
import { insertRule } from '../db/rules.js';
import type { Env } from '../index.js';

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
  },
  env: Env
) {
  const fullRepo = `${input.owner}/${input.repo}`;

  // The comment body is the rule text — kept verbatim (may include the @parakh mention).
  const ruleBody = input.commentBody
    .replace(/^\s*@parakh\b(?:\s+correction\b)?\s*[:,-]?\s*/i, '')
    .trim();
  if (!ruleBody) throw new Error('Correction must include rule text');

  const { llm } = createLLMClients(env);

  // Generate embedding for similarity search
  const embedding = await llm.generateEmbedding(ruleBody);

  // Classify priority
  const priority = await llm.classifyPriority(ruleBody);

  // Insert rule as ACTIVE — auto-activate, not SUGGESTED
  const rule = await insertRule(
    {
      repo: fullRepo,
      body: ruleBody,
      embedding,
      status: 'ACTIVE',
      priority,
      source_pr: input.prNumber,
    },
    env
  );

  console.log(`[correction] Created ACTIVE rule ${rule.id} for ${fullRepo} (priority: ${priority})`);

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

  await env.WATCHDOG_QUEUE.send(contradictionPayload);
  console.log(`[correction] Enqueued contradiction check for rule ${rule.id}`);

  return rule;
}
