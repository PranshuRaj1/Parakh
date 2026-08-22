import { describe, expect, it } from 'vitest';
import {
  matchesScope,
  parseDiffByFile,
  parseRetentionDays,
  selectDisplayedReviewScore,
  formatIncompleteReviewComment,
  isIgnoredLockfile,
  suppressFindings,
  extractSuppressionPatterns,
} from './review.js';
import { MAX_FILES_PER_BATCH, type Finding, type Rule } from '@parakh/shared';

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

  it('drops the fabricated-claim families identified in the quality diagnosis', () => {
    const result = suppressFindings([
      finding('MEDIUM', { body: 'fullRepo is not used anywhere in the function' }),
      finding('MEDIUM', { body: 'postAnchoredFindings used without validation' }),
      finding('LOW', { body: 'name could be more descriptive' }),
      finding('MEDIUM', { body: 'classifyIntent changed return type — ensure all call sites are updated' }),
      finding('MEDIUM', { body: 'FailureDetail lacks a canManage prop' }),
      finding('MEDIUM', { body: 'consider extracting a function here' }),
      finding('LOW', { body: 'add a comment explaining MAX_REPLY_DEPTH' }),
      finding('MEDIUM', { body: 'Import of CommentAnalysis not checked against any rule' }),
    ], []);

    expect(result).toHaveLength(0);
  });

  it('suppresses rule-sourced findings identically to generic ones', () => {
    const ruleViolation = finding('MEDIUM', {
      body: 'this value is used without validation',
      rule_id: 'rule-9',
    });

    const result = suppressFindings([ruleViolation], []);

    expect(result).toHaveLength(0);
  });

  it('does not over-suppress real correctness findings', () => {
    const result = suppressFindings([
      finding('HIGH', { body: 'missing auth check on the admin route' }),
      finding('MEDIUM', { body: 'unhandled promise rejection in fetchUser' }),
      finding('LOW', { body: 'the timezone constant defaults to UTC' }),
    ], []);

    expect(result).toHaveLength(3);
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
    expect(patterns.some((re) => re.test('X'))).toBe(false);
    expect(patterns.some((re) => re.test('abc'))).toBe(false);
    // Still contains the built-in patterns.
    expect(patterns.some((re) => re.test('No newline at the end of the file'))).toBe(true);
  });
});

describe('review comment score selection', () => {
  it('retains the previous score only when an incremental range has no commits', () => {
    expect(selectDisplayedReviewScore(2.2, true, 4.5)).toBe(4.5);
    expect(selectDisplayedReviewScore(2.2, false, 4.5)).toBe(2.2);
    expect(selectDisplayedReviewScore(2.2, true, null)).toBe(2.2);
  });

  it('does not match a b slash sequence inside the old path', () => {
    const diff = [
      'diff --git a/worker/src/github/api.ts b/worker/src/github/api.ts',
      '--- a/worker/src/github/api.ts',
      '+++ b/worker/src/github/api.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(Array.from(parseDiffByFile(diff).keys())).toEqual(['worker/src/github/api.ts']);
  });

  it('parses spaces, unicode, renames, and literal b slash path segments', () => {
    const diff = [
      'diff --git a/src/old name.ts b/src/new name.ts',
      'similarity index 90%',
      'rename from src/old name.ts',
      'rename to src/new name.ts',
      'diff --git a/src/नमस्ते.ts b/src/नमस्ते.ts',
      '--- a/src/नमस्ते.ts',
      '+++ b/src/नमस्ते.ts',
      'diff --git a/a b/odd.ts b/a b/odd.ts',
      'Binary files a/a b/odd.ts and b/a b/odd.ts differ',
    ].join('\n');
    expect(Array.from(parseDiffByFile(diff).keys())).toEqual([
      'src/new name.ts',
      'src/नमस्ते.ts',
      'a b/odd.ts',
    ]);
  });
});

describe('formatIncompleteReviewComment', () => {
  it('never claims a clean score and only publishes critical and high findings', () => {
    const comment = formatIncompleteReviewComment([
      finding('CRITICAL', { body: 'critical issue' }),
      finding('HIGH', { body: 'high issue' }),
      finding('MEDIUM', { body: 'medium issue' }),
      finding('LOW', { body: 'low issue' }),
    ], 5, 7, ['src/b.ts', 'src/c.ts'], null);
    expect(comment).toContain('Incomplete - No Score');
    expect(comment).toContain('5 of 7');
    expect(comment).toContain('critical issue');
    expect(comment).toContain('high issue');
    expect(comment).not.toContain('medium issue');
    expect(comment).not.toContain('low issue');
    expect(comment).not.toContain('Clean code');
  });

  it('labels an incremental score as provisional', () => {
    const comment = formatIncompleteReviewComment([], 3, 4, ['src/a.ts'], 3.5);
    expect(comment).toContain('Provisional ledger score:** 3.5/5');
    expect(comment).toContain('not a completed review score');
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

describe('review delivery batching', () => {
  it('splits six files into three two-file deliveries without duplication', () => {
    const remaining = ['a', 'b', 'c', 'd', 'e', 'f'];
    const deliveries: string[][] = [];
    while (remaining.length > 0) deliveries.push(remaining.splice(0, MAX_FILES_PER_BATCH));

    expect(deliveries).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(new Set(deliveries.flat()).size).toBe(6);
  });
});
