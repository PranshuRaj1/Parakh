import { describe, expect, it } from 'vitest';
import {
  matchesScope,
  parseDiffByFile,
  formatReviewComment,
  appendDashboardLink,
  parseRetentionDays,
  isIgnoredLockfile,
  suppressFindings,
  extractSuppressionPatterns,
} from './review.js';
import type { Finding, Rule } from '@parakh/shared';

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

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    repo: 'acme/app',
    body: 'some standard',
    embedding: null,
    status: 'ACTIVE',
    scope: {},
    priority: 'normal',
    supersedes: null,
    superseded_by: null,
    source_pr: null,
    evidence_count: 0,
    reinforcement_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    superseded_at: null,
    ...overrides,
  };
}

describe('matchesScope', () => {
  it('applies to every file when the scope has no include patterns', () => {
    expect(matchesScope('any/file.txt', {})).toBe(true);
    expect(matchesScope('any/file.txt', { include: [] })).toBe(true);
  });

  it('supports ** glob patterns (zero or more directories)', () => {
    const scope = { include: ['src/**/*.ts'] };
    expect(matchesScope('src/foo.ts', scope)).toBe(true); // zero directories
    expect(matchesScope('src/deep/bar.ts', scope)).toBe(true);
    expect(matchesScope('src/deep/nested/bar.ts', scope)).toBe(true);
    expect(matchesScope('src/foo.js', scope)).toBe(false);
    expect(matchesScope('lib/foo.ts', scope)).toBe(false);
  });

  it('treats a bare * as a single path segment (no slashes)', () => {
    const scope = { include: ['*.ts'] };
    expect(matchesScope('foo.ts', scope)).toBe(true);
    expect(matchesScope('src/foo.ts', scope)).toBe(false);
  });

  it('supports ? wildcards (exactly one char) and escapes literal dots', () => {
    expect(matchesScope('src/a1.ts', { include: ['src/a?.ts'] })).toBe(true);
    expect(matchesScope('src/a.ts', { include: ['src/a?.ts'] })).toBe(false); // zero chars
    expect(matchesScope('src/a12.ts', { include: ['src/a?.ts'] })).toBe(false); // two chars
    expect(matchesScope('src/index.ts', { include: ['src/index.ts'] })).toBe(true);
    expect(matchesScope('src/indexXts', { include: ['src/index.ts'] })).toBe(false);
  });

  it('matches when any pattern in the list matches', () => {
    const scope = { include: ['src/**/*.ts', 'docs/**'] };
    expect(matchesScope('docs/readme.md', scope)).toBe(true);
    expect(matchesScope('src/deep/app.ts', scope)).toBe(true);
    expect(matchesScope('tests/app.ts', scope)).toBe(false);
  });
});

describe('parseDiffByFile', () => {
  it('splits a unified diff into per-file chunks keyed by path', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old-a',
      '+new-a',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 333..444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old-b',
      '+new-b',
    ].join('\n');

    const files = parseDiffByFile(diff);
    expect(Array.from(files.keys())).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files.get('src/a.ts')).toContain('new-a');
    expect(files.get('src/b.ts')).toContain('new-b');
    expect(files.get('src/a.ts')).not.toContain('new-b');
  });

  it('returns an empty map for an empty diff', () => {
    expect(parseDiffByFile('').size).toBe(0);
  });
});

describe('isIgnoredLockfile', () => {
  it('matches lockfiles at the repo root', () => {
    expect(isIgnoredLockfile('package-lock.json')).toBe(true);
    expect(isIgnoredLockfile('yarn.lock')).toBe(true);
    expect(isIgnoredLockfile('pnpm-lock.yaml')).toBe(true);
  });

  it('matches lockfiles nested in subdirectories', () => {
    expect(isIgnoredLockfile('apps/web/package-lock.json')).toBe(true);
    expect(isIgnoredLockfile('packages/foo/yarn.lock')).toBe(true);
  });

  it('does not match regular source files', () => {
    expect(isIgnoredLockfile('src/cron.ts')).toBe(false);
    expect(isIgnoredLockfile('package.json')).toBe(false);
    expect(isIgnoredLockfile('docs/guide.md')).toBe(false);
  });
});

