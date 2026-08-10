import type { Env } from '../index.js';
import type { ReviewStage, StageReasonCode } from '@parakh/shared';
import { dbStartStage, dbCompleteStage, dbFailStage, dbUpdateReason, dbUpdateReasonDetail, dbUpdateHeartbeat, dbTimeoutStage } from '../db/reviews.js';

/**
 * Open a new stage attempt.
 */
export async function startStage(
  reviewId: string,
  stage: ReviewStage,
  attempt: number = 1,
  env: Env,
  detail?: Record<string, unknown>
): Promise<void> {
  await dbStartStage(reviewId, stage, attempt, detail || null, env);
}

/**
 * Close a stage attempt successfully.
 */
export async function completeStage(
  reviewId: string,
  stage: ReviewStage,
  attempt: number,
  env: Env,
  detail?: Record<string, unknown>
): Promise<void> {
  await dbCompleteStage(reviewId, stage, attempt, detail || null, env);
}

/**
 * Close a stage attempt as failed.
 */
export async function failStage(
  reviewId: string,
  stage: ReviewStage,
  attempt: number,
  errorCode: string,
  error: unknown,
  terminal: boolean,
  env: Env
): Promise<void> {
  let message = 'Unknown error';
  let stack: string | null = null;
  if (error instanceof Error) {
    message = error.message;
    stack = error.stack || null;
  } else if (typeof error === 'string') {
    message = error;
  }

  // Basic sanitization
  if (stack) {
    stack = stack.replace(/(x-github-token:|authorization:\s*bearer)\s+[^\s]+/gi, '$1 [REDACTED]');
  }
  message = message.replace(/(x-github-token:|authorization:\s*bearer)\s+[^\s]+/gi, '$1 [REDACTED]');

  await dbFailStage(reviewId, stage, attempt, errorCode, message, stack, terminal, env);
}

/**
 * Update the reason code within an active stage.
 */
export async function updateReason(
  reviewId: string,
  code: StageReasonCode,
  detail: string | null,
  env: Env
): Promise<void> {
  await dbUpdateReason(reviewId, code, detail, env);
}

/**
 * High-frequency progress update (e.g. per-file). Updates the live pointer on
 * the reviews row without appending a reason_transitions entry — keeps DB
 * writes flat for large PRs.
 */
export async function updateReasonDetail(
  reviewId: string,
  code: StageReasonCode,
  detail: string | null,
  env: Env
): Promise<void> {
  await dbUpdateReasonDetail(reviewId, code, detail, env);
}

export async function heartbeat(
  reviewId: string,
  env: Env
): Promise<void> {
  await dbUpdateHeartbeat(reviewId, env);
}

export class StageTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageTimeoutError';
  }
}

/**
 * Wrap a stage operation with an application-level timeout.
 * Rejects with StageTimeoutError if capMs is reached before work finishes.
 * Requires work to respect the passed AbortSignal to actually stop processing!
 */
export async function withTimeout<T>(
  stage: ReviewStage,
  capMs: number,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      controller.abort();
      reject(new StageTimeoutError(`Stage ${stage} timed out after ${capMs}ms`));
    }, capMs);
  });

  try {
    const result = await Promise.race([
      work(controller.signal),
      timeoutPromise
    ]);
    return result;
  } finally {
    clearTimeout(timerId!);
  }
}

export const STAGE_TIMEOUTS_MS = {
  AUTHENTICATING: 10_000,
  FETCHING_DIFF: 15_000,
  LOADING_RULES: 5_000,
  SCORING: 2_000,
  POSTING_COMMENT: 10_000,
  REACTING: 10_000,
};

const BASE_REVIEW_MS = 5_000;
const PER_FILE_REVIEW_MS = 30_000;

/**
 * REVIEWING timeout grows linearly with file count and is NOT capped:
 * a 30-file PR at 30s/file legitimately takes ~15min, and the earlier
 * 5-minute ceiling would abort mid-review (abandoning the subrequest budget
 * and any posted comments). Long reviews are bounded by the per-stage
 * subrequest budget and Cloudflare's CPU/queue limits instead.
 */
export function getReviewingFilesTimeout(filesTotal: number): number {
  return BASE_REVIEW_MS + PER_FILE_REVIEW_MS * filesTotal;
}
