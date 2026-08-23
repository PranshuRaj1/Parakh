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
  suppressedFindings: number;
  cosmeticDemotions: number;
  unverifiedFindings: number;
  contradictedFindings: number;
  reviewFileContextUsed: boolean;
  /** Full-file context fetches attempted (flag on + budget room). */
  reviewFileContextAttempts: number;
  /** Fetches that returned content (truncation counted separately). */
  reviewFileContextSuccesses: number;
  /** Fetches that failed — review degraded to diff-only for that file. */
  reviewFileContextFailures: number;
  /** Successful fetches whose prompt slice hit the bounded cap. */
  reviewFileContextTruncations: number;
  /** True when at least one repo convention file loaded with rules. */
  repoConventionsUsed: boolean;
  /** Convention rules injected into the review prompts after the char cap. */
  repoConventionRules: number;
  /** Number of per-file diffs truncated by the bounded-diff cap before reaching the model. */
  truncatedDiffs: number;
  /** Successful review-start focus calls whose validated result shaped the prompts. */
  reviewFocusCalls: number;
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
  private suppressedFindings = 0;
  private cosmeticDemotions = 0;
  private unverifiedFindings = 0;
  private contradictedFindings = 0;
  private reviewFileContextUsed = false;
  private reviewFileContextAttempts = 0;
  private reviewFileContextSuccesses = 0;
  private reviewFileContextFailures = 0;
  private reviewFileContextTruncations = 0;
  private repoConventionsUsed = false;
  private repoConventionRules = 0;
  private truncatedDiffs = 0;
  private reviewFocusCalls = 0;
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

  recordFindings(
    raw: number,
    accepted: number,
    extras?: { suppressed?: number; cosmeticDemotions?: number }
  ): void {
    this.rawFindings += raw;
    this.acceptedFindings += accepted;
    if (extras) {
      this.suppressedFindings += extras.suppressed ?? 0;
      this.cosmeticDemotions += extras.cosmeticDemotions ?? 0;
    }
  }

  recordVerification(unverified: number, contradicted: number): void {
    this.unverifiedFindings += unverified;
    this.contradictedFindings += contradicted;
  }

  recordFileContextUsed(): void {
    this.reviewFileContextUsed = true;
  }

  recordFileContextAttempt(): void {
    this.reviewFileContextAttempts++;
  }

  /** Counters carry no source or prompt data — only outcomes. */
  recordFileContextSuccess(truncated: boolean): void {
    this.reviewFileContextUsed = true;
    this.reviewFileContextSuccesses++;
    if (truncated) this.reviewFileContextTruncations++;
  }

  recordFileContextFailure(): void {
    this.reviewFileContextFailures++;
  }

  /** Counters carry no markdown content — only outcomes. */
  recordConventionLoad(rulesLoaded: number): void {
    this.repoConventionsUsed = true;
    this.repoConventionRules = rulesLoaded;
  }

  recordTruncatedDiff(): void {
    this.truncatedDiffs++;
  }

  recordReviewFocus(): void {
    this.reviewFocusCalls++;
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
      suppressedFindings: this.suppressedFindings,
      cosmeticDemotions: this.cosmeticDemotions,
      unverifiedFindings: this.unverifiedFindings,
      contradictedFindings: this.contradictedFindings,
      reviewFileContextUsed: this.reviewFileContextUsed ? '1' : '0',
      reviewFileContextAttempts: this.reviewFileContextAttempts,
      reviewFileContextSuccesses: this.reviewFileContextSuccesses,
      reviewFileContextFailures: this.reviewFileContextFailures,
      reviewFileContextTruncations: this.reviewFileContextTruncations,
      repoConventionsUsed: this.repoConventionsUsed ? '1' : '0',
      repoConventionRules: this.repoConventionRules,
      truncatedDiffs: this.truncatedDiffs,
      reviewFocusCalls: this.reviewFocusCalls,
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
      suppressedFindings: this.suppressedFindings,
      cosmeticDemotions: this.cosmeticDemotions,
      unverifiedFindings: this.unverifiedFindings,
      contradictedFindings: this.contradictedFindings,
      reviewFileContextUsed: this.reviewFileContextUsed,
      reviewFileContextAttempts: this.reviewFileContextAttempts,
      reviewFileContextSuccesses: this.reviewFileContextSuccesses,
      reviewFileContextFailures: this.reviewFileContextFailures,
      reviewFileContextTruncations: this.reviewFileContextTruncations,
      repoConventionsUsed: this.repoConventionsUsed,
      repoConventionRules: this.repoConventionRules,
      truncatedDiffs: this.truncatedDiffs,
      reviewFocusCalls: this.reviewFocusCalls,
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
