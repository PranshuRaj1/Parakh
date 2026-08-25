/**
 * Bounded raw diffs — large-codebase viability.
 *
 * Per-file diffs are capped before reaching the model. The cap preserves the
 * diff's head (metadata + earliest hunks) so the review stays representative,
 * and appends an explicit truncation marker so the model knows the diff is
 * incomplete and must not reason about omitted hunks.
 *
 * Deterministic and pure — the full diff is untouched for the incremental
 * ledger and scoring; only the LLM-facing text is bounded.
 */

export const REVIEW_DIFF_MAX_CHARS = 40_000;

const TRUNCATION_MARKER =
  '---\n' +
  'DIFF_TRUNCATED: this file diff exceeds the review size cap and was cut off.\n' +
  'Later hunks are omitted. Do not report findings about anything beyond the shown hunks,\n' +
  'and do not claim the file ends here.\n';

export interface BoundedDiff {
  diff: string;
  truncated: boolean;
}

/** Trim a unified diff to at most `maxChars`, cutting only at line boundaries. */
/** Bound oversized diffs so one provider request cannot consume the review budget. */
export function boundDiff(rawDiff: string, maxChars = REVIEW_DIFF_MAX_CHARS): BoundedDiff {
  if (rawDiff.length <= maxChars) return { diff: rawDiff, truncated: false };

  const lines = rawDiff.split('\n');
  const kept: string[] = [];
  let keptChars = 0;
  for (const line of lines) {
    const nextChars = keptChars + line.length + 1;
    if (nextChars > maxChars) break;
    kept.push(line);
    keptChars = nextChars;
  }
  if (kept.length === 0) {
    kept.push(rawDiff.slice(0, maxChars));
    keptChars = Math.min(rawDiff.length, maxChars);
  }
  return { diff: [...kept, TRUNCATION_MARKER.trimEnd()].join('\n'), truncated: true };
}
