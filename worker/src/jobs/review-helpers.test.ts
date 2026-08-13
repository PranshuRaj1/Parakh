import { describe, expect, it } from 'vitest';
import {
  matchesScope,
  parseDiffByFile,
  formatReviewComment,
  appendDashboardLink,
  parseRetentionDays,
  selectDisplayedReviewScore,
  formatIncompleteReviewComment,
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

  it('labels an incremental review and reports its complete snapshot', () => {
    const comment = formatReviewComment(3.5, 3.5, [finding('HIGH')], 'acme/app', 7, undefined, {
      mode: 'incremental',
      rangeStartSha: '1111111abcdef',
      rangeEndSha: '2222222abcdef',
      newFindingCount: 1,
      existingUnresolvedCount: 2,
      resolvedCount: 3,
      fallbackReason: null,
      noChangesSinceParent: false,
    });
    expect(comment).toContain('Parakh Incremental Review — 3.5/5');
    expect(comment).toContain('`1111111` → `2222222`');
    expect(comment).toContain('1 new · 2 existing unresolved · 3 resolved');
    expect(comment).toContain('Complete PR score');
  });

  it('explains full-review fallback and an unchanged incremental range', () => {
    const fallback = formatReviewComment(5, 5, [], 'acme/app', 7, undefined, {
      mode: 'full',
      rangeStartSha: 'aaaaaaa111',
      rangeEndSha: 'bbbbbbb222',
      newFindingCount: 0,
      existingUnresolvedCount: 0,
      resolvedCount: 0,
      fallbackReason: 'rules_changed',
      noChangesSinceParent: false,
    });
    expect(fallback).toContain('Parakh Full Review');
    expect(fallback).toContain('Fallback:** rules changed');

    const unchanged = formatReviewComment(5, 5, [], 'acme/app', 7, undefined, {
      mode: 'incremental',
      rangeStartSha: 'ccccccc111',
      rangeEndSha: 'ccccccc111',
      newFindingCount: 0,
      existingUnresolvedCount: 0,
      resolvedCount: 0,
      fallbackReason: null,
      noChangesSinceParent: true,
    });
    expect(unchanged).toContain('No commits were added');
    expect(unchanged).toContain('No model calls were made');
    expect(unchanged).toContain('previous score was retained');
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
