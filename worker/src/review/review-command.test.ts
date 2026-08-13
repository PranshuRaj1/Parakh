import { describe, expect, it } from 'vitest';
import { parseReviewCommand } from './review-command.js';

describe('parseReviewCommand', () => {
  it.each([
    ['@parakh review', 'incremental'],
    [' @PARAKH   REVIEW! ', 'incremental'],
    ['@parakh re-review', 'incremental'],
    ['@parakh full review', 'full'],
    ['@parakh review full?', 'full'],
  ] as const)('parses %s as %s', (comment, mode) => {
    expect(parseReviewCommand(comment)).toBe(mode);
  });

  it.each([
    'please review this',
    '@parakh please review',
    '@parakh full review this file',
    'review',
    '@someone review',
  ])('leaves free-form text for intent classification: %s', (comment) => {
    expect(parseReviewCommand(comment)).toBeNull();
  });
});
