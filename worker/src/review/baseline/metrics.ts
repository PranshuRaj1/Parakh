import type { FeatureFlags } from '../../config/feature-flags.js';
import type { ResumeValidationHash } from '../resume-validation-hash.js';

export type ReviewBaselineOutcome = 'completed' | 'checkpoint' | 'failed' | 'skipped';

export interface ReviewInputMeasurement {
  inputCharacters: number;
  inputBytes: number;
  estimatedInputTokens: number;
}

export interface ReviewBaselineSnapshot extends ReviewInputMeasurement {
  schemaVersion: 1;
  reviewId: string;
  attempt: number;
  diffHash: ResumeValidationHash | null;
  parsedFiles: number;
  reviewableFiles: number;
  ignoredFiles: number;
  logicalReviewCalls: number;
  rawFindings: number;
  acceptedFindings: number;
  rawScore: number | null;
  displayedScore: number | null;
  elapsedMs: number;
  accountedSubrequests: number;
  outcome: ReviewBaselineOutcome;
  checkpointReason: string | null;
  flags: FeatureFlags;
}

/** Measure raw input without claiming access to provider-side token billing. */
export function measureReviewInput(rawDiff: string): ReviewInputMeasurement {
  const inputCharacters = Array.from(rawDiff).length;
  return {
    inputCharacters,
    inputBytes: new TextEncoder().encode(rawDiff).byteLength,
    estimatedInputTokens: Math.ceil(inputCharacters / 4),
  };
}

/**
 * Delivery-scoped passive metrics. Every mutation is synchronous, so the
 * counter remains safe when async review workers finish in a different order.
 */
export class ReviewBaselineCollector {
  private readonly startedAt: number;
  private input: ReviewInputMeasurement = {
    inputCharacters: 0,
    inputBytes: 0,
    estimatedInputTokens: 0,
  };
  private diffHash: ResumeValidationHash | null = null;
  private parsedFiles = 0;
  private reviewableFiles = 0;
  private ignoredFiles = 0;
  private logicalReviewCalls = 0;
  private rawFindings = 0;
  private acceptedFindings = 0;
  private rawScore: number | null = null;
  private displayedScore: number | null = null;

  constructor(
    private readonly reviewId: string,
    private attempt: number,
    private readonly flags: FeatureFlags,
    private readonly now: () => number = () => performance.now()
  ) {
    this.startedAt = now();
  }

  recordAttempt(attempt: number): void {
    this.attempt = attempt;
  }

  captureInput(
    rawDiff: string,
    diffHash: ResumeValidationHash,
    parsedFiles: number,
    reviewableFiles: number
  ): void {
    this.input = measureReviewInput(rawDiff);
    this.diffHash = diffHash;
    this.parsedFiles = parsedFiles;
    this.reviewableFiles = reviewableFiles;
    this.ignoredFiles = Math.max(0, parsedFiles - reviewableFiles);
  }

  recordReviewCall(): void {
    this.logicalReviewCalls++;
  }

  recordFindings(raw: number, accepted: number): void {
    this.rawFindings += raw;
    this.acceptedFindings += accepted;
  }

  recordScore(raw: number, displayed: number): void {
    this.rawScore = raw;
    this.displayedScore = displayed;
  }

  /** Small safe subset suitable for existing stage-event detail JSON. */
  stageDetail(): Record<string, number | string | null> {
    return {
      diffHash: this.diffHash,
      inputCharacters: this.input.inputCharacters,
      inputBytes: this.input.inputBytes,
      estimatedInputTokens: this.input.estimatedInputTokens,
      parsedFiles: this.parsedFiles,
      reviewableFiles: this.reviewableFiles,
      ignoredFiles: this.ignoredFiles,
      logicalReviewCalls: this.logicalReviewCalls,
      rawFindings: this.rawFindings,
      acceptedFindings: this.acceptedFindings,
      rawScore: this.rawScore,
      displayedScore: this.displayedScore,
    };
  }

  snapshot(
    outcome: ReviewBaselineOutcome,
    accountedSubrequests: number,
    checkpointReason: string | null = null
  ): ReviewBaselineSnapshot {
    return {
      schemaVersion: 1,
      reviewId: this.reviewId,
      attempt: this.attempt,
      diffHash: this.diffHash,
      ...this.input,
      parsedFiles: this.parsedFiles,
      reviewableFiles: this.reviewableFiles,
      ignoredFiles: this.ignoredFiles,
      logicalReviewCalls: this.logicalReviewCalls,
      rawFindings: this.rawFindings,
      acceptedFindings: this.acceptedFindings,
      rawScore: this.rawScore,
      displayedScore: this.displayedScore,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      accountedSubrequests,
      outcome,
      checkpointReason,
      flags: { ...this.flags },
    };
  }
}

/** Emit one source-free structured event. Logging failure must not fail review. */
export function emitReviewBaseline(snapshot: ReviewBaselineSnapshot): void {
  console.log(`[review-baseline] ${JSON.stringify(snapshot)}`);
}

/** Aggregate delivery events when reporting a review's checkpoint count. */
export function countCheckpointEvents(snapshots: ReviewBaselineSnapshot[]): number {
  return snapshots.filter((snapshot) => snapshot.outcome === 'checkpoint').length;
}
