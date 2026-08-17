/**
 * Database Client
 *
 * Connection management for Neon Postgres via HTTP driver.
 * Works on Cloudflare Workers edge runtime.
 *
 * This module ONLY provides the connection function. No business logic.
 * Retry logic is applied at the call site (e.g. reviews.ts, rules.ts)
 * to avoid breaking sql.transaction(), which requires the raw neon()
 * tagged template function.
 */

import { neon } from '@neondatabase/serverless';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { createRequestSignal } from '../request-timeout.js';

/**
 * Get a SQL query function bound to the DATABASE_URL.
 * Uses Neon's HTTP driver — no persistent connections, edge-compatible.
 *
 * Returns the raw neon() function. Wrap individual call sites with
 * withDbRetry() for transient failure protection.
 *
 * @param databaseUrl - Neon connection string
 * @returns A tagged template function for executing SQL queries
 */
/**
 * Neon requests get a longer budget than generic outbound calls.
 *
 * A 20s abort can fire before Neon's scale-to-zero resume completes (resume
 * often exceeds 30s under load), and each aborted connect re-triggers resume
 * churn — turning a cold start into a self-sustaining outage. Each getDb()
 * call creates a fresh signal, so every retry attempt gets its own budget.
 */
export const DB_REQUEST_TIMEOUT_MS = 45_000;

export function createDbRequestSignal(): AbortSignal {
  return createRequestSignal(DB_REQUEST_TIMEOUT_MS);
}

export function getDb(databaseUrl: string): NeonQueryFunction<false, false> {
  return neon(databaseUrl, { fetchOptions: { signal: createDbRequestSignal() } });
}
