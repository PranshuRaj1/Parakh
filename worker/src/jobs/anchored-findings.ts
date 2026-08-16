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
 */

import { MAX_FINDINGS_AS_COMMENTS } from '@parakh/shared';
import { postReviewComment } from '../github/api.js';
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
 * Post the review's NEW findings (first seen at this head sha) as anchored
 * diff comments, capped at MAX_FINDINGS_AS_COMMENTS per review.
 * Returns the number of comments posted.
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

  const redisSet = createRedisSet(env);
  const results = await Promise.allSettled(
    newFindings.map(async (finding) => {
      const comment = await postReviewComment(
        owner, repo, prNumber, headSha, finding.file, finding.line, finding.body, token
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

  const posted = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(
      `[review] ${failed}/${newFindings.length} anchored finding comments failed (lines outside the diff are expected)`
    );
  }
  console.log(`[review] Posted ${posted}/${newFindings.length} anchored finding comments (review ${reviewId})`);
  return posted;
}