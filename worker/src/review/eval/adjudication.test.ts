import { describe, expect, it } from 'vitest';
import {
  adjudicateVerdicts,
  verdictsDisagree,
} from './adjudication.js';
import type { JudgeVerdict } from './types.js';

function verdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    defectExists: true,
    matchedDefectId: 'defect-1',
    correctness: 2,
    localization: 2,
    actionability: 2,
    unsupportedClaim: false,
    evidenceQuote: 'relevant code',
    reason: 'The finding matches the defect.',
    ...overrides,
  };
}

describe('adjudicateVerdicts', () => {
  it.each([
    [[verdict()], new Set<string>(), 'correct'],
    [[verdict({ correctness: 1 })], new Set<string>(), 'partially_correct'],
    [[verdict({ defectExists: false, matchedDefectId: null, correctness: 0 })], new Set<string>(), 'incorrect'],
    [[verdict({ unsupportedClaim: true })], new Set<string>(), 'unsupported'],
    [[verdict()], new Set(['defect-1']), 'duplicate'],
    [[verdict({ matchedDefectId: null })], new Set<string>(), 'valid_unlisted'],
    [[], new Set<string>(), 'needs_human_review'],
  ] as const)('maps judge output to %s', (verdicts, matched, expected) => {
    expect(adjudicateVerdicts([...verdicts], matched)).toBe(expected);
  });

  it('holds conflicting fields for human review', () => {
    expect(adjudicateVerdicts([
      verdict({ defectExists: false, correctness: 2 }),
    ])).toBe('needs_human_review');
  });

  it('holds disagreeing judge passes for human review', () => {
    const verdicts = [verdict(), verdict({ correctness: 1 })];
    expect(verdictsDisagree(verdicts)).toBe(true);
    expect(adjudicateVerdicts(verdicts)).toBe('needs_human_review');
  });
});
