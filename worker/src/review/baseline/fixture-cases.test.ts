import { describe, expect, it } from 'vitest';
import { isIgnoredLockfile, parseDiffByFile } from '../../jobs/review.js';
import {
  buildLargeGeneratedDiff,
  FIXTURE_CASES,
  loadFixtureCorpus,
} from './fixture-cases.test-helper.js';

describe('offline diff fixture corpus', () => {
  it('contains every fixture once and loads them in stable order', async () => {
    const fixtures = await loadFixtureCorpus();
    const ids = fixtures.map((fixture) => fixture.id);

    expect(fixtures).toHaveLength(19);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(FIXTURE_CASES.every((fixture) => !fixture.content.includes('\r\n'))).toBe(true);
    for (const fixture of fixtures) {
      expect(fixture.resumeValidationHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('matches the captured parser invariants for every fixture', async () => {
    for (const fixture of await loadFixtureCorpus()) {
      const parsedFiles = Array.from(parseDiffByFile(fixture.content).keys());
      const ignoredFiles = parsedFiles.filter(isIgnoredLockfile);
      const reviewableFiles = parsedFiles.filter((file) => !isIgnoredLockfile(file));

      expect(parsedFiles, fixture.id).toEqual(fixture.expectedInvariants.parsedFiles);
      expect(ignoredFiles, fixture.id).toEqual(fixture.expectedInvariants.ignoredFiles);
      expect(reviewableFiles, fixture.id).toEqual(fixture.expectedInvariants.reviewableFiles);
      expect(reviewableFiles.length, fixture.id).toBe(fixture.expectedInvariants.logicalReviewCalls);
    }
  });

  it('preserves syntax-sensitive diff text', () => {
    const fixtures = new Map(FIXTURE_CASES.map((fixture) => [fixture.id, fixture.content]));

    expect(fixtures.get('no-newline-marker')).toContain('\\ No newline at end of file\n+export');
    expect(fixtures.get('malformed-hunk')).toContain('@@ -1,4 +1,4 @@\n-export');
    expect(fixtures.get('mode-only-change')).toBe(
      'diff --git a/scripts/deploy.sh b/scripts/deploy.sh\nold mode 100644\nnew mode 100755\n'
    );
  });

  it('generates the large fixture deterministically and includes the final line', () => {
    const first = buildLargeGeneratedDiff(25);
    const second = buildLargeGeneratedDiff(25);

    expect(first).toBe(second);
    expect(first).toContain('@@ -0,0 +1,25 @@');
    expect(first).toContain('+export const generated_24 = 24;');
  });
});
