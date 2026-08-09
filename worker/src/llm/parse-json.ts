/**
 * Tolerant JSON parsing for raw-fetch providers.
 *
 * Model JSON output isn't always clean: fence-wrapped (```json ... ```), with
 * prose around it, or with a trailing comma. This keeps every OpenAI-shaped
 * client (Groq, Cloudflare Workers AI, OpenRouter) parsing identically.
 */

/**
 * Parse model JSON output, tolerating fenced code blocks and trimming prose.
 * Throws the original SyntaxError when no JSON is recoverable — the caller
 * treats that as a real failure (not an exhaustion).
 */
export function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  let candidate = fenced ? fenced[1] : trimmed;
  // Fall back to the first balanced {...} block when the model wrapped an
  // otherwise-valid object in text.
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      candidate = candidate.slice(start, end + 1);
    }
  }
  return JSON.parse(candidate) as T;
}