describe('suppressFindings', () => {
  it('drops EOF-newline findings via the built-in pattern, even with no instruction rules', () => {
    const result = suppressFindings([
      finding('LOW', { body: 'No newline at the end of the file' }),
      finding('MEDIUM', { body: 'unbounded loop' }),
    ], []);

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('unbounded loop');
  });

  it('drops findings matching a quoted phrase from an instruction rule', () => {
    const instruction = rule({
      kind: 'instruction',
      body: 'stop flagging "No newline at the end of the file" in any future review',
    });
    const result = suppressFindings([
      finding('LOW', { body: 'No newline at the end of the file' }),
      finding('MEDIUM', { body: 'real issue' }),
    ], [instruction]);

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('real issue');
  });

  it('keeps findings untouched when nothing is suppressed', () => {
    const result = suppressFindings([
      finding('HIGH', { body: 'missing auth check' }),
    ], []);

    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('missing auth check');
  });
});

describe('extractSuppressionPatterns', () => {
  it('always includes the built-in EOF-newline pattern', () => {
    expect(extractSuppressionPatterns([]).some((re) => re.test('No newline at the end of the file'))).toBe(true);
  });

  it('extracts quoted phrases from instruction rule bodies', () => {
    const patterns = extractSuppressionPatterns([
      rule({ kind: 'instruction', body: 'never raise "unbounded loops" in future reviews' }),
    ]);
    expect(patterns.some((re) => re.test('This introduces unbounded loops'))).toBe(true);
  });

  it('ignores quoted phrases shorter than 4 characters', () => {
    const patterns = extractSuppressionPatterns([
      rule({ kind: 'instruction', body: 'stop flagging "X" and "abc" forever' }),
    ]);
    expect(patterns.length).toBe(1); // only the built-in pattern
  });
});

describe('formatReviewComment', () => {
  it('reports clean code when there are no findings', () => {
    const comment = formatReviewComment(5, 5, [], 'acme/app', 7);
    expect(comment).toContain('Parakh Code Review — 5/5');
    expect(comment).toContain('No issues found. Clean code!');
  });

  it('groups findings by severity with emoji counts', () => {
    const comment = formatReviewComment(3.55, 3.5, [
      finding('HIGH'),
      finding('LOW'),
    ], 'acme/app', 7);
    expect(comment).toContain('🟠 1 HIGH');
    expect(comment).toContain('🔵 1 LOW');
  });

  it('renders rule-violation tags, suggestions, and severity order CRITICAL→LOW', () => {
    const comment = formatReviewComment(3, 3, [
      finding('LOW', { rule_id: 'rule-1' }),
      finding('CRITICAL', { file: 'src/secure.ts', line: 1, suggestion: 'validate input' }),
    ], 'acme/app', 7);

    const criticalIdx = comment.indexOf('🔴 CRITICAL');
    const lowIdx = comment.indexOf('🔵 LOW');
    expect(criticalIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(criticalIdx);

    expect(comment).toContain('*(rule violation)*');
    expect(comment).toContain('src/secure.ts:1');
    expect(comment).toContain('validate input');
  });
});

describe('appendDashboardLink', () => {
  it('leaves the comment untouched without a dashboard base URL', () => {
    expect(appendDashboardLink('hello', 'acme/app', 7)).toBe('hello');
  });

  it('appends a dashboard link with a trailing-slash-safe base URL', () => {
    const result = appendDashboardLink('hello', 'acme/app', 7, 'https://dash.example.com/');
    expect(result).toContain('https://dash.example.com/pulls/acme/app/7');
    expect(result).toContain('hello');
  });

  it('leaves the comment untouched for an unparseable repo', () => {
    expect(appendDashboardLink('hello', 'no-slash-here', 7, 'https://dash.example.com')).toBe('hello');
  });
});

describe('parseRetentionDays', () => {
  it('parses valid positive integers', () => {
    expect(parseRetentionDays('14')).toBe(14);
    expect(parseRetentionDays('30')).toBe(30);
  });

  it('falls back to the default for missing or invalid values', () => {
    expect(parseRetentionDays(undefined)).toBe(14);
    expect(parseRetentionDays('')).toBe(14);
    expect(parseRetentionDays('abc')).toBe(14);
    expect(parseRetentionDays('0')).toBe(14);
    expect(parseRetentionDays('-5')).toBe(14);
  });
});
