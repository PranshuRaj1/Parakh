import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_FLAGS } from '../../config/feature-flags.js';
import {
  countCheckpointEvents,
  emitReviewBaseline,
  measureReviewInput,
  ReviewBaselineCollector,
} from './metrics.js';

describe('measureReviewInput', () => {
  it('counts characters, UTF-8 bytes, and an explicitly estimated token total', () => {
    expect(measureReviewInput('abcd')).toEqual({
      inputCharacters: 4,
      inputBytes: 4,
      estimatedInputTokens: 1,
    });
    expect(measureReviewInput('🐍')).toEqual({
      inputCharacters: 1,
      inputBytes: 4,
      estimatedInputTokens: 1,
    });
    expect(measureReviewInput('')).toEqual({
      inputCharacters: 0,
      inputBytes: 0,
      estimatedInputTokens: 0,
    });
    expect(measureReviewInput('abcde').estimatedInputTokens).toBe(2);
  });
});

describe('ReviewBaselineCollector', () => {
  it('collects calls, findings, score, file counts, and deterministic latency', () => {
    const times = [100, 145];
    const collector = new ReviewBaselineCollector(
      'review-1',
      2,
      { ...DEFAULT_FEATURE_FLAGS },
      () => times.shift() ?? 145
    );
    collector.captureInput('🐍abc', 'a'.repeat(64), 3, 2);
    collector.recordReviewCall();
    collector.recordReviewCall();
    collector.recordFindings(4, 3);
    collector.recordScore(3.75, 3.8);

    expect(collector.snapshot('completed', 31)).toMatchObject({
      reviewId: 'review-1',
      attempt: 2,
      inputCharacters: 4,
      inputBytes: 7,
      estimatedInputTokens: 1,
      parsedFiles: 3,
      reviewableFiles: 2,
      ignoredFiles: 1,
      logicalReviewCalls: 2,
      rawFindings: 4,
      acceptedFindings: 3,
      rawScore: 3.75,
      displayedScore: 3.8,
      elapsedMs: 45,
      accountedSubrequests: 31,
      outcome: 'completed',
    });
  });

  it('clamps clock regressions and leaves score empty for checkpoints', () => {
    const times = [100, 90];
    const collector = new ReviewBaselineCollector(
      'review-1', 1, { ...DEFAULT_FEATURE_FLAGS }, () => times.shift() ?? 90
    );
    expect(collector.snapshot('checkpoint', 44, 'subrequest_budget')).toMatchObject({
      elapsedMs: 0,
      rawScore: null,
      displayedScore: null,
      outcome: 'checkpoint',
      checkpointReason: 'subrequest_budget',
    });
  });

  it('emits source-free JSON rather than code, prompts, or credentials', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const collector = new ReviewBaselineCollector(
      'review-1', 1, { ...DEFAULT_FEATURE_FLAGS }, () => 0
    );
    emitReviewBaseline(collector.snapshot('skipped', 0));

    const output = String(log.mock.calls[0][0]);
    expect(output).toContain('[review-baseline]');
    expect(output).not.toContain('rawDiff');
    expect(output).not.toContain('prompt');
    expect(output).not.toContain('token');
  });

  it('tracks file-context attempts, successes, failures, and truncations without source data', () => {
    const collector = new ReviewBaselineCollector(
      'review-1', 1, { ...DEFAULT_FEATURE_FLAGS }, () => 0
    );
    collector.recordFileContextAttempt();
    collector.recordFileContextSuccess(false);
    collector.recordFileContextAttempt();
    collector.recordFileContextSuccess(true);
    collector.recordFileContextAttempt();
    collector.recordFileContextFailure();

    expect(collector.snapshot('completed', 0)).toMatchObject({
      reviewFileContextUsed: true,
      reviewFileContextAttempts: 3,
      reviewFileContextSuccesses: 2,
      reviewFileContextFailures: 1,
      reviewFileContextTruncations: 1,
    });
  });

  it('derives checkpoint count from delivery outcomes', () => {
    const collector = new ReviewBaselineCollector(
      'review-1', 1, { ...DEFAULT_FEATURE_FLAGS }, () => 0
    );
    expect(countCheckpointEvents([
      collector.snapshot('checkpoint', 44, 'subrequest_budget'),
      collector.snapshot('completed', 21),
      collector.snapshot('checkpoint', 44, 'subrequest_budget'),
    ])).toBe(2);
  });
});
