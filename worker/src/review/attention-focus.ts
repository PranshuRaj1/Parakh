import type { LedgerFinding } from './incremental/ledger.js';

/**
 * Deterministic attention focus for a review delivery.
 *
 * Phase 1: when prior findings exist, focus is computed from the ledger —
 * the changed files that previously carried findings are the anchors the
 * model should scrutinize first (merged "summary of prior reviews").
 *
 * Phase 5 fallback: when no prior findings exist (first review / clean
 * parent), focus degrades to the raw PR title + description as background
 * context, so the model knows what the change is supposed to do.
 *
 * Never instruction-shaped: the output is a plain labeled context block,
 * and the prompt marks it as untrusted developer-provided text.
 */

export const ATTENTION_FOCUS_MAX_CHARS = 1_500;
const PR_BODY_MAX_CHARS = 700;

export interface AttentionFocusInput {
  /** Prior unresolved findings grouped by file (empty in full / first reviews). */
  priorFindingsByFile: ReadonlyMap<string, readonly LedgerFinding[]>;
  /** Files changed in this delivery's diff, in diff order. */
  deltaFiles: string[];
  prTitle?: string | null;
  prBody?: string | null;
}

/** Strip markdown, URLs, and control noise so the fallback stays plain text. */
export function sanitizeFocusText(text: string, maxChars: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*>_~#|]/g, ' ')
    .replace(/[\s]+([.,;:!?)])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

export function buildAttentionFocus(input: AttentionFocusInput): string | null {
  const priorTotal = [...input.priorFindingsByFile.values()].reduce(
    (total, findings) => total + findings.length,
    0
  );

  if (priorTotal > 0) {
    const anchorFiles = input.deltaFiles.filter((file) =>
      (input.priorFindingsByFile.get(file)?.length ?? 0) > 0
    );

    if (anchorFiles.length === 0) {
      return sanitizeFocusText(
        `The previous review of this PR left ${priorTotal} unresolved finding(s), none in the ` +
        `files this delta changes. The changed files are new areas of work — review them ` +
        `fresh without expecting carry-over.`,
        ATTENTION_FOCUS_MAX_CHARS
      );
    }

    const anchors = anchorFiles
      .map((file) => `${file} (${input.priorFindingsByFile.get(file)!.length} prior finding(s))`)
      .join(', ');
    return sanitizeFocusText(
      `The previous review of this PR left ${priorTotal} unresolved finding(s). This delta ` +
      `changes ${anchorFiles.length} file(s) that previously carried findings — review those ` +
      `first and confirm whether each prior finding still applies: ${anchors}. Files in this ` +
      `delta without prior findings are new areas of change.`,
      ATTENTION_FOCUS_MAX_CHARS
    );
  }

  const title = input.prTitle?.trim();
  const body = input.prBody?.trim();
  if (!title && !body) return null;

  const parts: string[] = [];
  if (title) parts.push(`PR intent: ${title}`);
  if (body) parts.push(`PR description: ${sanitizeFocusText(body, PR_BODY_MAX_CHARS)}`);
  return sanitizeFocusText(parts.join('\n'), ATTENTION_FOCUS_MAX_CHARS);
}