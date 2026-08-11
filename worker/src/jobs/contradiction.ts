/**
 * Contradiction Engine — The Differentiator
 *
 * Detects contradictions between rules using embedding similarity + LLM classification.
 * This is the feature that makes Parakh distinct from Greptile: Greptile has no public
 * mechanism for recognizing mutually exclusive standards and handling supersession.
 *
 * Pipeline:
 * 1. Find similar ACTIVE rules via pgvector cosine similarity
 * 2. For each candidate: classify relationship (DUPLICATE/REFINEMENT/CONTRADICTION/UNRELATED)
 * 3. Act on the relationship:
 *    - CONTRADICTION → supersession (FKs on rules table)
 *    - DUPLICATE → dedup (join table + reinforcement_count)
 *    - REFINEMENT → link (join table, both stay ACTIVE)
 *    - UNRELATED → no action
 */

import type { ContradictionJobPayload } from '@parakh/shared';
import { CONTRADICTION_SIMILARITY_THRESHOLD, CONTRADICTION_MAX_CANDIDATES } from '@parakh/shared';
import { getCachedToken } from '../github/auth.js';
import { postComment } from '../github/api.js';
import { createLLMClients } from '../llm/factory.js';
import {
  findSimilarRules,
  updateRuleStatus,
  setRuleSupersedes,
  incrementReinforcementCount,
  insertRuleRelationship,
} from '../db/rules.js';
import type { Env } from '../index.js';

// ─── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Execute the contradiction check for a newly created rule.
 *
 * This runs ASYNCHRONOUSLY after rule creation (enqueued from correction.ts or rule-api.ts).
 * The rule is already ACTIVE — this is a safety net, not a gate.
 * See accepted risk: race window on auto-activate.
 *
 * @param attempts Queue delivery count — uniform executor signature shared with
 *   executeReviewJob/executeCommentResponseJob. Currently unused by the body.
 */
export async function executeContradictionJob(
  payload: ContradictionJobPayload,
  env: Env,
  attempts = 1
): Promise<void> {
  const { owner, repo, prNumber, ruleId, ruleBody, embedding } = payload;
  const fullRepo = `${owner}/${repo}`;

  console.log(`[contradiction] Checking rule ${ruleId} against existing rules in ${fullRepo}`);

  // 1. Find similar ACTIVE rules via pgvector
  const candidates = await findSimilarRules(
    fullRepo,
    embedding,
    CONTRADICTION_SIMILARITY_THRESHOLD,
    CONTRADICTION_MAX_CANDIDATES,
    env,
    ruleId // exclude self
  );

  if (candidates.length === 0) {
    console.log(`[contradiction] No similar rules found for ${ruleId} — rule stays ACTIVE`);
    return;
  }

  console.log(`[contradiction] Found ${candidates.length} candidate(s) for ${ruleId}`);

  // 2. Classify relationship with each candidate
  const { llm } = createLLMClients(env);

  // Get token for posting comments (only needed if we find something).
  // Uses the payload installationId (real for comment-taught rules) so
  // supersede/duplicate/refinement notices actually post to the PR. The
  // dashboard path passes installationId 0 + prNumber 0, so it never posts.
  let token: string | null = null;
  const getToken = async () => {
    if (!token) {
      const redis = { get: createRedisGet(env), set: createRedisSet(env) };
      token = await getCachedToken(payload.installationId, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, redis);
    }
    return token;
  };

  for (const candidate of candidates) {
    const relationship = await llm.classifyRelationship(
      { body: ruleBody },
      { body: candidate.body }
    );

    console.log(`[contradiction] Rule ${ruleId} <-> ${candidate.id}: ${relationship} (similarity: ${candidate.similarity.toFixed(3)})`);

    switch (relationship) {
      // ── CONTRADICTION → Supersession (uses dedicated FKs) ──────────
      case 'CONTRADICTION': {
        // Old rule → SUPERSEDED
        await updateRuleStatus(candidate.id, 'SUPERSEDED', env, ruleId);
        // New rule → supersedes old
        await setRuleSupersedes(ruleId, candidate.id, env);

        // Post comment (only if we have a PR to comment on)
        if (prNumber > 0) {
          const t = await getToken();
          await postComment(owner, repo, prNumber,
            `⚠️ **Superseded rule:** This correction contradicts an existing rule:\n\n` +
            `> *${candidate.body}*\n\n` +
            `That rule has been marked **SUPERSEDED** and replaced by:\n\n` +
            `> *${ruleBody}*`,
            t
          );
        }

        console.log(`[contradiction] SUPERSEDED: ${candidate.id} → replaced by ${ruleId}`);
        break;
      }

      // ── DUPLICATE → Dedup (uses join table + reinforcement_count) ──
      case 'DUPLICATE': {
        // New rule → INACTIVE (it's a duplicate)
        await updateRuleStatus(ruleId, 'INACTIVE', env);
        // Existing rule gets reinforcement
        await incrementReinforcementCount(candidate.id, env);
        // Record the relationship
        await insertRuleRelationship(ruleId, candidate.id, 'DUPLICATE', env);

        if (prNumber > 0) {
          const t = await getToken();
          await postComment(owner, repo, prNumber,
            `ℹ️ **Duplicate rule detected.** This correction matches an existing active rule:\n\n` +
            `> *${candidate.body}*\n\n` +
            `The existing rule's reinforcement count has been incremented. Your duplicate has been deactivated.`,
            t
          );
        }

        console.log(`[contradiction] DUPLICATE: ${ruleId} → deactivated, reinforced ${candidate.id}`);
        // Stop checking further candidates — this rule is already INACTIVE
        return;
      }

      // ── REFINEMENT → Link, both stay ACTIVE (uses join table) ──────
      case 'REFINEMENT': {
        await insertRuleRelationship(ruleId, candidate.id, 'REFINEMENT', env);

        if (prNumber > 0) {
          const t = await getToken();
          await postComment(owner, repo, prNumber,
            `📎 **Refines existing rule:** This correction refines an existing rule:\n\n` +
            `> *${candidate.body}*\n\n` +
            `Both rules remain **ACTIVE**.`,
            t
          );
        }

        console.log(`[contradiction] REFINEMENT: ${ruleId} refines ${candidate.id} — both stay ACTIVE`);
        break;
      }

      // ── UNRELATED → No action, no comment, no insert ───────────────
      case 'UNRELATED':
        // Explicitly nothing. Not stored in rule_relationships (CHECK constraint doesn't include it).
        break;
    }
  }
}

// ─── Redis Helpers ───────────────────────────────────────────────────────────

function createRedisGet(env: Env): (key: string) => Promise<string | null> {
  return async (key: string) => {
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    const data = (await response.json()) as { result: string | null };
    return data.result;
  };
}

function createRedisSet(env: Env): (key: string, value: string, opts?: { ex?: number }) => Promise<unknown> {
  return async (key: string, value: string, opts?: { ex?: number }) => {
    const args = opts?.ex ? `/${encodeURIComponent(key)}/${encodeURIComponent(value)}/EX/${opts.ex}` : `/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    const response = await fetch(`${env.UPSTASH_REDIS_URL}/set${args}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_TOKEN}` },
    });
    return response.json();
  };
}
