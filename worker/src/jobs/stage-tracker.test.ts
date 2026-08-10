import { describe, expect, it } from 'vitest';
import { withTimeout, StageTimeoutError, getReviewingFilesTimeout } from './stage-tracker.js';

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
    expect(getReviewingFilesTimeout(0)).toBe(5_000);
    expect(getReviewingFilesTimeout(1)).toBe(35_000);
    expect(getReviewingFilesTimeout(2)).toBe(65_000);
  });

  it('scales without an absolute ceiling — long reviews are bounded by budget', () => {
    expect(getReviewingFilesTimeout(100)).toBe(5_000 + 30_000 * 100);
    expect(getReviewingFilesTimeout(1000)).toBe(5_000 + 30_000 * 1000);
  });
});
