/**
 * LLM Client Factory
 *
 * Builds the Gemini + Groq clients, attaches the optional subrequest budget
 * to both (so real key attempts are counted), and returns the LLMClient
 * facade that routes each call primary → fallback.
 *
 * Also exposes the raw GeminiClient for the embedding path (Groq has no
 * embeddings API — embeddings always go to Gemini).
 */

import type { Env } from '../index.js';
import type { SubrequestBudget } from '../jobs/subrequest-budget.js';
import { GeminiClient } from '../gemini/client.js';
import { GroqClient } from '../groq/client.js';
import { LLMClient } from './provider.js';
import { MemoryCooldownStore, RedisCooldownStore, type CooldownStore } from '../gemini/cooldown-store.js';
import { createRedisGet, createRedisSet } from '../redis.js';

export interface LLMClients {
  llm: LLMClient;
  gemini: GeminiClient;
  groq: GroqClient;
}

/** Per-provider Redis keys for the shared key-cooldown state. */
const GEMINI_COOLDOWN_KEY = 'llm_key_cooldown:gemini';
const GROQ_COOLDOWN_KEY = 'llm_key_cooldown:groq';

/**
 * Construct the provider stack for a given env.
 * Pass the review's SubrequestBudget when running inside the budget-guarded
 * pipeline so every real key attempt counts against it.
 *
 * Key cooldowns are backed by Redis so a queue redelivery that constructs a
 * FRESH client stack inherits keys parked by the previous delivery instead of
 * re-hammering the whole pool. Falls back to in-memory when Redis isn't
 * configured (tests / local).
 */
export function createLLMClients(env: Env, budget?: SubrequestBudget): LLMClients {
  const geminiCooldowns = makeCooldownStore(GEMINI_COOLDOWN_KEY, env);
  const groqCooldowns = makeCooldownStore(GROQ_COOLDOWN_KEY, env);
  const gemini = new GeminiClient(env, geminiCooldowns);
  const groq = new GroqClient(env, groqCooldowns);
  if (budget) {
    gemini.setBudget(budget);
    groq.setBudget(budget);
  }
  const llm = LLMClient.fromEnv(env, gemini, groq);
  return { llm, gemini, groq };
}

/**
 * Build a Redis-backed cooldown store when Redis is fully configured,
 * otherwise fall back to an in-memory store (tests / partial env). Redis
 * backing is what lets a queue redelivery inherit parked keys across
 * deliveries; without it, cooldowns behave like the original in-memory Map.
 */
function makeCooldownStore(key: string, env: Env): CooldownStore {
  if (!env.UPSTASH_REDIS_URL || !env.UPSTASH_REDIS_TOKEN) {
    return new MemoryCooldownStore();
  }
  return new RedisCooldownStore(key, createRedisGet(env), createRedisSet(env));
}
