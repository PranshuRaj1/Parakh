/**
 * Gemini API Key Pool
 *
 * Rotates through comma-separated keys in GEMINI_API_KEYS.
 * Falls back to singular GEMINI_API_KEY if pool isn't configured.
 *
 * This module ONLY handles key management. No Gemini SDK calls.
 */

// ─── Error Type ──────────────────────────────────────────────────────────────

/**
 * Thrown when every key in the pool has been rate-limited.
 * Caught by the review pipeline to trigger PAUSED_RATE_LIMITED status.
 */
export class AllKeysExhaustedError extends Error {
  constructor(public lastError: Error | null | undefined, message?: string) {
    super(message ?? `All API keys exhausted. Last error: ${lastError?.message ?? 'unknown'}`);
    this.name = 'AllKeysExhaustedError';
  }
}

/**
 * Thrown when every key in the pool has exhausted its DAILY quota (free-tier
 * 20 req/day type errors). Extends AllKeysExhaustedError so existing retry
 * logic still treats it as exhaustion, but the pipeline can special-case it:
 * a daily quota does not recover in 60s, so retry-thrashing is pointless —
 * the review should park (FAILED) and wait for the user to re-trigger.
 */
export class DailyQuotaExhaustedError extends AllKeysExhaustedError {
  constructor(lastError: Error | null | undefined) {
    super(
      lastError,
      `All provider API keys have exhausted their daily quota (free-tier). ` +
      `Last error: ${lastError?.message ?? 'unknown'}`
    );
    this.name = 'DailyQuotaExhaustedError';
  }
}

// ─── Key Pool ────────────────────────────────────────────────────────────────

/**
 * Parse the key pool from environment.
 * Prefers GEMINI_API_KEYS (comma-separated), falls back to GEMINI_API_KEY.
 */
export function getKeyPool(env: { GEMINI_API_KEYS?: string; GEMINI_API_KEY?: string }): string[] {
  return parseKeyPool(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
}

/**
 * Parse the Groq key pool from environment.
 * Prefers GROQ_API_KEYS (comma-separated), falls back to GROQ_API_KEY.
 */
export function getGroqKeyPool(env: { GROQ_API_KEYS?: string; GROQ_API_KEY?: string }): string[] {
  return parseKeyPool(env.GROQ_API_KEYS, env.GROQ_API_KEY);
}

/**
 * Shared comma-separated → trimmed array parsing.
 * Returns at least one entry (or a single empty string) so rotation
 * always has something to attempt — the provider decides what "empty" means.
 */
function parseKeyPool(keysEnv?: string, singleKey?: string): string[] {
  if (keysEnv) {
    const keys = keysEnv.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }
  if (singleKey && singleKey.trim() !== '') {
    return [singleKey];
  }
  return [];
}

// ─── Rate Limit Detection ────────────────────────────────────────────────────

/**
 * Check if an error is a Gemini rate-limit / quota exhaustion error.
 * Covers the known error message patterns from the @google/generative-ai SDK.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || !(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('429')
    || msg.includes('quota')
    || msg.includes('rate limit')
    || msg.includes('resource exhausted');
}

/**
 * Cooldown length when a key is parked for DAILY quota exhaustion (free-tier
 * e.g. "20 requests per day"). A daily quota does not recover in 60s — parking
 * the key for a long window stops every redelivery from re-hammering it.
 */
export const DAILY_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * How long a review stays PAUSED_DAILY_QUOTA before the cron auto-resumes it.
 * Gemini free-tier daily quotas reset at UTC midnight; a 12h park always
 * crosses that boundary regardless of when it was hit.
 */
export const DAILY_QUOTA_PAUSE_AFTER_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Detect a DAILY quota exhaustion error (free-tier "X requests / day" cap),
 * distinct from a transient 60s rate limit. Gemini's free tier reports these
 * as 429 RESOURCE_EXHAUSTED with a "per day" hint; distinguishing them lets us
 * park the key for 6h instead of 60s and, when every key is hit, park the
 * review instead of thrashing in backoff.
 *
 * Also matches a bare `quotaExceeded`/`QUOTA_EXCEEDED` status (no "day" text)
 * when the message contains a day-scale hint, and the SDK's structured
 * `error.status` carried into the message by the provider wrappers.
 */
export function isDailyQuotaError(err: unknown): boolean {
  if (!err || !(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const quotaExceeded = msg.includes('quotaexceeded')
    || msg.includes('quota exceeded')
    || msg.includes('resource exhausted');
  const dayHint = msg.includes('per day')
    || msg.includes('daily limit')
    || msg.includes('dailylimit')
    || msg.includes('quota exhausted for the day')
    || msg.includes('requests per day')
    || msg.includes('per 1000 requests');
  return dayHint || (quotaExceeded && msg.includes('day'));
}

/**
 * Detect a key-specific "this key cannot serve the configured model" error
 * (e.g. 404 NOT_FOUND "model no longer available to new users"). These are
 * per-key problems — a different key in the pool may still work — so the
 * rotation loop should skip the offending key instead of aborting the call.
 */
export function isModelUnavailableError(err: unknown): boolean {
  if (!err || !(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('404')
    || msg.includes('not found')
    || msg.includes('no longer available')
    || msg.includes('is not supported');
}
