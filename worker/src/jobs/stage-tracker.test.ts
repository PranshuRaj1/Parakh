import { describe, expect, it } from 'vitest';
import {
  withTimeout,
  StageTimeoutError,
  getReviewingFilesTimeout,
  getStageDeadline,
  shouldCheckpointDelivery,
  DELIVERY_CHECKPOINT_MS,
  QUEUE_CONSUMER_WALL_TIME_MS,
  WATCHDOG_GRACE_MS,
} from './stage-tracker.js';

describe('withTimeout', () => {
  it('resolves with the work result when it finishes in time', async () => {
    await expect(withTimeout('SCORING', 200, async () => 'done')).resolves.toBe('done');
  });

  it('rejects with a StageTimeoutError when the work exceeds the cap', async () => {
    await expect(
      withTimeout('FETCHING_DIFF', 20, async (signal) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return signal.aborted ? 'aborted' : 'finished';
      })
    ).rejects.toBeInstanceOf(StageTimeoutError);
  });

  it('aborts the signal passed to the work when the cap is reached', async () => {
    let signalRef: AbortSignal | undefined;
    await withTimeout('FETCHING_DIFF', 10, (signal) => {
      signalRef = signal;
      return new Promise<void>((resolve) => setTimeout(resolve, 100));
    }).catch(() => {});

    // Let the late-resolving work observe the already-aborted signal.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(signalRef!.aborted).toBe(true);
  });

  it('does not resolve with the late work result after the timeout fired', async () => {
    const result = await withTimeout('SCORING', 5, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'late';
    }).catch(() => 'timed-out');
    expect(result).toBe('timed-out');
  });
});

describe('getReviewingFilesTimeout', () => {
  it('scales with the number of files from a base', () => {
    expect(getReviewingFilesTimeout(0)).toBe(120_000);
    expect(getReviewingFilesTimeout(1)).toBe(360_000);
    expect(getReviewingFilesTimeout(2)).toBe(360_000);
    expect(getReviewingFilesTimeout(5)).toBe(720_000);
  });

  it('caps large reviews below the queue platform limit', () => {
    expect(getReviewingFilesTimeout(20)).toBeLessThan(QUEUE_CONSUMER_WALL_TIME_MS);
    expect(getReviewingFilesTimeout(100)).toBe(12 * 60_000);
    expect(getReviewingFilesTimeout(1000)).toBe(12 * 60_000);
  });

  it('places the watchdog deadline after the stage timeout and grace', () => {
    const timeout = getReviewingFilesTimeout(26);
    expect(Date.parse(getStageDeadline(timeout, 1_000))).toBe(1_000 + timeout + WATCHDOG_GRACE_MS);
    expect(timeout + WATCHDOG_GRACE_MS).toBeLessThan(QUEUE_CONSUMER_WALL_TIME_MS);
  });

  it('checkpoints before another bounded batch can cross the delivery budget', () => {
    const startedAt = 1_000;
    expect(shouldCheckpointDelivery(startedAt, startedAt + DELIVERY_CHECKPOINT_MS - 300_001, 300_000)).toBe(false);
    expect(shouldCheckpointDelivery(startedAt, startedAt + DELIVERY_CHECKPOINT_MS - 300_000, 300_000)).toBe(true);
  });
});
