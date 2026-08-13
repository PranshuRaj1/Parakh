import type { IncrementalShadowRun } from '../../db/reviews.js';
import { measureReviewInput } from '../baseline/metrics.js';

function countDiffFiles(diff: string): number {
  return diff.match(/^diff --git /gm)?.length ?? 0;
}

export interface ShadowObservationInput {
  reviewId: string;
  parentReviewId: string | null;
  decision: IncrementalShadowRun['decision'];
  fallbackReason: string | null;
  parentHeadSha: string | null;
  currentHeadSha: string;
  fullDiff: string;
  incrementalDiff: string | null;
  executionDiffHash: string;
  fullDiffHash: string;
}

export function buildShadowObservation(input: ShadowObservationInput): IncrementalShadowRun {
  const full = measureReviewInput(input.fullDiff);
  const incremental = input.incrementalDiff === null
    ? null
    : measureReviewInput(input.incrementalDiff);
  return {
    reviewId: input.reviewId,
    parentReviewId: input.parentReviewId,
    decision: input.decision,
    fallbackReason: input.fallbackReason,
    parentHeadSha: input.parentHeadSha,
    currentHeadSha: input.currentHeadSha,
    fullInputCharacters: full.inputCharacters,
    incrementalInputCharacters: incremental?.inputCharacters ?? null,
    fullEstimatedTokens: full.estimatedInputTokens,
    incrementalEstimatedTokens: incremental?.estimatedInputTokens ?? null,
    fullFileCount: countDiffFiles(input.fullDiff),
    incrementalFileCount: input.incrementalDiff === null
      ? null
      : countDiffFiles(input.incrementalDiff),
    inputRatio: incremental && full.inputCharacters > 0
      ? incremental.inputCharacters / full.inputCharacters
      : null,
    executionDiffHash: input.executionDiffHash,
    fullDiffHash: input.fullDiffHash,
    executionMatchesFull: input.executionDiffHash === input.fullDiffHash,
  };
}
