import { describe, expect, it } from 'vitest';
import type { LedgerFinding } from './incremental/ledger.js';
import {
  buildAttentionFocus,
  sanitizeFocusText,
  ATTENTION_FOCUS_MAX_CHARS,
} from './attention-focus.js';

const prior = (file: string, count: number): LedgerFinding[] =>
  Array.from({ length: count }, (_, index) => ({
    severity: 'MEDIUM',
    file,
    line: index + 1,
    body: `prior finding ${index + 1} in ${file}`,
    suggestion: null,
    rule_id: null,
    finding_id: `${file}-${index}`,
    first_seen_head_sha: 'sha-a',
    last_validated_head_sha: 'sha-a',
  })) as LedgerFinding[];

describe('sanitizeFocusText', () => {
  it('strips markdown, URLs, and collapses whitespace cleanly', () => {
    expect(sanitizeFocusText('See [link](https://example.com) and `x` and `y`', 1000)).toBe(
      'See link and x and y'
    );
  });

  it('removes spaces before punctuation left by stripped markup', () => {
    expect(sanitizeFocusText('runs `early`.\n\nSecond paragraph.', 1000)).toBe(
      'runs early. Second paragraph.'
    );
  });

  it('bounds output and cuts at a word boundary', () => {
    const text = sanitizeFocusText('a '.repeat(500), 100);
    expect(text.length).toBeLessThanOrEqual(100);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('buildAttentionFocus', () => {
  it('anchors changed files that previously carried findings, with counts', () => {
    const focus = buildAttentionFocus({
      priorFindingsByFile: new Map([
        ['src/auth.ts', prior('src/auth.ts', 2)],
        ['src/other.ts', prior('src/other.ts', 1)],
      ]),
      deltaFiles: ['src/auth.ts', 'src/new.ts'],
    });
    expect(focus).toContain('3 unresolved finding');
    expect(focus).toContain('src/auth.ts (2 prior finding');
    expect(focus).not.toContain('src/other.ts');
    expect(focus).not.toContain('src/new.ts (');
  });

  it('notes when no changed file previously carried findings', () => {
    const focus = buildAttentionFocus({
      priorFindingsByFile: new Map([['src/other.ts', prior('src/other.ts', 3)]]),
      deltaFiles: ['src/auth.ts'],
    });
    expect(focus).toContain('3 unresolved finding');
    expect(focus).toContain('none in the files this delta changes');
  });

  it('falls back to the raw PR summary when no prior findings exist', () => {
    const focus = buildAttentionFocus({
      priorFindingsByFile: new Map(),
      deltaFiles: ['src/auth.ts'],
      prTitle: 'Fix auth timeout',
      prBody: 'The token check [never](https://example.com) runs `early`.\n\nSecond paragraph.',
    });
    expect(focus).toContain('PR intent: Fix auth timeout');
    expect(focus).toContain('PR description: The token check never runs early. Second paragraph.');
  });

  it('returns null when no prior findings and no PR summary exist', () => {
    expect(buildAttentionFocus({ priorFindingsByFile: new Map(), deltaFiles: ['a.ts'] })).toBeNull();
  });

  it('handles prior findings without a PR summary', () => {
    const focus = buildAttentionFocus({
      priorFindingsByFile: new Map([['a.ts', prior('a.ts', 1)]]),
      deltaFiles: ['a.ts'],
    });
    expect(focus).toContain('a.ts');
    expect(focus!.length).toBeLessThanOrEqual(ATTENTION_FOCUS_MAX_CHARS);
  });
});