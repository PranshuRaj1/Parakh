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
import { postReviewComment, listReviewComments } from '../github/api.js';
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
export function findingAnchorMarker(reviewId: string, finding: LedgerFinding): string {
  return `<!-- parakh-anchor:${reviewId}:${finding.file}:${finding.line}:${finding.finding_id} -->`;
}

/**
 * Post the review's NEW findings (first seen at this head sha) as anchored
 * diff comments, capped at MAX_FINDINGS_AS_COMMENTS per review.
 * Findings already posted by an earlier delivery (marker present in an
 * existing PR review comment) are skipped. Returns the number of comments
 * posted.
 */
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
  const newFindings = ledgerFindings
    .filter((finding) => finding.first_seen_head_sha === headSha && finding.last_validated_head_sha === headSha)
    .slice(0, MAX_FINDINGS_AS_COMMENTS);

  if (newFindings.length === 0) return 0;

  // Pre-existing anchored markers from earlier deliveries (best-effort: a
  // failure here degrades to posting without dedupe, never to skipping posts).
  let existingMarkers = new Set<string>();
  try {
    const comments = await listReviewComments(owner, repo, prNumber, token);
    existingMarkers = new Set(
      comments
        .flatMap((comment) => comment.body?.match(/<!-- parakh-anchor:[^>]+ -->/g) ?? [])
    );
  } catch (err) {
    console.warn('[review] Failed to list existing review comments for anchored-finding dedupe:', err);
  }

  const redisSet = createRedisSet(env);
  const results = await Promise.allSettled(
    newFindings.map(async (finding) => {
      const marker = findingAnchorMarker(reviewId, finding);
      if (existingMarkers.has(marker)) {
        console.log(`[review] Skipping already-posted anchored finding (review ${reviewId}): ${finding.file}:${finding.line}`);
        return null;
      }
      const comment = await postReviewComment(
        owner, repo, prNumber, headSha, finding.file, finding.line,
        `${formatPriority(finding.severity)} ${finding.body}\n\n${marker}`, token
      );
      await redisSet(
        findingMappingKey(comment.id),
        JSON.stringify({
          reviewId,
          file: finding.file,
          line: finding.line,
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
