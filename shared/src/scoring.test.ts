import { describe, expect, it } from 'vitest';
import {
  computeScore,
  displayScore,
  dedupeFindings,
  normalizeMessage,
  resolveSeverityForRuleViolation,
} from './scoring.js';
import type { Finding } from './types.js';

function finding(severity: Finding['severity'], overrides: Partial<Finding> = {}): Finding {
  return {
    severity,
    file: 'src/a.ts',
    line: 1,
    body: 'issue',
    suggestion: null,
    rule_id: null,
    ...overrides,
  };
}

describe('computeScore', () => {
  it('returns a perfect 5 when there are no findings', () => {
    expect(computeScore([])).toBe(5);
  });

  it('subtracts CRITICAL and HIGH linearly (uncapped)', () => {
    expect(computeScore([finding('CRITICAL')])).toBe(2.5);
    expect(computeScore([finding('HIGH')])).toBe(3.75);
    expect(computeScore([finding('CRITICAL'), finding('HIGH')])).toBe(1.25);
  });

  it('clamps at 0 once CRITICAL/HIGH exceed the budget', () => {
    expect(computeScore([finding('CRITICAL'), finding('CRITICAL')])).toBe(0);
    expect(computeScore(Array(10).fill(finding('CRITICAL')))).toBe(0);
  });

  it('saturates LOW: each additional nit hurts less', () => {
    // sat(1) ≈ 0.0725, sat(20) ≈ 0.3927 — twenty nits barely outrank one
    const one = computeScore([finding('LOW')]);
    const nineteen = computeScore(Array(19).fill(finding('LOW')));
    const twenty = computeScore(Array(20).fill(finding('LOW')));
    expect(one).toBeCloseTo(4.9275, 3);
    expect(twenty).toBeCloseTo(4.6073, 3);
    // Diminishing returns: the 1st nit costs more than the 20th one adds.
    const marginalFirst = 5 - one;
    const marginalTwentieth = nineteen - twenty;
    expect(marginalFirst).toBeGreaterThan(marginalTwentieth);
  });

  it('saturates MEDIUM', () => {
    expect(computeScore([finding('MEDIUM')])).toBeCloseTo(4.6682, 3);
    expect(computeScore(Array(10).fill(finding('MEDIUM')))).toBeCloseTo(3.6231, 3);
  });

  it('never drives a nit-only PR below ~3.1 (deduped worst case)', () => {
    // 45 MEDIUM + 30 LOW, no CRITICAL/HIGH: sat(45)+sat(30) ≈ 1.899
    const many = [
      ...Array(45).fill(finding('MEDIUM')),
      ...Array(30).fill(finding('LOW')),
    ];
    expect(computeScore(many)).toBeCloseTo(3.101, 2);
  });

  it('never exceeds 5', () => {
    expect(computeScore([finding('LOW')])).toBeLessThanOrEqual(5);
  });
});

describe('displayScore', () => {
  it('rounds raw scores to the nearest 0.1', () => {
    expect(displayScore(4.9275)).toBe(4.9);
    expect(displayScore(4.6073)).toBe(4.6);
    expect(displayScore(3.6231)).toBe(3.6);
    expect(displayScore(3.101)).toBe(3.1);
    expect(displayScore(3.75)).toBe(3.8);
    expect(displayScore(4.65)).toBe(4.7);
    expect(displayScore(5)).toBe(5);
    expect(displayScore(0)).toBe(0);
  });
});

describe('normalizeMessage', () => {
  it('lowercases, strips punctuation, collapses whitespace, and caps length', () => {
    expect(normalizeMessage('No newline at END of file!!!')).toBe('no newline at end of file');
    expect(normalizeMessage('foo  bar\n\tbaz')).toBe('foo bar baz');
  });

  it('caps the normalized body to 200 characters', () => {
    expect(normalizeMessage('x'.repeat(500))).toHaveLength(200);
    expect(normalizeMessage('x'.repeat(50))).toHaveLength(50);
  });
});

describe('dedupeFindings', () => {
  it('keeps the higher severity when the same issue appears as both generic and rule finding', () => {
    const low = finding('LOW', { body: 'No newline at end of file', rule_id: null });
    const medium = finding('MEDIUM', { body: 'No newline at end of file', rule_id: 'rule-9' });
    const out = dedupeFindings([low, medium]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('MEDIUM');
    expect(out[0].rule_id).toBe('rule-9');
  });

  it('collapses duplicates that differ only in case/punctuation/whitespace', () => {
    const a = finding('LOW', { body: 'No newline at end of file!' });
    const b = finding('MEDIUM', { body: 'no  newline at end of file' });
    const out = dedupeFindings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('MEDIUM');
  });

  it('keeps findings on different lines', () => {
    const a = finding('LOW', { line: 21 });
    const b = finding('LOW', { line: 22 });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it('keeps findings in different files', () => {
    const a = finding('LOW', { file: 'src/a.ts' });
    const b = finding('LOW', { file: 'src/b.ts' });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it('preserves first-seen order and keeps the first on a severity tie', () => {
    const a = finding('LOW', { body: 'x' });
    const b = finding('LOW', { body: 'x' });
    const out = dedupeFindings([a, b]);
    expect(out).toEqual([a]);
  });

  it('returns an empty array for empty input', () => {
    expect(dedupeFindings([])).toEqual([]);
  });
});

describe('resolveSeverityForRuleViolation', () => {
  it('maps high-priority rules to HIGH severity', () => {
    expect(resolveSeverityForRuleViolation('high')).toBe('HIGH');
  });

  it('maps normal-priority rules to MEDIUM severity', () => {
    expect(resolveSeverityForRuleViolation('normal')).toBe('MEDIUM');
  });
});
