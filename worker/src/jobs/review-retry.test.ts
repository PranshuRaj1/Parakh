import { describe, expect, it } from 'vitest';
import { getReviewRetryDelaySeconds } from './review-retry.js';

describe('getReviewRetryDelaySeconds', () => {
  it('uses 3 to 5 seconds after the first attempt', () => {
    expect(getReviewRetryDelaySeconds(1, () => 0)).toBe(3);
    expect(getReviewRetryDelaySeconds(1, () => 0.999)).toBe(5);
  });

  it('uses 8 to 12 seconds after the second attempt', () => {
    expect(getReviewRetryDelaySeconds(2, () => 0)).toBe(8);
    expect(getReviewRetryDelaySeconds(2, () => 0.999)).toBe(12);
  });
});
