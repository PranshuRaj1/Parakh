import { describe, expect, it } from 'vitest';
import type { Finding } from '@parakh/shared';
import {
  extractIdentifierClaims,
  extractReferencedIdentifiers,
  verifyFinding,
  verifyFindings,
} from './finding-verification.js';

const content = [
  'export function authenticate(token: string) {',
  '  if (!token) throw new Error("missing token");',
  '  return { canManage: true };',
  '}',
  '',
].join('\n');

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'HIGH',
    file: 'src/auth.ts',
    line: 2,
    body: 'auth is missing an early return',
    suggestion: null,
    rule_id: null,
    ...overrides,
  };
}

describe('extractReferencedIdentifiers', () => {
  it('extracts backtick-quoted identifiers', () => {
    expect(extractReferencedIdentifiers('`canManage` is never set here')).toEqual(['canManage']);
  });

  it('ignores backticked phrases with spaces (prose, not symbols)', () => {
    expect(extractReferencedIdentifiers('`the whole flow` is broken')).toEqual([]);
  });

  it('extracts identifiers after "lacks a" and "X prop is missing" patterns', () => {
    expect(
      extractIdentifierClaims('FailureDetail lacks a canManage prop').absenceClaims
    ).toEqual(['canManage']);
    expect(extractIdentifierClaims('the token prop is not declared').absenceClaims).toEqual([
      'token',
    ]);
  });
});

describe('verifyFinding', () => {
  it('keeps findings unmodified when no reference content is available', () => {
    const original = finding();
    const outcome = verifyFinding(original, null, 'src/auth.ts');
    expect(outcome.status).toBe('unverified');
    expect(outcome.reason).toBe('no_reference_content');
    expect(outcome.finding).toBe(original);
  });

  it('marks findings for a different file as contradicted', () => {
    expect(verifyFinding(finding(), content, 'src/other.ts').status).toBe('contradicted');
  });

  it('marks out-of-range line citations as contradicted', () => {
    const outcome = verifyFinding(finding({ line: 999 }), content, 'src/auth.ts');
    expect(outcome.status).toBe('contradicted');
    expect(outcome.reason).toBe('line_out_of_range');
  });

  it('marks absent referenced identifiers as contradicted', () => {
    const outcome = verifyFinding(
      finding({ body: '`shouldRetry` is never assigned anywhere' }),
      content,
      'src/auth.ts'
    );
    expect(outcome.status).toBe('contradicted');
    expect(outcome.reason).toContain('shouldRetry');
  });

  it('verifies findings whose cited lines and identifiers are present', () => {
    const outcome = verifyFinding(
      finding({ body: 'token check happens after `authenticate` is called' }),
      content,
      'src/auth.ts'
    );
    expect(outcome.status).toBe('verified');
    expect(outcome.reason).toBe('cited_lines_present');
  });

  it('verifies a missing-prop claim when the prop is truly absent', () => {
    const outcome = verifyFinding(
      finding({ body: 'FailureDetail lacks a shouldRetry prop' }),
      content,
      'src/auth.ts'
    );
    expect(outcome.status).toBe('verified');
  });

  it('contradicts a missing-prop claim when the prop is actually present', () => {
    const outcome = verifyFinding(
      finding({ body: 'FailureDetail lacks a token prop' }),
      content,
      'src/auth.ts'
    );
    expect(outcome.status).toBe('contradicted');
    expect(outcome.reason).toContain('token');
  });
});

describe('verifyFindings', () => {
  it('keeps verified and unverifiable findings, drops contradicted ones', () => {
    const findings = [
      finding({ body: '`authenticate` should early-return' }),
      finding({ body: '`shouldRetry` is never assigned anywhere' }),
      finding({ body: 'the handler never runs on that path' }),
    ];
    const outcome = verifyFindings(findings, content, 'src/auth.ts');
    expect(outcome.verified).toHaveLength(2);
    expect(outcome.unverifiedCount).toBe(0);
    expect(outcome.contradictedCount).toBe(1);
  });
});
