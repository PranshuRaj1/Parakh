/** Generate the mechanically derived baseline candidate for human review. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtureCorpus } from './fixture-cases.test-helper.js';
import { replayCurrentFixture } from './replay-current.test-helper.js';

export const EXPECTED_BASELINE_PATH = fileURLToPath(
  new URL('./expected/current-baselines.json', import.meta.url)
);

export async function generateCurrentBaselines(): Promise<string> {
  const fixtures = await loadFixtureCorpus();
  const generated = {
    schemaVersion: 1,
    description: 'Mechanically generated current file-review behavior. Review diffs before accepting.',
    // Raw fixture patches already live in the corpus. Store call targets here,
    // not another copy of every patch (especially the generated 1,000-line
    // case), so the golden stays compact and human-reviewable.
    fixtures: fixtures.map((fixture) => {
      const result = replayCurrentFixture(fixture);
      return {
        fixtureId: result.fixtureId,
        metrics: result.metrics,
        callFiles: result.calls.map((call) => call.file),
        findings: result.findings,
        rawScore: result.rawScore,
        displayedScore: result.displayedScore,
        comment: result.comment,
      };
    }),
  };
  return `${JSON.stringify(generated, null, 2)}\n`;
}

async function main(): Promise<void> {
  const output = await generateCurrentBaselines();
  if (process.argv.includes('--accept')) {
    await mkdir(path.dirname(EXPECTED_BASELINE_PATH), { recursive: true });
    await writeFile(EXPECTED_BASELINE_PATH, output, 'utf8');
    console.log(`Accepted baseline: ${EXPECTED_BASELINE_PATH}`);
    return;
  }
  process.stdout.write(output);
}

// Importing this module in tests exposes the generator without writing files.
if (process.argv.some((argument) => argument.replace(/\\/g, '/').endsWith('/generate-baseline.ts'))) {
  await main();
}
