import { describe, expect, it } from 'vitest';
import type { Finding } from '@parakh/shared';
import { capCosmeticSeverity, isCosmeticFinding } from './finding-quality.js';

function finding(severity: Finding['severity'], overrides: Partial<Finding> = {}): Finding {
  return {
    severity,
    file: 'src/a.ts',
    line: 3,
    body: 'some issue',
    suggestion: null,
    rule_id: null,
    ...overrides,
  };
}

describe('isCosmeticFinding', () => {
  it('recognizes the cosmetic families from the PR #25 diagnosis', () => {
    expect(isCosmeticFinding('Consider extracting a function here')).toBe(true);
    expect(isCosmeticFinding('add a comment explaining MAX_REPLY_DEPTH')).toBe(true);
    expect(isCosmeticFinding('consider renaming this variable')).toBe(true);
    expect(isCosmeticFinding('this comment could be more descriptive')).toBe(true);
    expect(isCosmeticFinding('add documentation for the retry logic')).toBe(true);
  });

  it('leaves non-cosmetic bodies alone', () => {
    expect(isCosmeticFinding('missing auth check on the admin route')).toBe(false);
    expect(isCosmeticFinding('unhandled promise rejection in fetchUser')).toBe(false);
    expect(isCosmeticFinding('the timeout is applied globally, not per request')).toBe(false);
  });
});

describe('capCosmeticSeverity', () => {
  it('caps cosmetic MEDIUM findings to LOW', () => {
    const { findings, demoted } = capCosmeticSeverity([
      finding('MEDIUM', { body: 'Consider extracting a function here' }),
      finding('MEDIUM', { body: 'add a comment explaining MAX_REPLY_DEPTH' }),
    ]);

    expect(demoted).toBe(2);
    expect(findings.every((f) => f.severity === 'LOW')).toBe(true);
  });

  it('never touches rule-sourced findings (deterministic severity by construction)', () => {
    const { findings, demoted } = capCosmeticSeverity([
      finding('MEDIUM', { body: 'consider extracting a function', rule_id: 'rule-9' }),
    ]);

    expect(demoted).toBe(0);
    expect(findings[0].severity).toBe('MEDIUM');
  });

  it('leaves genuine HIGH/CRITICAL and non-cosmetic findings untouched', () => {
    const input = [
      finding('HIGH', { body: 'missing auth check' }),
      finding('CRITICAL', { body: 'data loss on the happy path' }),
      finding('MEDIUM', { body: 'unhandled promise rejection in fetchUser' }),
    ];
    const { findings, demoted } = capCosmeticSeverity(input);

    expect(demoted).toBe(0);
    expect(findings.map((f) => f.severity)).toEqual(['HIGH', 'CRITICAL', 'MEDIUM']);
  });

  it('does not demote LOW findings (no churn)', () => {
    const { findings, demoted } = capCosmeticSeverity([
      finding('LOW', { body: 'consider extracting a function' }),
    ]);

    expect(demoted).toBe(0);
    expect(findings[0].severity).toBe('LOW');
  });
});