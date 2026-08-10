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

import type { CreateRuleRequest, CreateRuleResponse, ContradictionJobPayload, RuleMode } from '@parakh/shared';
import { createLLMClients } from '../llm/factory.js';
import { executeContradictionJob } from './contradiction.js';
import { insertRule } from '../db/rules.js';
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

  // Embeddings and priority classification both route through the LLM client
  // chain: Gemini first, then Cloudflare Workers AI for embeddings if Gemini
  // is exhausted. (Groq/OpenRouter have no embeddings API — the chain skips
  // providers that don't implement generateEmbedding.)
  const { llm } = createLLMClients(env);

  // 2. Generate embedding
  const embedding = await llm.generateEmbedding(request.body);

  // 3. Classify priority (or use override from request)
  const priority = request.priority || await llm.classifyPriority(request.body);

  // 4. Classify enforcement mode + suppression patterns. Fail-open: on any
  //    classification error, default to 'enforce' with no patterns — the worst
  //    case is a suppress rule that silently doesn't suppress (safe), never a
  //    blocked rule creation or a mis-routed enforce rule. Log for manual review.
  let mode: RuleMode = 'enforce';
  let patterns: string[] = [];
  try {
    const classification = await llm.classifyRuleMode(request.body);
    mode = classification.mode;
    patterns = classification.patterns;
  } catch (err) {
    console.error(
      `[rule-api] Rule-mode classification failed for "${request.body}" — defaulting to enforce:`,
      err
    );
  }

  // 5. Insert rule as ACTIVE
  const rule = await insertRule(
    {
      repo: request.repo,
      body: request.body,
      embedding,
      status: 'ACTIVE',
      scope: request.scope || {},
      priority,
      mode,
      patterns,
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
