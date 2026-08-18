/**
 * Parakh Worker Entry Point
 *
 * Two responsibilities:
 * 1. fetch handler: GitHub webhook events + dashboard rule creation API
 * 2. queue handler: processes review/correction/contradiction jobs
 *
 * This file ONLY wires up handlers. All logic lives in the appropriate modules.
 */

import { verifySignature } from './webhook/verify.js';
import { handleWebhookEvent } from './webhook/handler.js';
import { handleQueueBatch } from './jobs/queue-handler.js';
import { handleCreateRule, handleApproveRule, handleRejectRule } from './jobs/rule-api.js';
import { handleRetryReview } from './jobs/retry-api.js';
import { handleCronTrigger } from './cron.js';
import { listInstallations, markInstallationRemoved } from './db/installations.js';
import { getStoredUserLLMKeysByLogin, getGithubIdByLogin, upsertUserLLMKeys } from './db/user-llm-keys.js';
import { encryptKey, keyHint } from './llm/encryption.js';
import { providers, getProvider } from './providers/registry.js';
import type { JobPayload } from '@parakh/shared';

// ─── Environment Bindings ────────────────────────────────────────────────────

export interface Env {
  // GitHub App
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_BOT_USER_ID: string;
  // Public app slug used to build the connect/install deep link.
  GITHUB_APP_SLUG?: string;

  // Gemini
  GEMINI_API_KEY?: string;
  GEMINI_API_KEYS?: string;
  // Env override for the generation model (default gemini-2.5-flash).
  GEMINI_GENERATION_MODEL?: string;

  // Groq (secondary provider / fallback). GROQ_API_KEYS is a comma-separated
  // pool like GEMINI_API_KEYS; each key is its own rate-limit bucket.
  GROQ_API_KEY?: string;
  GROQ_API_KEYS?: string;
  GROQ_GENERATION_MODEL?: string;

  // Cloudflare Workers AI (tertiary provider / fallback).
  // Requires the account ID + an API token with Workers AI access.
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  CFAI_GENERATION_MODEL?: string;

  // OpenRouter (quaternary provider / fallback). Single API key.
  OPENROUTER_API_KEY?: string;
  OPENROUTER_GENERATION_MODEL?: string;

  // Provider routing (defaults: primary gemini, fallback groq). The chain
  // then appends every other CONFIGURED provider (cfai, openrouter) in a
  // fixed priority order.
  LLM_PRIMARY?: string;
  LLM_FALLBACK?: string;
  LLM_PROVIDER_TIMEOUT_MS?: string;
  LLM_OPERATION_TIMEOUT_MS?: string;

  // Staged review-pipeline features. These are strings because Wrangler
  // environment bindings arrive as strings. The central parser in
  // config/feature-flags.ts owns defaults and dependency checks.
  SEMANTIC_DIFF_ENABLED?: string;
  BEHAVIOR_GROUPING_ENABLED?: string;
  BEHAVIOR_GROUPING_SHADOW?: string;
  GROUPED_REVIEW_OUTPUT_ENABLED?: string;
  STALENESS_CHECK_ENABLED?: string;
  DETERMINISTIC_ANALYSIS_ENABLED?: string;
  INCREMENTAL_REVIEW_ENABLED?: string;
  INCREMENTAL_REVIEW_SHADOW?: string;
  REVIEW_FILE_CONTEXT_ENABLED?: string;
  ATTENTION_FOCUS_ENABLED?: string;
  BOUNDED_RAW_DIFFS_ENABLED?: string;
  REVIEW_START_FOCUS_ENABLED?: string;

  // Reasoning capture (model thinking) — opt-in via REASONING_CAPTURE_ENABLED
  // (default on). Thinking tokens cost 2x, so REASONING_THINKING_BUDGET caps
  // the per-call spend and REASONING_RETENTION_DAYS prunes stored rows.
  REASONING_CAPTURE_ENABLED?: string;
  REASONING_THINKING_BUDGET?: string;
  REASONING_RETENTION_DAYS?: string;

