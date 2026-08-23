import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FileAnalysis } from '@parakh/shared';
import {
  OVERVIEW_MARKER,
  deterministicPrOverview,
  fallbackFileOverview,
  formatOverviewComment,
  formatPriority,
  sanitizeOverview,
  upsertOverviewComment,
} from './overview.js';

vi.mock('../github/api.js', () => ({
  findIssueCommentByMarker: vi.fn(),
  postComment: vi.fn(),
  updateIssueComment: vi.fn(),
}));

vi.mock('../db/reviews.js', () => ({
  getLatestOverviewCommentId: vi.fn(),
  setReviewOverviewCommentId: vi.fn(),
}));

import {
  findIssueCommentByMarker,
  postComment,
  updateIssueComment,
} from '../github/api.js';
import {
  getLatestOverviewCommentId,
  setReviewOverviewCommentId,
} from '../db/reviews.js';

const mocked = {
  findIssueCommentByMarker: vi.mocked(findIssueCommentByMarker),
  postComment: vi.mocked(postComment),
  updateIssueComment: vi.mocked(updateIssueComment),
  getLatestOverviewCommentId: vi.mocked(getLatestOverviewCommentId),
  setReviewOverviewCommentId: vi.mocked(setReviewOverviewCommentId),
};

const env = { DATABASE_URL: 'postgres://x' } as never;

function file(overrides: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    path: 'src/auth.ts',
    status: 'modified',
    additions: 42,
    deletions: 18,
    overview: 'Updates token validation and refresh handling.',
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocked)) fn.mockReset();
});

describe('formatPriority', () => {
  it('maps CRITICAL→P0, HIGH→P1, MEDIUM/LOW→P2', () => {
    expect(formatPriority('CRITICAL')).toContain('alt="P0"');
    expect(formatPriority('CRITICAL')).toContain('/p0.svg?v=7');
    expect(formatPriority('HIGH')).toContain('alt="P1"');
    expect(formatPriority('HIGH')).toContain('/p1.svg?v=7');
    expect(formatPriority('MEDIUM')).toContain('alt="P2"');
    expect(formatPriority('MEDIUM')).toContain('/p2.svg?v=7');
    expect(formatPriority('LOW')).toBe(formatPriority('MEDIUM'));
  });
});

describe('sanitizeOverview', () => {
  it('flattens whitespace and caps at 200 characters', () => {
    const sanitized = sanitizeOverview(`  Updates\n\ttoken  handling.  ${'x'.repeat(300)}`);
    expect(sanitized.length).toBe(200);
    expect(sanitized).not.toMatch(/[\n\t]/);
    expect(sanitizeOverview(null)).toBe('');
    expect(sanitizeOverview('   ')).toBe('');
  });
});

describe('fallbackFileOverview', () => {
  it('uses deterministic text for deleted, renamed, lockfile, and other files', () => {
    expect(fallbackFileOverview({ status: 'removed', filename: 'src/old.ts' })).toBe('Deletes this file.');
    expect(fallbackFileOverview({ status: 'renamed', filename: 'src/new.ts' })).toBe('Renames this file.');
    expect(fallbackFileOverview({ status: 'modified', filename: 'package-lock.json' })).toBe('Updates locked dependency metadata.');
    expect(fallbackFileOverview({ status: 'changed', filename: 'assets/logo.png' })).toBe('Updates this file.');
  });
});

