/**
 * LLM Client Factory
 *
 * Builds every configured provider (Gemini, Groq, Cloudflare Workers AI,
 * OpenRouter), attaches the optional subrequest budget to each (so real key
 * attempts are counted), and returns the LLMClient chain facade that routes
 * each call primary → fallback → ... in resolveProviderChain order.
 *
 * Also exposes raw access to every provider (rule-api uses the chain for
 * embeddings; the individual clients remain reachable for tests/embedding
 * paths that must be provider-specific).
 */

import type { Env } from '../index.js';
import type { SubrequestBudget } from '../jobs/subrequest-budget.js';
import { GeminiClient } from '../gemini/client.js';
import { GroqClient } from '../groq/client.js';
import { CfaAiClient, type CfaAiEnv } from '../cfai/client.js';
import { OpenRouterClient, type OpenRouterEnv } from '../openrouter/client.js';
import { LLMClient, type ProviderName, type LLMProvider } from './provider.js';
import { MemoryCooldownStore, RedisCooldownStore, type CooldownStore } from '../gemini/cooldown-store.js';
import { createRedisGet, createRedisSet } from '../redis.js';

export interface LLMClients {
  llm: LLMClient;
  gemini: GeminiClient;
  /** Groq — null when not configured (no GROQ_API_KEY / GROQ_API_KEYS). */
  groq: GroqClient | null;
  /** Cloudflare Workers AI — null when not configured (CF_ACCOUNT_ID/CF_API_TOKEN). */
  cfai: CfaAiClient | null;
  /** OpenRouter — null when not configured (OPENROUTER_API_KEY). */
  openrouter: OpenRouterClient | null;
}

/** Per-provider Redis keys for the shared key-cooldown state. */
const GEMINI_COOLDOWN_KEY = 'llm_key_cooldown:gemini';
const GROQ_COOLDOWN_KEY = 'llm_key_cooldown:groq';

/**
 * Construct the provider stack for a given env.
 * Pass the review's SubrequestBudget when running inside the budget-guarded
 * pipeline so every real key attempt counts against it.
 *
 * Key cooldowns for the key-pool providers (Gemini, Groq) are backed by Redis
 * so a queue redelivery that constructs a FRESH client stack inherits keys
 * parked by the previous delivery instead of re-hammering the whole pool.
 * Falls back to in-memory when Redis isn't configured (tests / local).
 *
 * CF Workers AI and OpenRouter are per-account / per-key (no rotation pool), so
 * they don't need a cooldown store.
 */
export function createLLMClients(env: Env, budget?: SubrequestBudget): LLMClients {
  const gemini = new GeminiClient(env, makeCooldownStore(GEMINI_COOLDOWN_KEY, env));

  // Gate every non-Gemini provider on having credentials: a provider with NO
  // key is "not configured" and must be absent from the chain — otherwise a
  // guaranteed 401/400 from it would abort the chain before reaching the next
  // configured fallback.
  const groq: GroqClient | null =
    env.GROQ_API_KEY || env.GROQ_API_KEYS
      ? new GroqClient(env, makeCooldownStore(GROQ_COOLDOWN_KEY, env))
      : null;
  const cfai: CfaAiClient | null =
    env.CF_ACCOUNT_ID && env.CF_API_TOKEN
      ? new CfaAiClient(env as CfaAiEnv)
      : null;
  const openrouter: OpenRouterClient | null =
    env.OPENROUTER_API_KEY
      ? new OpenRouterClient(env as OpenRouterEnv)
      : null;

  const providerMap: Partial<Record<ProviderName, LLMProvider>> = {
    gemini,
    groq: groq ?? undefined,
    cfai: cfai ?? undefined,
    openrouter: openrouter ?? undefined,
  };

  if (budget) {
    gemini.setBudget(budget);
    groq?.setBudget(budget);
    cfai?.setBudget(budget);
    openrouter?.setBudget(budget);
  }

  const llm = LLMClient.fromEnv(env, providerMap);
  return { llm, gemini, groq, cfai, openrouter };
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