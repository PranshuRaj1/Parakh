import { describe, expect, it } from 'vitest';
import { computeScore, displayScore, resolveSeverityForRuleViolation } from './scoring.js';
import type { Finding } from './types.js';

function finding(severity: Finding['severity']): Finding {
  return { severity, file: 'src/a.ts', line: 1, body: 'issue', suggestion: null, rule_id: null };
}

describe('computeScore', () => {
  it('returns a perfect 5 when there are no findings', () => {
    expect(computeScore([])).toBe(5);
  });

  it('subtracts the absolute severity weight per finding', () => {
    // 1 HIGH (1.25) + 2 LOW (0.1 + 0.1) → 5 - 1.45 = 3.55 (doc example)
    expect(
      computeScore([finding('HIGH'), finding('LOW'), finding('LOW')])
    ).toBe(3.55);
    expect(computeScore([finding('HIGH')])).toBe(3.75);
    expect(computeScore([finding('LOW')])).toBe(4.9);
    expect(computeScore([finding('MEDIUM')])).toBe(4.5);
    expect(computeScore([finding('CRITICAL')])).toBe(2.5);
  });

  it('clamps the score at 0 regardless of how many severe findings', () => {
    expect(computeScore([finding('CRITICAL'), finding('CRITICAL')])).toBe(0);
    expect(computeScore(Array(10).fill(finding('CRITICAL')))).toBe(0);
  });

  it('never exceeds 5', () => {
    expect(computeScore([finding('LOW')])).toBeLessThanOrEqual(5);
  });
});

describe('displayScore', () => {
  it('rounds raw scores to the nearest 0.5', () => {
    expect(displayScore(3.55)).toBe(3.5);
    expect(displayScore(4.26)).toBe(4.5);
    expect(displayScore(4.74)).toBe(4.5);
    expect(displayScore(4.75)).toBe(5.0);
    expect(displayScore(5)).toBe(5);
    expect(displayScore(0)).toBe(0);
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
