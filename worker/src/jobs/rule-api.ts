/**
 * Rule API Handler — Dashboard Rule Creation
 *
 * Handles POST /api/rules requests from the dashboard.
 * Routes through the worker so dashboard never touches Gemini directly.
 *
 * Pipeline:
 * 1. Validate request body
 * 2. Generate embedding (Gemini)
 * 3. Classify priority (Gemini)
 * 4. Insert rule as ACTIVE
 * 5. Enqueue contradiction check (same path as PR-comment corrections)
 *
 * This ensures no silent divergence between "rule created via PR comment"
 * and "rule created via dashboard" — both trigger the contradiction engine.
 */

import type { CreateRuleRequest, CreateRuleResponse, ContradictionJobPayload, RuleStatus } from '@parakh/shared';
import { createLLMClients } from '../llm/factory.js';
import { executeContradictionJob } from './contradiction.js';
import { insertRule } from '../db/rules.js';
import { getDb } from '../db/client.js';
import { truncateBody } from './truncate.js';
import type { Env } from '../index.js';

/**
 * Handle a rule creation request from the dashboard.
 */
export async function handleCreateRule(
  request: CreateRuleRequest,
  env: Env,
  _ctx?: ExecutionContext
): Promise<CreateRuleResponse> {
  // 1. Validate
  if (!request.repo || !request.body) {
    throw new Error('Missing required fields: repo, body');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repo)) {
    throw new Error(`Malformed repo: ${request.repo}`);
  }

  // Embeddings and priority classification both route through the LLM client
  // chain: Gemini first, then Cloudflare Workers AI for embeddings if Gemini
  // is exhausted. (Groq/OpenRouter have no embeddings API — the chain skips
  // providers that don't implement generateEmbedding.)
  const { llm } = createLLMClients(env);

  // 2. Generate embedding
  const embedding = await llm.generateEmbedding(request.body);

  // 3. Classify priority (or use override from request). Fail-open to 'normal'
  //    on error so rule creation is never blocked by a classifier outage.
  let priority = request.priority;
  if (!priority) {
    try {
      priority = (await llm.classifyPriority(request.body)) ?? 'normal';
    } catch (err) {
      priority = 'normal';
      console.error(
        `[rule-api] Priority classification failed for "${truncateBody(request.body)}" (repo: ${request.repo}) — defaulting to normal:`,
        err
      );
    }
  }

  // 4. Insert rule as ACTIVE. Dashboard rules are enforceable standards
  //    (kind defaults to 'standard' in the insert); suppression directives are
  //    created via @parakh corrections.
  const rule = await insertRule(
    {
      repo: request.repo,
      body: request.body,
      embedding,
      status: 'ACTIVE',
      scope: request.scope || {},
      priority,
    },
    env
  );

  // 6. Enqueue contradiction check (same path as PR-comment corrections)
  const payload: ContradictionJobPayload = {
    type: 'CONTRADICTION',
    ruleId: rule.id,
    installationId: 0,
    owner: request.repo.split('/')[0],
    repo: request.repo.split('/')[1],
    prNumber: 0,
    ruleBody: request.body,
    embedding: Array.from(embedding),
  };

  // Run asynchronously without blocking the API response
  if (_ctx) {
    _ctx.waitUntil(executeContradictionJob(payload, env).catch(err => {
      console.error('[rule-api] Failed to execute contradiction job:', err);
    }));
  }

  console.log(`[rule-api] Dispatched contradiction job for rule ${rule.id}`);

  return {
    rule,
    contradictionCheckEnqueued: true,
  };
}

/**
 * Transition a rule from PENDING to the given target status.
 *
 * Shared by approve/reject so the two handlers can't drift apart.
 * Only PENDING rules may be moved; anything else is reported to the caller.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function moveRuleOutOfPending(ruleId: string, target: Extract<RuleStatus, 'ACTIVE' | 'INACTIVE'>, action: string, env: Env): Promise<void> {
  if (!UUID_PATTERN.test(ruleId)) {
    throw new Error(`Invalid rule id: expected a UUID, got "${ruleId}"`);
  }

  const sql = getDb(env.DATABASE_URL);

  const rows = await sql`
    UPDATE rules SET status = ${target}
    WHERE id = ${ruleId} AND status = 'PENDING'
    RETURNING id
  `;

  if (rows.length === 0) {
    throw new Error(`Rule ${ruleId} not found or not in PENDING status`);
  }

  console.log(`[rule-api] ${action} rule ${ruleId}`);
}

/**
 * Approve a PENDING rule (change status to ACTIVE).
 */
export async function handleApproveRule(ruleId: string, env: Env): Promise<void> {
  await moveRuleOutOfPending(ruleId, 'ACTIVE', 'Approved', env);
}

/**
 * Reject a PENDING rule (change status to INACTIVE).
 */
export async function handleRejectRule(ruleId: string, env: Env): Promise<void> {
  await moveRuleOutOfPending(ruleId, 'INACTIVE', 'Rejected', env);
}
