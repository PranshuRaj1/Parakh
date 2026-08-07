/**
 * Database Client
 *
 * Connection management for Neon Postgres via HTTP driver.
 * Works on Cloudflare Workers edge runtime.
 *
 * This module ONLY provides the connection function. No business logic.
 */

import { neon } from '@neondatabase/serverless';
import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Get a SQL query function bound to the DATABASE_URL.
 * Uses Neon's HTTP driver — no persistent connections, edge-compatible.
 *
 * @param databaseUrl - Neon connection string
 * @returns A tagged template function for executing SQL queries
 */
export function getDb(databaseUrl: string): NeonQueryFunction<false, false> {
  return neon(databaseUrl);
}
