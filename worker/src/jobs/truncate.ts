/**
 * Log-Bounding Helper
 *
 * Keeps logged rule bodies and request payloads bounded so a long rule can't
 * bloat logs or leak PII. Shared by rule-api.ts and correction.ts.
 */

/**
 * Truncate a value to `max` characters for safe logging. Null/undefined input
 * is tolerated (returns '') so callers never have to guard before logging.
 */
export function truncateBody(body: string | null | undefined, max = 80): string {
  if (body == null) {
    return '';
  }
  return body.length > max ? `${body.slice(0, max)}…` : body;
}
