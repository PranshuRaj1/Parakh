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
export function getDb(databaseUrl: string): NeonQueryFunction<false, false> {
  return neon(databaseUrl, { fetchOptions: { signal: createRequestSignal() } });
}
