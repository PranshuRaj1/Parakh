/**
 * Anchored Findings — diff comments for the new findings of a review.
 *
 * One review produces a single summary comment. To make findings individually
 * reply-able, each NEW finding is additionally posted as its own review
 * comment anchored at `file:line` (the same single-comment endpoint
 * postReviewComment always used — no /reviews batch involved).
 *
 * Posting is best-effort via allSettled: GitHub rejects comments whose line is
 * outside the diff's new side, and one such rejection must not block the rest.
 * Every successfully posted comment is mapped in Redis (comment id → finding)
 * so a follow-up reply in the thread can be routed with finding context.
 *
 * Posting is idempotent across redeliveries: each comment body carries a
 * stable marker (`<!-- parakh-anchor:... -->`) and existing markers are
 * checked before posting, so a delivery that dies after POSTING_COMMENT and
 * gets redelivered never posts the same finding twice.
 */

import { MAX_FINDINGS_AS_COMMENTS } from '@parakh/shared';
import { getPRFiles, postReviewComment, listReviewComments } from '../github/api.js';
import { formatPriority } from './overview.js';
import { createRedisSet } from '../redis.js';
import type { Env } from '../index.js';
import type { LedgerFinding } from '../review/incremental/ledger.js';

/** Keep the mapping for the usual life of a PR review (90 days). */
const FINDING_MAPPING_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Redis key mapping an anchored review comment back to its finding. */
export function findingMappingKey(commentId: number): string {
  return `parakh:comment-finding:${commentId}`;
}

/**
 * Stable per-finding marker embedded in the anchored comment body. Keyed on
 * the finding's identity (file + line + finding_id) so the same finding from
 * an earlier delivery matches, while two distinct findings on the same line
 * stay distinct.
 */
/** Create the stable marker used to make an anchored finding idempotent. */
export function findingAnchorMarker(reviewId: string, finding: LedgerFinding): string {
  return `<!-- parakh-anchor:${finding.finding_id} -->`;
}

/**
 * New-side line numbers covered by a unified-diff patch (added + context).
 * Deletion lines don't advance the new side; `\` no-newline markers are skipped.
 */
export function parseNewSideLines(patch: string): number[] {
  const lines: number[] = [];
  let current = 0;
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      current = parseInt(hunk[1], 10);
      continue;
    }
    if (current === 0) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) lines.push(current++);
  }
  return lines;
}

/**
 * Post the review's unresolved findings as anchored diff comments, capped at
 * MAX_FINDINGS_AS_COMMENTS per review. Findings that do not fit remain in the
 * durable ledger and become eligible on a later review.
 * Findings already posted by an earlier delivery (marker present in an
 * existing PR review comment) are skipped. Returns the number of comments
 * posted.
 */
/** Publish ledger findings as GitHub line comments after adjudication is complete. */
export async function postAnchoredFindings(
  reviewId: string,
  ledgerFindings: LedgerFinding[],
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  token: string,
  env: Env
): Promise<number> {
  // Pre-existing anchored markers from earlier deliveries (best-effort: a
  // failure here degrades to posting without dedupe, never to skipping posts).
  let existingMarkers = new Set<string>();
  try {
    const comments = await listReviewComments(owner, repo, prNumber, token);
    existingMarkers = new Set(comments.flatMap((comment) => {
      const body = comment.body ?? '';
      return body.match(/<!-- parakh-anchor:[^>]+ -->/g) ?? [];
    }));
  } catch (err) {
    console.warn('[review] Failed to list existing review comments for anchored-finding dedupe:', err);
  }

  const severityRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  const markerMatches = (finding: LedgerFinding): boolean => {
    const stable = findingAnchorMarker(reviewId, finding);
    const legacy = new RegExp(`<!-- parakh-anchor:[^>]*:${finding.finding_id} -->`);
    return existingMarkers.has(stable) || [...existingMarkers].some((marker) => legacy.test(marker));
  };
  const newFindings = ledgerFindings
    .filter((finding) => finding.last_validated_head_sha === headSha)
    .filter((finding) => !markerMatches(finding))
    .sort((left, right) =>
      severityRank[left.severity] - severityRank[right.severity]
      || left.first_seen_head_sha.localeCompare(right.first_seen_head_sha)
      || left.file.localeCompare(right.file)
      || left.line - right.line
    )
    .slice(0, MAX_FINDINGS_AS_COMMENTS);

  if (newFindings.length === 0) return 0;

  // GitHub rejects anchors on lines outside any diff hunk (422). Fetch each
  // file's patch so a rejected anchor can retry at the nearest in-hunk line —
  // otherwise an off-by-context model line silently loses a high-severity
  // finding. Best-effort: a failed listing just disables the fallback.
  let anchorLines = new Map<string, number[]>();
  try {
    const prFiles = await getPRFiles(owner, repo, prNumber, token);
    anchorLines = new Map(
      prFiles
        .filter((file) => file.patch)
        .map((file) => [file.filename, parseNewSideLines(file.patch!)])
    );
  } catch (err) {
    console.warn('[review] Failed to fetch PR files for anchor-line fallback:', err);
  }
  const nearestAnchorLine = (file: string, line: number): number | null => {
    const candidates = anchorLines.get(file);
    if (!candidates || candidates.length === 0) return null;
    return candidates.reduce((best, n) =>
      Math.abs(n - line) < Math.abs(best - line) ? n : best
    );
  };

  const redisSet = createRedisSet(env);
  const results = await Promise.allSettled(
    newFindings.map(async (finding) => {
      const marker = findingAnchorMarker(reviewId, finding);
      if (existingMarkers.has(marker)) {
        console.log(`[review] Skipping already-posted anchored finding (review ${reviewId}): ${finding.file}:${finding.line}`);
        return null;
      }
      const body = `${formatPriority(finding.severity)} ${finding.body}\n\n${marker}`;
      let anchoredAt = finding.line;
      let comment;
      try {
        comment = await postReviewComment(
          owner, repo, prNumber, headSha, finding.file, anchoredAt, body, token
        );
      } catch (err) {
        const fallbackLine = nearestAnchorLine(finding.file, finding.line);
        if (fallbackLine === null || fallbackLine === finding.line) throw err;
        console.warn(
          `[review] Anchor at ${finding.file}:${finding.line} is outside the diff — retrying at nearest hunk line ${fallbackLine}`
        );
        anchoredAt = fallbackLine;
        comment = await postReviewComment(
          owner, repo, prNumber, headSha, finding.file, fallbackLine, body, token
        );
      }
      await redisSet(
        findingMappingKey(comment.id),
        JSON.stringify({
          reviewId,
          file: finding.file,
          line: anchoredAt,
          body: finding.body,
        }),
        { ex: FINDING_MAPPING_TTL_SECONDS }
      );
      return comment.id;
    })
  );

  const posted = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
  const skipped = results.filter((r) => r.status === 'fulfilled' && r.value === null).length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(
      `[review] ${failed}/${newFindings.length} anchored finding comments failed (lines outside the diff are expected)`
    );
  }
  console.log(`[review] Posted ${posted}/${newFindings.length} anchored finding comments (${skipped} already posted) (review ${reviewId})`);
  return posted;
}