  // Optional public dashboard base URL — adds a reasoning link to PR comments.
  DASHBOARD_BASE_URL?: string;

  // Queues
  WATCHDOG_QUEUE: Queue<JobPayload>;

  // Database
  DATABASE_URL: string;

  // Redis
  UPSTASH_REDIS_URL: string;
  UPSTASH_REDIS_TOKEN: string;

  // Worker API auth (dashboard → worker)
  WORKER_API_SECRET: string;

  // BYO-keys: secret used to derive the AES-256-GCM key that encrypts user
  // LLM API keys at rest. Missing → key save/load endpoints fail closed.
  LLM_KEY_ENCRYPTION_SECRET?: string;

  // Per-repo hourly cap on comment-triggered LLM calls (default 50).
  CHAT_LLM_BUDGET_PER_HOUR?: string;

}

// ─── Worker Export ────────────────────────────────────────────────────────────

export default {
  /**
   * HTTP handler — serves two paths:
   *
   * POST /webhook  — GitHub webhook events (signature-verified)
   * POST /api/rules — Dashboard rule creation (secret-verified, routes through
   *                    worker so dashboard never touches Gemini)
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Webhook endpoint ──────────────────────────────────────────────
    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhookRequest(request, env, _ctx);
    }

    // ── Dashboard rule creation API ───────────────────────────────────
    if (url.pathname === '/api/rules' && request.method === 'POST') {
      return handleRuleCreationRequest(request, env, _ctx);
    }

    // ── Dashboard retry API ───────────────────────────────────────────
    const retryMatch = url.pathname.match(/^\/api\/reviews\/([^\/]+)\/retry$/);
    if (retryMatch && request.method === 'POST') {
      return handleRetryRequest(request, retryMatch[1], env, _ctx);
    }

    // ── Dashboard rule approval API ─────────────────────────────────
    const approveMatch = url.pathname.match(/^\/api\/rules\/([^\/]+)\/approve$/);
    if (approveMatch && request.method === 'POST') {
      return handleRuleApprovalRequest(request, approveMatch[1], 'ACTIVE', env, _ctx);
    }

    const rejectMatch = url.pathname.match(/^\/api\/rules\/([^\/]+)\/reject$/);
    if (rejectMatch && request.method === 'POST') {
      return handleRuleApprovalRequest(request, rejectMatch[1], 'INACTIVE', env, _ctx);
    }

    // ── Dashboard connect API ───────────────────────────────────────
    if (url.pathname === '/api/connect' && request.method === 'GET') {
      return handleConnectListRequest(request, env);
    }
    if (url.pathname === '/api/connect/url' && request.method === 'GET') {
      return handleConnectUrlRequest(request, env);
    }
    const removeMatch = url.pathname.match(/^\/api\/connect\/([^\/]+)\/([^\/]+)\/remove$/);
    if (removeMatch && request.method === 'POST') {
      return handleConnectRemoveRequest(request, removeMatch[1], removeMatch[2], env);
    }

    // ── User LLM keys API (BYO-keys) ────────────────────────────────
    if (url.pathname === '/api/keys' && request.method === 'GET') {
      return handleKeysGetRequest(request, env);
    }
    if (url.pathname === '/api/keys' && request.method === 'POST') {
      return handleKeysPostRequest(request, env);
    }

    // ── Health check ──────────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'parakh-worker' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * Queue handler — processes messages dispatched via env.WATCHDOG_QUEUE
   * and any other Cloudflare Queues bound to this worker.
   */
  async queue(batch: MessageBatch<JobPayload>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  /**
   * Cron handler — processes scheduled tasks like sweeping stalled reviews
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCronTrigger(env));
  }
};

// ─── Request Handlers ────────────────────────────────────────────────────────

async function handleWebhookRequest(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get('X-Hub-Signature-256') || '';
  const eventType = request.headers.get('X-GitHub-Event') || '';

  // Verify webhook signature
  const isValid = await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  try {
    const event = JSON.parse(body);
    const deliveryId = request.headers.get('X-GitHub-Delivery') || '';
    const result = await handleWebhookEvent(event, eventType, deliveryId, env, _ctx);
    return new Response(result.body, { status: result.status });
  } catch (err) {
    console.error('[worker] Webhook handler error:', err);
    return new Response('Internal error', { status: 500 });
  }
}

/**
 * Handle dashboard rule creation requests.
 *
 * Authenticates via WORKER_API_SECRET header, then delegates to the rule
 * creation handler which does embedding + priority classification + DB insert +
 * contradiction check enqueue. This keeps all Gemini access in the worker.
 */
async function handleRuleCreationRequest(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  // Authenticate dashboard → worker call
  const authHeader = request.headers.get('Authorization') || '';
  const expectedAuth = `Bearer ${env.WORKER_API_SECRET}`;

  if (authHeader !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const body = await request.json() as import('@parakh/shared').CreateRuleRequest;
    const result = await handleCreateRule(body, env, _ctx);
    return new Response(JSON.stringify(result), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[worker] Rule creation error:', err);
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleRetryRequest(request: Request, reviewId: string, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const expectedAuth = `Bearer ${env.WORKER_API_SECRET}`;

  if (authHeader !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 });
  }

  return handleRetryReview(reviewId, env, _ctx);
}

async function handleRuleApprovalRequest(
  request: Request,
  ruleId: string,
  newStatus: 'ACTIVE' | 'INACTIVE',
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  const authHeader = request.headers.get('Authorization') || '';
  const expectedAuth = `Bearer ${env.WORKER_API_SECRET}`;

  if (authHeader !== expectedAuth) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    if (newStatus === 'ACTIVE') {
      await handleApproveRule(ruleId, env);
    } else {
      await handleRejectRule(ruleId, env);
    }
    return new Response(JSON.stringify({ ruleId, status: newStatus }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`[worker] Rule ${newStatus} error:`, err);
    const message = err instanceof Error ? err.message : 'Internal error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Connect API (dashboard → worker) ───────────────────────────────────────

function bearerOk(request: Request, env: Env): boolean {
  return (request.headers.get('Authorization') || '') === `Bearer ${env.WORKER_API_SECRET}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** GET /api/connect — list installations owned by the requesting dashboard user. */
async function handleConnectListRequest(request: Request, env: Env): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  try {
    const installedBy = new URL(request.url).searchParams.get('installedBy')?.trim() || undefined;
    return json({
      providers: providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        url: p.getInstallUrl(env),
      })),
      installations: await listInstallations(env, installedBy),
    });
  } catch (err) {
    console.error('[worker] Connect list error:', err);
    return json({ error: 'Failed to load installations' }, 500);
  }
}

/** GET /api/connect/url?provider=github — the install deep link for a provider. */
async function handleConnectUrlRequest(request: Request, env: Env): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  const providerId = new URL(request.url).searchParams.get('provider') ?? 'github';
  const provider = getProvider(providerId);
  if (!provider) return json({ error: `Unknown provider: ${providerId}` }, 404);
  return json({ provider: provider.id, displayName: provider.displayName, url: provider.getInstallUrl(env) });
}

/** POST /api/connect/:provider/:owner/remove — disconnect an account. */
async function handleConnectRemoveRequest(request: Request, providerId: string, owner: string, env: Env): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!getProvider(providerId)) return json({ error: `Unknown provider: ${providerId}` }, 404);
  try {
    const installedBy = new URL(request.url).searchParams.get('installedBy')?.trim() || undefined;
    await markInstallationRemoved(providerId, owner, env, installedBy);
    return json({ provider: providerId, owner, status: 'removed' });
  } catch (err) {
    console.error('[worker] Connect remove error:', err);
    return json({ error: 'Failed to disconnect' }, 500);
  }
}

// ─── User LLM Keys API (BYO-keys) ─────────────────────────────────────────────

interface SaveKeysRequest {
  installedBy: string;
  geminiKeys?: string[];
  groqKeys?: string[];
  cfaiKeys?: string[];
  cfaiAccountId?: string | null;
  openrouterKeys?: string[];
}

/** Masked-hint view of a user's stored keys, for the dashboard settings page. */
function keysView(stored: import('./db/user-llm-keys.js').StoredUserLLMKeys): unknown {
  return {
    stored: true,
    keys: {
      geminiKeys: stored.geminiKeys.map((k) => k.hint),
      groqKeys: stored.groqKeys.map((k) => k.hint),
      cfaiKeys: stored.cfaiKeys.map((k) => k.hint),
      cfaiAccountId: stored.cfaiAccountId,
      openrouterKeys: stored.openrouterKeys.map((k) => k.hint),
      updatedAt: stored.updatedAt,
    },
  };
}

/** GET /api/keys?installedBy=login — masked key hints for the settings page. */
async function handleKeysGetRequest(request: Request, env: Env): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  const installedBy = new URL(request.url).searchParams.get('installedBy')?.trim() || '';
  if (!installedBy) return json({ error: 'Missing installedBy parameter' }, 400);
  try {
    const stored = await getStoredUserLLMKeysByLogin(installedBy, env);
    if (!stored) return json({ stored: false, keys: null });
    return json(keysView(stored));
  } catch (err) {
    console.error('[worker] Keys load error:', err);
    return json({ error: 'Failed to load keys' }, 500);
  }
}

/** POST /api/keys — full-replace a user's stored keys (encrypted at rest). */
async function handleKeysPostRequest(request: Request, env: Env): Promise<Response> {
  if (!bearerOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.LLM_KEY_ENCRYPTION_SECRET) {
    return json({ error: 'LLM_KEY_ENCRYPTION_SECRET is not configured on the worker' }, 500);
  }

  let body: SaveKeysRequest;
  try {
    body = await request.json() as SaveKeysRequest;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const installedBy = body.installedBy?.trim();
  if (!installedBy) return json({ error: 'Missing installedBy' }, 400);
  const arrays: Array<{ name: string; values?: string[] }> = [
    { name: 'geminiKeys', values: body.geminiKeys },
    { name: 'groqKeys', values: body.groqKeys },
    { name: 'cfaiKeys', values: body.cfaiKeys },
    { name: 'openrouterKeys', values: body.openrouterKeys },
  ];
  for (const { name, values } of arrays) {
    if (values && !Array.isArray(values)) return json({ error: `${name} must be an array of strings` }, 400);
    if (values?.some((v) => typeof v !== 'string')) return json({ error: `${name} must be an array of strings` }, 400);
  }

  try {
    const githubId = await getGithubIdByLogin(installedBy, env);
    if (!githubId) return json({ error: `Unknown dashboard user: ${installedBy}` }, 404);

    const encrypt = (keys?: string[]) => Promise.all(
      (keys ?? []).map((k) => k.trim()).filter(Boolean).map(async (k) => ({
        enc: await encryptKey(k, env.LLM_KEY_ENCRYPTION_SECRET as string),
        hint: keyHint(k),
      }))
    );

    const stored = await upsertUserLLMKeys({
      githubId,
      geminiKeys: await encrypt(body.geminiKeys),
      groqKeys: await encrypt(body.groqKeys),
      cfaiKeys: await encrypt(body.cfaiKeys),
      cfaiAccountId: body.cfaiAccountId?.trim() || null,
      openrouterKeys: await encrypt(body.openrouterKeys),
    }, env);

    return json(keysView(stored));
  } catch (err) {
    console.error('[worker] Keys save error:', err);
    return json({ error: 'Failed to save keys' }, 500);
  }
}
