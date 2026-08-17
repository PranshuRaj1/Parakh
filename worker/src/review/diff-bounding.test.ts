import { describe, expect, it } from 'vitest';
import { boundDiff, REVIEW_DIFF_MAX_CHARS } from './diff-bounding.js';

const diff = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  '-const a = 1;',
  '+const a = 2;',
].join('\n');

describe('boundDiff', () => {
  it('passes small diffs through untouched', () => {
    expect(boundDiff(diff)).toEqual({ diff, truncated: false });
  });

  it('truncates oversized diffs at a line boundary and marks them', () => {
    const oversized = `${diff}\n${'line\n'.repeat(100)}`;
    const result = boundDiff(oversized, 80);
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('DIFF_TRUNCATED:');
    expect(result.diff.length).toBeLessThan(oversized.length);
    expect(result.diff.endsWith('---\nDIFF_TRUNCATED')).toBe(false);
  });

  it('guarantees the marker is present even for tiny caps', () => {
    const result = boundDiff(diff, 5);
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('DIFF_TRUNCATED');
  });

  it('never returns a truncated diff longer than the cap plus marker', () => {
    const oversized = `${diff}\n${'line\n'.repeat(1000)}`;
    const result = boundDiff(oversized, 100);
    expect(result.diff.length).toBeLessThanOrEqual(100 + 220);
    expect(result.diff.length).toBeLessThan(REVIEW_DIFF_MAX_CHARS);
  });
});