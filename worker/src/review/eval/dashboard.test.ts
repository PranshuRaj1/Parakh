import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateEvalDashboard } from './dashboard.js';

describe('eval dashboard', () => {
  it('renders cached report comparisons', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parakh-eval-'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'report.json'), JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-09-04T00:00:00.000Z',
      oldPipeline: { resolvedSha: 'a'.repeat(40) },
      newPipeline: { resolvedSha: 'b'.repeat(40) },
      cases: [{
        caseId: 'case-1',
        assessment: 'better',
        comparison: {
          f1Delta: 0.2,
          oldMetrics: { knownPrecision: 0.2, providerCalls: 2 },
          newMetrics: { knownPrecision: 0.4, providerCalls: 3 },
        },
      }],
    }));
    const html = await generateEvalDashboard(directory);
    expect(html).toContain('case-1');
    expect(html).toContain('better');
    expect(html).toContain('0.200');
  });
});
