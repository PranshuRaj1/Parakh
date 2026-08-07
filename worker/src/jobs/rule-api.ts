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

import type { CreateRuleRequest, CreateRuleResponse, ContradictionJobPayload } from '@parakh/shared';
import { GeminiClient } from '../gemini/client.js';
import { insertRule } from '../db/rules.js';
import type { Env } from '../index.js';

/**
 * Handle a rule creation request from the dashboard.
 */
export async function handleCreateRule(
  body: unknown,
  env: Env
): Promise<CreateRuleResponse> {
  // 1. Validate
  const request = body as CreateRuleRequest;
  if (!request.repo || !request.body) {
    throw new Error('Missing required fields: repo, body');
  }

  const gemini = new GeminiClient(env.GEMINI_API_KEY);

  // 2. Generate embedding
  const embedding = await gemini.generateEmbedding(request.body);

  // 3. Classify priority (or use override from request)
  const priority = request.priority || await gemini.classifyPriority(request.body);

  // 4. Insert rule as ACTIVE
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

  // 5. Enqueue contradiction check (same path as PR-comment corrections)
  const contradictionPayload: ContradictionJobPayload = {
    type: 'CONTRADICTION',
    installationId: 0,
    owner: request.repo.split('/')[0],
    repo: request.repo.split('/')[1],
    prNumber: 0, // No PR context for dashboard-created rules
    ruleId: rule.id,
    ruleBody: request.body,
    embedding,
  };

  await env.REVIEW_QUEUE.send(contradictionPayload);

  console.log(`[rule-api] Created rule ${rule.id} for ${request.repo} (priority: ${priority}), contradiction check enqueued`);

  return {
    rule,
    contradictionCheckEnqueued: true,
  };
}
