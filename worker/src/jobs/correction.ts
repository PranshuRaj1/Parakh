/**
 * Correction Job — Intent Classification + Rule Creation
 *
 * When a developer replies to a bot comment:
 * 1. Classify intent (CORRECTION/EXPLANATION/DISMISSAL/QUESTION)
 * 2. On CORRECTION: auto-activate a new rule immediately
 * 3. Enqueue contradiction check as async safety net
 *
 * This module ORCHESTRATES gemini, db, and github modules.
 */

import type { CorrectionJobPayload, ContradictionJobPayload } from '@parakh/shared';
import { GeminiClient } from '../gemini/client.js';
import { getCachedToken } from '../github/auth.js';
import { postComment } from '../github/api.js';
import { insertRule } from '../db/rules.js';
import { executeContradictionJob } from './contradiction.js';
import type { Env } from '../index.js';

// ─── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Execute the correction check pipeline.
 *
 * Pipeline:
 * 1. Classify intent of the reply
 * 2. CORRECTION → extract rule, embed, classify priority, insert ACTIVE, enqueue contradiction
 * 3. EXPLANATION → acknowledge
 * 4. QUESTION → draft and post reply
 * 5. DISMISSAL → log, no action
 */
export async function executeCorrectionJob(
  payload: CorrectionJobPayload,
  env: Env
): Promise<void> {
  const { installationId, owner, repo, prNumber, commentBody, parentCommentBody } = payload;
  const fullRepo = `${owner}/${repo}`;

  console.log(`[correction] Processing reply on ${fullRepo}#${prNumber}`);

  const gemini = new GeminiClient(env.GEMINI_API_KEY);

  // 1. Classify intent
  const intent = await gemini.classifyIntent(commentBody, parentCommentBody);
  console.log(`[correction] Intent: ${intent}`);

  // Get token for posting replies
  const redis = { get: createRedisGet(env), set: createRedisSet(env) };
  const token = await getCachedToken(installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);

  switch (intent) {
    case 'CORRECTION':
      await handleCorrection(commentBody, fullRepo, prNumber, owner, repo, token, gemini, env);
      break;

    case 'EXPLANATION':
      await postComment(owner, repo, prNumber,
        `👍 Understood — thanks for the context. I'll keep this in mind.`,
        token
      );
      break;

    case 'QUESTION':
      await handleQuestion(commentBody, parentCommentBody, owner, repo, prNumber, token, gemini);
      break;

    case 'DISMISSAL':
      console.log(`[correction] Reply dismissed on ${fullRepo}#${prNumber}`);
      // No action, no comment
      break;
  }
}

// ─── Correction Handler ──────────────────────────────────────────────────────

/**
 * Handle a CORRECTION intent:
 * 1. Extract the corrective statement as the new rule body
 * 2. Generate embedding
 * 3. Classify priority (security/architecture → high, style → normal)
 * 4. Insert rule with status = ACTIVE (auto-activate, not suggest-and-wait)
 * 5. Post confirmation comment
 * 6. Enqueue contradiction check (async safety net)
 */
async function handleCorrection(
  commentBody: string,
  fullRepo: string,
  prNumber: number,
  owner: string,
  repo: string,
  token: string,
  gemini: GeminiClient,
  env: Env
): Promise<void> {
  // Use the comment body as the rule text (the correction IS the rule)
  const ruleBody = commentBody.trim();

  // Generate embedding for similarity search
  const embedding = await gemini.generateEmbedding(ruleBody);

  // Classify priority
  const priority = await gemini.classifyPriority(ruleBody);

  // Insert rule as ACTIVE — auto-activate, not SUGGESTED
  // This is the "learn live on camera" decision.
  // See accepted risk: race window on auto-activate.
  const rule = await insertRule(
    {
      repo: fullRepo,
      body: ruleBody,
      embedding,
      status: 'ACTIVE',
      priority,
      source_pr: prNumber,
    },
    env
  );

  console.log(`[correction] Created ACTIVE rule ${rule.id} for ${fullRepo} (priority: ${priority})`);

  // Post confirmation comment
  const priorityLabel = priority === 'high' ? '🔴 high' : '🟢 normal';
  await postComment(owner, repo, prNumber,
    `✅ **Learned:** *${ruleBody}*\n\nPriority: ${priorityLabel} · Status: **ACTIVE** · This rule will be applied to future reviews in this repo.`,
    token
  );

  // Enqueue contradiction check (async safety net)
  const contradictionPayload: ContradictionJobPayload = {
    type: 'CONTRADICTION',
    ruleId: rule.id,
    installationId: 0,
    owner: owner,
    repo: repo,
    prNumber: prNumber,
    ruleBody: ruleBody,
    embedding: Array.from(embedding),
  };

  // We are already inside a background execution (waitUntil), so we can just fire and forget,
  // or await it. Let's fire and forget so we can return quickly.
  executeContradictionJob(contradictionPayload, env).catch(err => {
    console.error('[correction] Failed to execute contradiction check:', err);
  });
  console.log(`[correction] Dispatched contradiction check for rule ${rule.id}`);
}

// ─── Question Handler ────────────────────────────────────────────────────────

async function handleQuestion(
  question: string,
  context: string,
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  gemini: GeminiClient
): Promise<void> {
  const reply = await gemini.draftReply(context, question);
  await postComment(owner, repo, prNumber, reply, token);
}

// ─── Redis Helpers ───────────────────────────────────────────────────────────

function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    const data = (await response.json()) as { result: string | null };
    return data.result;
  };
}

function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${key}/${value}/EX/${opts.ex}` : `/${key}/${value}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    return response.json();
  };
}
