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
  constructor(public lastError: Error) {
    super(`All Gemini API keys exhausted. Last error: ${lastError.message}`);
    this.name = 'AllKeysExhaustedError';
  }
}

// ─── Key Pool ────────────────────────────────────────────────────────────────

/**
 * Parse the key pool from environment.
 * Prefers GEMINI_API_KEYS (comma-separated), falls back to GEMINI_API_KEY.
 */
export function getKeyPool(env: { GEMINI_API_KEYS?: string; GEMINI_API_KEY: string }): string[] {
  if (env.GEMINI_API_KEYS) {
    const keys = env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return [env.GEMINI_API_KEY];
}

// ─── Rate Limit Detection ────────────────────────────────────────────────────

/**
 * Check if an error is a Gemini rate-limit / quota exhaustion error.
 * Covers the known error message patterns from the @google/generative-ai SDK.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('429')
    || msg.includes('quota')
    || msg.includes('rate limit')
    || msg.includes('resource exhausted');
}

/**
 * Detect a key-specific "this key cannot serve the configured model" error
 * (e.g. 404 NOT_FOUND "model no longer available to new users"). These are
 * per-key problems — a different key in the pool may still work — so the
 * rotation loop should skip the offending key instead of aborting the call.
 */
export function isModelUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('404')
    || msg.includes('not found')
    || msg.includes('no longer available')
    || msg.includes('is not supported');
}