describe('deterministicPrOverview', () => {
  it('summarizes counts and handles the empty PR', () => {
    expect(deterministicPrOverview([])).toBe('No file changes.');
    const summary = deterministicPrOverview([
      file({ additions: 10, deletions: 2 }),
      file({ additions: 5, deletions: 3 }),
    ]);
    expect(summary).toContain('2 files');
    expect(summary).toContain('adding 15');
    expect(summary).toContain('removing 5');
    expect(summary).toContain('Updates token validation and refresh handling.');
  });

  it('uses distinct file overviews to explain what the PR brings', () => {
    const summary = deterministicPrOverview([
      file({ overview: 'Adds repository convention loading.' }),
      file({ path: 'src/parser.ts', overview: 'Prioritizes project-specific rules.' }),
      file({ path: 'src/duplicate.ts', overview: 'Adds repository convention loading.' }),
      file({ path: 'src/other.ts', overview: 'Updates this file.' }),
    ]);
    expect(summary).toContain('Key changes: Adds repository convention loading. Prioritizes project-specific rules.');
    expect(summary.match(/Adds repository convention loading\./g)).toHaveLength(1);
    expect(summary).not.toContain('Updates this file.');
  });
});

describe('formatOverviewComment', () => {
  const base = {
    score: 3.8,
    prOverview: 'Updates authentication and review processing.',
    files: [
      file(),
      file({ path: 'src/review.ts', additions: 31, deletions: 9, overview: 'Changes review finalization.' }),
      file({ path: 'package-lock.json', additions: 8, deletions: 8, overview: 'Updates locked dependency metadata.' }),
    ],
    repo: 'acme/app',
    prNumber: 7,
  };

  it('puts score first, then Overview and Files Changed, in GitHub file order', () => {
    const body = formatOverviewComment(base);
    const scoreIdx = body.indexOf('Score: 3.8/5');
    const overviewIdx = body.indexOf('## Overview');
    const filesIdx = body.indexOf('## Files Changed');
    expect(scoreIdx).toBeGreaterThanOrEqual(0);
    expect(scoreIdx).toBeLessThan(overviewIdx);
    expect(overviewIdx).toBeLessThan(filesIdx);
    expect(body.indexOf('src/auth.ts')).toBeLessThan(body.indexOf('src/review.ts'));
    expect(body.indexOf('src/review.ts')).toBeLessThan(body.indexOf('package-lock.json'));
    expect(body).toContain('+42 / -18');
    // No finding bodies or severity-group sections leak into the overview.
    expect(body).not.toContain('CRITICAL');
    expect(body).not.toContain('###');
  });

  it('escapes Markdown-sensitive table content', () => {
    const body = formatOverviewComment({
      ...base,
      prOverview: 'Splits | pipes  and\nnewlines',
      files: [file({ path: 'src/a|b.ts' })],
    });
    expect(body).toContain('Splits \\| pipes and newlines');
    expect(body).toContain('`src/a\\|b.ts`');
  });

  it('keeps the dashboard link optional and trailing-slash safe', () => {
    expect(formatOverviewComment(base)).not.toContain('dashboard');
    const linked = formatOverviewComment({ ...base, dashboardBaseUrl: 'https://dash.example.com/' });
    expect(linked).toContain('https://dash.example.com/pulls/acme/app/7');
  });

  it('renders codebase impact after the complete files table', () => {
    const body = formatOverviewComment({
      ...base,
      codebaseImpact: {
        blastRadius: {
          level: 'low',
          changedSymbols: [],
          affectedSymbols: [],
          relatedTests: [],
          riskSignals: [],
          confidence: 'low',
        },
        reuseCandidates: [],
      },
    });
    expect(body.indexOf('package-lock.json')).toBeLessThan(body.indexOf('## Codebase Impact'));
  });

  it('stops at complete rows inside the body budget and flags the rest', () => {
    const bigFiles = Array.from({ length: 900 }, (_, i) =>
      file({ path: `src/file-${i}.ts`, overview: 'x'.repeat(80) })
    );
    const body = formatOverviewComment({ ...base, files: bigFiles });
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain('_Additional changed files are available on the dashboard');
    // Every included row is complete (no half-written row before the note).
    expect(body).toMatch(/\n\n_Additional changed files/);
  });

  it('keeps a large impact report within GitHub comment limits', () => {
    const symbol = { repo: 'acme/app', commitSha: 'head', path: `src/${'x'.repeat(150)}.ts`, qualifiedName: 'x'.repeat(150), kind: 'function' as const, startLine: 1, endLine: 2 };
    const body = formatOverviewComment({
      ...base,
      files: Array.from({ length: 900 }, (_, i) => file({ path: `src/file-${i}.ts`, overview: 'x'.repeat(80) })),
      codebaseImpact: {
        blastRadius: { level: 'high', changedSymbols: Array(500).fill(symbol), affectedSymbols: Array(500).fill(symbol), relatedTests: Array(500).fill(symbol), riskSignals: Array(500).fill('risk'), confidence: 'low' },
        reuseCandidates: [],
      },
    });
    expect(body.length).toBeLessThan(65_536);
  });
});

