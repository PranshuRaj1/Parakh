import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { loadFixtureCorpus } from './fixture-cases.test-helper.js';
import { replayCurrentFixture } from './replay-current.test-helper.js';
import {
  EXPECTED_BASELINE_PATH,
  generateCurrentBaselines,
} from './generate-baseline.js';

describe('current review baseline', () => {
  it('matches the reviewed, mechanically generated golden file', async () => {
    const expected = (await readFile(EXPECTED_BASELINE_PATH, 'utf8')).replace(/\r\n/g, '\n');
    expect(await generateCurrentBaselines()).toBe(expected);
  });

  it('replays every fixture deterministically without network access', async () => {
    const networkAttempt = vi.fn(() => {
      throw new Error('Offline baseline attempted network access');
    });
    vi.stubGlobal('fetch', networkAttempt);

    for (const fixture of await loadFixtureCorpus()) {
      const first = replayCurrentFixture(fixture);
      const second = replayCurrentFixture(fixture);

      expect(second, fixture.id).toEqual(first);
      expect(first.metrics.diffHash, fixture.id).toBe(fixture.resumeValidationHash);
      expect(first.calls.map((call) => call.file), fixture.id).toEqual(
        fixture.expectedInvariants.reviewableFiles
      );
      for (const call of first.calls) {
        expect(call.diff.length, `${fixture.id}:${call.file}`).toBeGreaterThan(0);
      }
    }

    expect(networkAttempt).not.toHaveBeenCalled();
  });

  it('keeps review output identical when inert feature snapshots change', async () => {
    for (const fixture of await loadFixtureCorpus()) {
      const defaults = replayCurrentFixture(fixture);
      const futureFlags = replayCurrentFixture(fixture, {
        semanticDiff: true,
        behaviorGrouping: true,
        behaviorGroupingShadow: true,
        groupedReviewOutput: true,
        stalenessCheck: true,
        deterministicAnalysis: true,
      });

      expect(futureFlags.calls, fixture.id).toEqual(defaults.calls);
      expect(futureFlags.findings, fixture.id).toEqual(defaults.findings);
      expect(futureFlags.rawScore, fixture.id).toBe(defaults.rawScore);
      expect(futureFlags.displayedScore, fixture.id).toBe(defaults.displayedScore);
      expect(futureFlags.comment, fixture.id).toBe(defaults.comment);
      expect(futureFlags.metrics.flags, fixture.id).not.toEqual(defaults.metrics.flags);
    }
  });
});
