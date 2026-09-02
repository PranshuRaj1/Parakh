import { describe, expect, it } from 'vitest';
import {
  buildCorpusFromMartian,
  filterToRelevantCategories,
  loadMartianFile,
  summarizeImport,
} from './martian-importer.js';
import type { MartianPr } from './martian-importer.js';

const samplePrs: MartianPr[] = [
  {
    pr_title: 'Fix race condition in worker pool',
    url: 'https://github.com/getsentry/sentry/pull/93824',
    comments: [
      {
        comment: 'This lock acquisition can deadlock if the worker is interrupted.',
        severity: 'High',
        category: 'concurrency',
      },
      {
        comment: 'The test uses monkeypatched sleep incorrectly.',
        severity: 'Low',
        category: 'test_gap',
      },
    ],
  },
  {
    pr_title: 'Clean refactor of utils',
    url: 'https://github.com/grafana/grafana/pull/100000',
    comments: [
      {
        comment: 'Rename foo to bar for clarity.',
        severity: 'Low',
        category: 'style',
      },
    ],
  },
  {
    pr_title: 'Add feature without bugs',
    url: 'https://github.com/calcom/cal.com/pull/5000',
    comments: [],
  },
];

describe('filterToRelevantCategories', () => {
  it('keeps bug, security, concurrency, data, api categories', () => {
    const result = filterToRelevantCategories(samplePrs);
    expect(result.prs[0].comments).toHaveLength(1);
    expect(result.prs[0].comments[0].category).toBe('concurrency');
  });

  it('removes test_gap and style categories', () => {
    const result = filterToRelevantCategories(samplePrs);
    expect(result.prs[1].comments).toHaveLength(0);
  });

  it('preserves empty PRs', () => {
    const result = filterToRelevantCategories(samplePrs);
    expect(result.prs[2].comments).toHaveLength(0);
  });

  it('reports filtered count', () => {
    const result = filterToRelevantCategories(samplePrs);
    expect(result.filteredComments).toBe(2);
    expect(result.totalComments).toBe(3);
  });

  it('reports skipped categories', () => {
    const result = filterToRelevantCategories(samplePrs);
    expect(result.skippedCategories).toContain('test_gap');
    expect(result.skippedCategories).toContain('style');
  });
});

describe('buildCorpusFromMartian', () => {
  it('builds cases and defects from Martian PRs', async () => {
    const filtered = filterToRelevantCategories(samplePrs);
    const corpus = await buildCorpusFromMartian(
      filtered.prs,
      'martian-test-v1'
    );

    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.goldSetVersion).toBe('martian-test-v1');
    expect(corpus.cases).toHaveLength(3);
    expect(corpus.defects).toHaveLength(1);
  });

  it('marks PRs with zero relevant comments as negative controls', async () => {
    const filtered = filterToRelevantCategories(samplePrs);
    const corpus = await buildCorpusFromMartian(
      filtered.prs,
      'martian-test-v1'
    );

    const cleanPR = corpus.cases.find((c) =>
      c.id.includes('cal.com')
    );
    expect(cleanPR).toBeDefined();
    expect(cleanPR!.isNegativeControl).toBe(true);

    const stylePR = corpus.cases.find((c) =>
      c.id.includes('grafana')
    );
    expect(stylePR).toBeDefined();
    expect(stylePR!.isNegativeControl).toBe(true);
  });

  it('generates unique case and defect IDs', async () => {
    const filtered = filterToRelevantCategories(samplePrs);
    const corpus = await buildCorpusFromMartian(
      filtered.prs,
      'martian-test-v1'
    );

    const caseIds = corpus.cases.map((c) => c.id);
    const uniqueCaseIds = new Set(caseIds);
    expect(uniqueCaseIds.size).toBe(caseIds.length);

    const defectIds = corpus.defects.map((d) => d.id);
    const uniqueDefectIds = new Set(defectIds);
    expect(uniqueDefectIds.size).toBe(defectIds.length);
  });

  it('maps severity correctly', async () => {
    const filtered = filterToRelevantCategories(samplePrs);
    const corpus = await buildCorpusFromMartian(
      filtered.prs,
      'martian-test-v1'
    );

    expect(corpus.defects[0].severity).toBe('HIGH');
  });

  it('fills placeholder SHAs when no snapshot fetcher provided', async () => {
    const filtered = filterToRelevantCategories(samplePrs);
    const corpus = await buildCorpusFromMartian(
      filtered.prs,
      'martian-test-v1'
    );

    const sentryCase = corpus.cases.find((c) =>
      c.id.includes('sentry')
    );
    expect(sentryCase).toBeDefined();
    expect(sentryCase!.baseSha).toContain('pending-');
    expect(sentryCase!.headSha).toContain('pending-');
    expect(sentryCase!.diff).toBe('');
  });

  it('uses snapshot fetcher when provided', async () => {
    const filtered = filterToRelevantCategories(samplePrs);
    const corpus = await buildCorpusFromMartian(
      filtered.prs,
      'martian-test-v1',
      async () => ({
        baseSha: 'aaa111'.repeat(7),
        headSha: 'bbb222'.repeat(7),
        diff: 'diff --git a/foo b/foo',
        files: { 'foo.ts': 'content' },
      })
    );

    const sentryCase = corpus.cases.find((c) =>
      c.id.includes('sentry')
    );
    expect(sentryCase).toBeDefined();
    expect(sentryCase!.baseSha).toBe('aaa111'.repeat(7));
    expect(sentryCase!.diff).toBe('diff --git a/foo b/foo');
    expect(sentryCase!.files['foo.ts']).toBe('content');
  });

  it('handles original_url for forked repos', async () => {
    const forkedPrs: MartianPr[] = [{
      pr_title: 'Fix pagination',
      url: 'https://github.com/ai-code-review-evaluation/sentry-greptile/pull/1',
      original_url: 'https://github.com/getsentry/sentry/pull/92393',
      comments: [{
        comment: 'Negative offset bug.',
        severity: 'Critical',
        category: 'bug',
      }],
    }];

    const corpus = await buildCorpusFromMartian(
      forkedPrs,
      'martian-test-v1'
    );

    expect(corpus.cases[0].repo).toBe('getsentry/sentry');
    expect(corpus.cases[0].id).toContain('92393');
  });
});

describe('summarizeImport', () => {
  it('produces readable summary', () => {
    const result = filterToRelevantCategories(samplePrs);
    const summary = summarizeImport(result);
    expect(summary).toContain('PRs: 3');
    expect(summary).toContain('Total comments: 3');
    expect(summary).toContain('Relevant comments (kept): 1');
  });
});
