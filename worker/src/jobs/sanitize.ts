/**
 * Secret Sanitization
 *
 * Scans error messages and stack traces for common secret patterns before they
 * are persisted to the database.
 */

const SECRET_PATTERNS = [
  /gh[ps]_[a-zA-Z0-9]{36,}/g, // GitHub Personal Access Tokens and Server-to-Server tokens
  /AIza[a-zA-Z0-9_-]{35}/g,   // Google / Gemini API Keys
  /Bearer\s+[a-zA-Z0-9._-]+/gi, // Bearer tokens (case insensitive)
  /-----BEGIN[\s\S]+?PRIVATE KEY-----[\s\S]+?-----END[\s\S]+?PRIVATE KEY-----/g, // PEM Private Keys
];

export function sanitizeErrorText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[redacted]');
  }
  return result;
}
