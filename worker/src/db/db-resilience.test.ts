/**
 * DB Resilience Tests
 *
 * Verifies that transient Neon DB failures (timeouts, connection errors)
 * are retried with exponential backoff and don't crash the review pipeline.
 * These tests protect against the exact failure mode seen in production:
 *   NeonDbError: Error connecting to database: The operation was aborted due to timeout
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { withDbRetry, isTransientDbError, isDbConnectFailure } from './db-retry.js';

// ─── isTransientDbError classification ──────────────────────────────────────

describe('isTransientDbError', () => {
  it('returns true for timeout/abort errors', () => {
    expect(isTransientDbError(new Error('The operation was aborted due to timeout'))).toBe(true);
    expect(isTransientDbError(new AbortError('aborted'))).toBe(true);
    expect(isTransientDbError(new TimeoutError('timeout'))).toBe(true);
  });

  it('returns true for NeonDbError with timeout in message', () => {
    const err = new Error('NeonDbError: Error connecting to database: The operation was aborted due to timeout');
    err.name = 'NeonDbError';
    expect(isTransientDbError(err)).toBe(true);
  });

  it('returns true for connection errors', () => {
    expect(isTransientDbError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientDbError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientDbError(new Error('Connection terminated'))).toBe(true);
  });

  it('returns true for HTTP 5xx errors', () => {
    expect(isTransientDbError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientDbError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientDbError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientDbError(new Error('Syntax error at line 1'))).toBe(false);
    expect(isTransientDbError(new Error('relation "users" does not exist'))).toBe(false);
    expect(isTransientDbError(new Error('division by zero'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTransientDbError('string error')).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

// ─── isDbConnectFailure classification ─────────────────────────────────────

describe('isDbConnectFailure', () => {
  it('matches the exact production Neon connect timeout', () => {
    const err = new Error('Error connecting to database: The operation was aborted due to timeout');
    err.name = 'NeonDbError';
    expect(isDbConnectFailure(err)).toBe(true);
  });

  it('matches when the connect failure is wrapped deeper in the cause chain', () => {
    const cause = new Error('The operation was aborted due to timeout');
    const wrapper = new Error(
      'Review failed with "provider request failed" and failure persistence also failed with "Error connecting to database"',
      { cause }
    );
    wrapper.name = 'ReviewFailurePersistenceError';
    expect(isDbConnectFailure(wrapper)).toBe(true);
  });

  it('does not match ordinary or review-specific failures', () => {
    expect(isDbConnectFailure(new Error('database unavailable'))).toBe(false);
    expect(isDbConnectFailure(new Error('Syntax error at line 1'))).toBe(false);
    expect(isDbConnectFailure(new Error('provider request failed'))).toBe(false);
    expect(isDbConnectFailure('string')).toBe(false);
    expect(isDbConnectFailure(null)).toBe(false);
  });
});

// ─── withDbRetry behavior ──────────────────────────────────────────────────

describe('withDbRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withDbRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('recovered');
    const result = await withDbRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxAttempts then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(
      withDbRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })
    ).rejects.toThrow('timeout');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry non-transient errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Syntax error'));
    await expect(
      withDbRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })
    ).rejects.toThrow('Syntax error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects custom isRetryable predicate', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('custom-retryable'))
      .mockResolvedValue('ok');
    const isRetryable = (err: unknown) =>
      err instanceof Error && err.message.includes('custom-retryable');

    const result = await withDbRetry(fn, { maxAttempts: 3, baseDelayMs: 1, isRetryable });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exponential backoff delays increase between retries', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('ok');

    await withDbRetry(fn, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 });

    // Delays should increase (with some jitter): ~100ms, ~200ms
    expect(delays.length).toBe(2);
    expect(delays[0]).toBeGreaterThanOrEqual(50);
    expect(delays[1]).toBeGreaterThanOrEqual(delays[0] * 0.5);

    vi.restoreAllMocks();
  });
});

// ─── Helper error classes for testing ───────────────────────────────────────

class AbortError extends Error {
  name = 'AbortError';
  constructor(message: string) {
    super(message);
  }
}

class TimeoutError extends Error {
  name = 'TimeoutError';
  constructor(message: string) {
    super(message);
  }
}
