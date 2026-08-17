/**
 * Phase 4: review-start attention focus — LLM-elicited, validated, bounded.
 *
 * A single review-start LLM call reads the execution diff and returns the
 * focus areas for the delivery. The response is validated by code before it
 * ever reaches a per-file prompt: shape-checked, field-capped, and
 * instruction-neutralized. On any failure, callers fall back to the
 * deterministic focus (prior-finding anchors / PR summary).
 */

export const FOCUS_MAX_FILES = 8;
export const FOCUS_SUMMARY_MAX_CHARS = 400;
export const FOCUS_REASON_MAX_CHARS = 200;

export interface ReviewFocusFile {
  path: string;
  reason: string;
}

export interface ReviewFocusResult {
  /** Short plain-text summary of what this PR is about and where attention belongs. */
  summary: string;
  /** Files that deserve extra scrutiny, with one-line reasons. */
  files: ReviewFocusFile[];
}

const INSTRUCTION_VERBS =
  /\b(ignore (?:your|previous)|override|disregard|you (?:are|must) now|reveal|do not (?:report|flag) (?!x|.*\byou\b))/i;

/** Deterministic text used in prompts; never a directive to the model. */
function sanitizeFocusField(value: string, maxChars: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, maxChars).trim();
}

/**
 * Validate and bound a raw attention-focus response from any provider.
 * Returns null when the shape is wrong or empty — callers must fall back.
 */
export function validateFocusResponse(raw: unknown): ReviewFocusResult | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const candidate = raw as Record<string, unknown>;
  const summaryRaw = candidate.summary;
  const filesRaw = candidate.files;

  if (typeof summaryRaw !== 'string' && !Array.isArray(filesRaw)) return null;

  const summary =
    typeof summaryRaw === 'string' ? sanitizeFocusField(summaryRaw, FOCUS_SUMMARY_MAX_CHARS) : '';

  const files: ReviewFocusFile[] = [];
  if (Array.isArray(filesRaw)) {
    for (const entry of filesRaw.slice(0, FOCUS_MAX_FILES)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      const reason =
        typeof record.reason === 'string'
          ? sanitizeFocusField(record.reason, FOCUS_REASON_MAX_CHARS)
          : '';
      if (!path || path.length > 500) continue;
      if (INSTRUCTION_VERBS.test(reason)) return null;
      files.push({ path, reason });
    }
  }

  if (!summary && files.length === 0) return null;
  if (summary && INSTRUCTION_VERBS.test(summary)) return null;
  return { summary, files };
}

/** Render the validated focus into the bounded prompt block. */
export function renderFocusBlock(focus: ReviewFocusResult): string {
  const parts: string[] = [];
  if (focus.summary) parts.push(focus.summary);
  for (const file of focus.files) {
    parts.push(`- ${file.path}: ${file.reason}`);
  }
  return parts.join('\n');
}