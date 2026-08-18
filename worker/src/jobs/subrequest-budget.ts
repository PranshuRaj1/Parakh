/**
 * Subrequest Budget Guard
 *
 * Cloudflare Workers (free plan) hard-caps a single invocation at 50 outgoing
 * subrequests — any fetch() counts: Neon HTTP queries, Upstash Redis REST,
 * Gemini REST, GitHub REST. A 13-file review needs ~60+ even after the
 * per-file mitigations, so it used to die mid-run with
 * `NeonDbError: Too many subrequests` and lose progress.
 *
 * This module provides a scoped counter the review job threads through the
 * hot loop. When the budget is nearly spent it throws
 * SubrequestBudgetExceededError — a clean checkpoint, not a crash. The review
 * already saves Redis state per-file, so the queue's redelivery resumes exactly
 * where it left off. The counter is deliberately conservative (counts the seams
 * we control: DB, Redis, GitHub, Gemini) so we stop well under the real 50 cap.
 */

/**
 * Estimated subrequest cap per invocation. Real cap is 50; we stop early so a
 * checkpoint (state already saved per-file) happens before Cloudflare kills
 * the invocation mid-fetch.
 *
 * Rough per-delivery math for a 13-file PR: startup ~9 + 13 files × ~2.2
 * (Gemini + per-file state + throttled detail) + ~3 batches × 3 + findings ~5
 * ≈ 52 — over 50, so large PRs checkpoint and finish on the next delivery.
 * Small PRs (≤5 files ≈ 28 + finalize 15 = 43) still finish in one delivery.
 */
export const SUBREQUEST_BUDGET_LIMIT = 44;

/**
 * Estimated subrequests finalizeReview needs (~7 stage writes + GitHub posts).
 * Retried DB writes (withDbRetry, up to 3 attempts each) cover the extra
 * attempts when Neon throws transient 5xx/520s, so keep headroom for them.
 */
export const FINALIZE_BUDGET_RESERVE = 20;

export class SubrequestBudgetExceededError extends Error {
  constructor(limit: number) {
    super(`Subrequest budget of ${limit} reached — checkpointing for redelivery`);
    this.name = 'SubrequestBudgetExceededError';
  }
}

/**
 * Scoped subrequest counter. `spend()` accounts one (or n) subrequests and
 * throws SubrequestBudgetExceededError once the limit is hit, so the caller
 * can checkpoint cleanly instead of tripping Cloudflare's hard cap mid-flight.
 */
export class SubrequestBudget {
  used = 0;

  constructor(private limit: number) {}

  spend(n = 1): void {
    this.used += n;
    if (this.used >= this.limit) {
      throw new SubrequestBudgetExceededError(this.limit);
    }
  }

  hasRoomFor(n: number): boolean {
    return this.used + n < this.limit;
  }
}