describe('upsertOverviewComment lifecycle', () => {
  beforeEach(() => {
    mocked.updateIssueComment.mockResolvedValue(undefined);
    mocked.setReviewOverviewCommentId.mockResolvedValue(undefined);
    mocked.postComment.mockResolvedValue({ id: 99 });
  });

  it('updates the stored comment ID in place and re-persists it', async () => {
    mocked.getLatestOverviewCommentId.mockResolvedValue(55);
    await upsertOverviewComment('acme', 'app', 7, 'review-1', 'body', 'token', env);
    expect(mocked.updateIssueComment).toHaveBeenCalledWith('acme', 'app', 55, `body\n\n${OVERVIEW_MARKER}`, 'token');
    expect(mocked.postComment).not.toHaveBeenCalled();
  });

  it('recovers via the stable marker when no stored ID exists', async () => {
    mocked.getLatestOverviewCommentId.mockResolvedValue(null);
    mocked.findIssueCommentByMarker.mockResolvedValue({ id: 77 });
    await upsertOverviewComment('acme', 'app', 7, 'review-1', 'body', 'token', env);
    expect(mocked.updateIssueComment).toHaveBeenCalledWith('acme', 'app', 77, expect.stringContaining(OVERVIEW_MARKER), 'token');
    expect(mocked.setReviewOverviewCommentId).toHaveBeenCalledWith('review-1', 77, env);
  });

  it('creates one comment when none exists yet', async () => {
    mocked.getLatestOverviewCommentId.mockResolvedValue(null);
    mocked.findIssueCommentByMarker.mockResolvedValue(null);
    await upsertOverviewComment('acme', 'app', 7, 'review-1', 'body', 'token', env);
    expect(mocked.postComment).toHaveBeenCalledWith('acme', 'app', 7, expect.stringContaining(OVERVIEW_MARKER), 'token');
    expect(mocked.setReviewOverviewCommentId).toHaveBeenCalledWith('review-1', 99, env);
  });

  it('replaces a deleted stored comment with exactly one replacement', async () => {
    mocked.getLatestOverviewCommentId.mockResolvedValue(55);
    mocked.updateIssueComment
      .mockRejectedValueOnce(new Error('GitHub API error (404)'))
      .mockResolvedValueOnce(undefined);
    mocked.findIssueCommentByMarker.mockResolvedValue(null);
    await upsertOverviewComment('acme', 'app', 7, 'review-1', 'body', 'token', env);
    expect(mocked.postComment).toHaveBeenCalledTimes(1);
    expect(mocked.setReviewOverviewCommentId).toHaveBeenLastCalledWith('review-1', 99, env);
  });

  it('redelivery keeps updating the same comment instead of duplicating', async () => {
    mocked.getLatestOverviewCommentId.mockResolvedValue(55);
    await upsertOverviewComment('acme', 'app', 7, 'review-2', 'body v2', 'token', env);
    expect(mocked.updateIssueComment).toHaveBeenCalledTimes(1);
    expect(mocked.updateIssueComment.mock.calls[0][2]).toBe(55);
    expect(mocked.postComment).not.toHaveBeenCalled();
  });
});
