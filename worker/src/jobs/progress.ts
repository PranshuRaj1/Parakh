/**
 * Review Progress Tracking
 *
 * Tracks granular review pipeline steps and dispatches watchdog messages.
 * Every Gemini-calling phase wraps its work in stepStarted/stepCompleted/stepFailed.
 *
 * This module handles observability + watchdog scheduling. No Gemini, no GitHub.
 */

import type { WatchdogPayload } from '@parakh/shared';
import { DEFAULT_STUCK_TIMEOUT_SECONDS } from '@parakh/shared';
import {
  insertStepEvent,
  updateReviewCurrentStep,
  markReviewRunning,
  markReviewFailed,
  getRepoSettingsByReviewId,
  getMatchingStartedEvent,
} from '../db/reviews.js';
import { sanitizeErrorText } from './sanitize.js';
import type { Env } from '../index.js';

// ─── Step Types ──────────────────────────────────────────────────────────────

export type Step =
  | 'FETCHING_DIFF'
  | 'FETCHING_RULES'
  | 'REVIEWING_FILES'     // set per-batch, detail = { batchIndex, fileNames }
  | 'COMPUTING_SCORE'
  | 'POSTING_COMMENT'
  | 'FINALIZING';

// ─── Internal State ──────────────────────────────────────────────────────────

/**
 * Tracks which reviews have had their first stepStarted() call.
 * The first call transitions SEEN → RUNNING.
 * Cleared per-review via resetProgressTracking() in the finally block.
 */
const activatedReviews = new Set<string>();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Mark a step as started.
 *
 * 1. On first call for a review: transitions SEEN → RUNNING
 * 2. Inserts audit event into review_step_events
 * 3. Updates reviews.current_step for dashboard display
 * 4. Schedules a delayed watchdog message
 *
 * Returns the event ID (used by the watchdog for freshness checking).
 */
export async function stepStarted(
  reviewId: string,
  step: Step,
  env: Env,
  detail?: Record<string, unknown>
): Promise<string> {
  // First step: SEEN → RUNNING (Bug 4 fix from v3)
  if (!activatedReviews.has(reviewId)) {
    await markReviewRunning(reviewId, env);
    activatedReviews.add(reviewId);
  }

  // Insert audit event
  const eventId = await insertStepEvent(reviewId, step, 'STARTED', detail ?? null, env);

  // Update live dashboard columns
  await updateReviewCurrentStep(reviewId, step, detail ?? null, env);

  // Schedule watchdog
  const settings = await getRepoSettingsByReviewId(reviewId, env);
  const timeoutSeconds = settings?.stuck_timeout_seconds ?? DEFAULT_STUCK_TIMEOUT_SECONDS;

  const watchdogPayload: WatchdogPayload = {
    type: 'WATCHDOG',
    reviewId,
    step,
    expectedEventId: eventId,
  };
  await env.WATCHDOG_QUEUE.send(watchdogPayload, { delaySeconds: timeoutSeconds });

  return eventId;
}

/**
 * Mark a step as completed.
 * Inserts an audit event. No watchdog cancellation needed —
 * the consumer checks freshness on arrival.
 */
export async function stepCompleted(
  reviewId: string,
  step: Step,
  env: Env,
  detail?: Record<string, unknown>
): Promise<void> {
  const startedEvent = await getMatchingStartedEvent(reviewId, step, env);
  const durationMs = startedEvent ? Date.now() - new Date(startedEvent.created_at).getTime() : null;
  await insertStepEvent(reviewId, step, 'COMPLETED', detail ?? null, env, durationMs);
}

/**
 * Mark a step as failed. Sets the review to FAILED status.
 * Used for non-recoverable errors (NOT for rate-limit exhaustion,
 * which uses markReviewPaused instead).
 */
export async function stepFailed(
  reviewId: string,
  step: Step,
  error: unknown,
  env: Env
): Promise<void> {
  const rawMsg = error instanceof Error ? error.message : String(error);
  const rawStack = error instanceof Error ? error.stack ?? null : null;
  const msg = sanitizeErrorText(rawMsg);
  const stack = rawStack ? sanitizeErrorText(rawStack) : null;

  const startedEvent = await getMatchingStartedEvent(reviewId, step, env);
  const durationMs = startedEvent ? Date.now() - new Date(startedEvent.created_at).getTime() : null;

  await insertStepEvent(reviewId, step, 'FAILED', { error: msg }, env, durationMs);
  await markReviewFailed(reviewId, step, msg, stack, env);
}

/**
 * Clean up per-review tracking state.
 * Called in the finally block of executeReviewJobInternal.
 * Necessary because Cloudflare may reuse isolates across invocations.
 */
export function resetProgressTracking(reviewId: string): void {
  activatedReviews.delete(reviewId);
}
