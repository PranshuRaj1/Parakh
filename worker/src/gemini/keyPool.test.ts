import { describe, expect, it } from 'vitest';
import {
  AllKeysExhaustedError,
  DailyQuotaExhaustedError,
  getKeyPool,
  isDailyQuotaError,
  isModelUnavailableError,
  isRateLimitError,
} from './keyPool.js';

describe('getKeyPool', () => {
  it('splits comma-separated keys, trimming whitespace and dropping empties', () => {
    expect(
      getKeyPool({ GEMINI_API_KEYS: 'key1, key2 ,, key3 ', GEMINI_API_KEY: 'fallback' })
    ).toEqual(['key1', 'key2', 'key3']);
  });

  it('falls back to GEMINI_API_KEY when the pool is empty or unset', () => {
    expect(getKeyPool({ GEMINI_API_KEY: 'single' })).toEqual(['single']);
    expect(getKeyPool({ GEMINI_API_KEYS: ', ,', GEMINI_API_KEY: 'single' })).toEqual(['single']);
    expect(getKeyPool({ GEMINI_API_KEYS: '', GEMINI_API_KEY: 'single' })).toEqual(['single']);
  });
});

describe('isRateLimitError', () => {
  it('detects the known rate-limit / quota signals', () => {
    for (const msg of [
      'Request failed with status 429',
      'Quota exceeded for this project',
      'rate limit exceeded',
      'RESOURCE_EXHAUSTED: resource exhausted',
    ]) {
      expect(isRateLimitError(new Error(msg))).toBe(true);
    }
  });

  it('returns false for non-rate-limit errors and non-errors', () => {
    expect(isRateLimitError(new Error('Invalid argument'))).toBe(false);
    expect(isRateLimitError('a plain string')).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe('isModelUnavailableError', () => {
  it('detects per-key model availability errors', () => {
    for (const msg of [
      '404 model not found',
      'model no longer available to new users',
      'gemini-3-flash-preview is not supported',
      '404 NOT_FOUND',
    ]) {
      expect(isModelUnavailableError(new Error(msg))).toBe(true);
    }
  });

  it('is distinct from rate-limit errors', () => {
    expect(isModelUnavailableError(new Error('429 quota exceeded'))).toBe(false);
    expect(isModelUnavailableError('plain')).toBe(false);
  });
});

describe('isDailyQuotaError', () => {
  it('detects daily-quota exhaustion signals', () => {
    for (const msg of [
      '429 RESOURCE_EXHAUSTED: Quota exceeded for project, 20 requests per day',
      'daily limit exceeded',
      'DailyLimitExceeded: quota exhausted for the day',
      'quota exceeded for the day',
    ]) {
      expect(isDailyQuotaError(new Error(msg))).toBe(true);
    }
  });

  it('returns false for transient rate limits and non-errors', () => {
    expect(isDailyQuotaError(new Error('429 quota exceeded'))).toBe(false);
    expect(isDailyQuotaError(new Error('rate limit exceeded'))).toBe(false);
    expect(isDailyQuotaError('per day')).toBe(false);
    expect(isDailyQuotaError(null)).toBe(false);
  });
});

describe('DailyQuotaExhaustedError', () => {
  it('is an AllKeysExhaustedError with a distinct name', () => {
    const err = new DailyQuotaExhaustedError(new Error('quota for the day'));
    expect(err).toBeInstanceOf(AllKeysExhaustedError);
    expect(err.name).toBe('DailyQuotaExhaustedError');
    expect(err.message).toContain('daily quota');
    expect(err.lastError.message).toBe('quota for the day');
  });
});

describe('AllKeysExhaustedError', () => {
  it('wraps the last error with an explanatory message', () => {
    const err = new AllKeysExhaustedError(new Error('boom'));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AllKeysExhaustedError');
    expect(err.message).toContain('boom');
    expect(err.lastError).toBeInstanceOf(Error);
  });
});
