/**
 * Full-file grounding context for review prompts and post-hoc verification.
 *
 * The prompt receives a bounded head-of-file slice (declaration/import regions
 * survive) while verification always sees the FULL content, so findings citing
 * identifiers past the cap are still checked against the real file.
 */

export const REVIEW_FILE_CONTEXT_MAX_CHARS = 60_000;

export interface FileContext {
  /** Untruncated content — for verification only, never the prompt. */
  full: string;
  /** Bounded content — safe to inject into prompts. */
  bounded: string;
  truncated: boolean;
}

/**
 * Bound file content for prompts without splitting a UTF-16 surrogate pair at
 * the slice boundary (which would corrupt the last character of e.g. emoji or
 * CJK ext-B text).
 */
/** Build bounded file context for the provider without changing review state. */
export function buildFileContext(
  content: string,
  maxChars: number = REVIEW_FILE_CONTEXT_MAX_CHARS
): FileContext {
  if (content.length <= maxChars) {
    return { full: content, bounded: content, truncated: false };
  }
  let end = maxChars;
  const codeUnit = content.charCodeAt(end - 1);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    end -= 1;
  }
  return { full: content, bounded: content.slice(0, end), truncated: true };
}
