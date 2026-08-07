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
import { handleCreateRule } from './jobs/rule-api.js';
import { handleRetryReview } from './jobs/retry-api.js';
import type { JobPayload } from '@parakh/shared';

// ─── Environment Bindings ────────────────────────────────────────────────────

export interface Env {
  // GitHub App
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_BOT_USER_ID: string;

  // Gemini
  GEMINI_API_KEY: string;
  GEMINI_API_KEYS?: string;

  // Queues
  WATCHDOG_QUEUE: Queue<JobPayload>;

  // Database
  DATABASE_URL: string;

  // Redis
  UPSTASH_REDIS_URL: string;
  UPSTASH_REDIS_TOKEN: string;

  // Worker API auth (dashboard → worker)
  WORKER_API_SECRET: string;

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
    console.warn('[worker] Invalid webhook signature');
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
