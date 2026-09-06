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
        oldNoiseFloor: {
          reviewerDisagreementRate: 0.1,
          precisionDelta: 0,
          recallDelta: 0,
          f1Delta: 0,
          falsePositiveDelta: 0,
        },
        newNoiseFloor: {
          reviewerDisagreementRate: 0.2,
          precisionDelta: 0,
          recallDelta: 0,
          f1Delta: 0,
          falsePositiveDelta: 0,
        },
        comparison: {
          f1Delta: 0.2,
          oldMetrics: { knownPrecision: 0.2, providerCalls: 2, latencyMs: 15000, inputTokens: 1000, outputTokens: 100, strictFalsePositives: 1, recall: 0.5 },
          newMetrics: { knownPrecision: 0.4, providerCalls: 3, latencyMs: 18000, inputTokens: 1000, outputTokens: 200, strictFalsePositives: 0, recall: 0.75 },
        },
      }],
    }));
    const html = await generateEvalDashboard(directory);
    expect(html).toContain('case-1');
    expect(html).toContain('better');
    expect(html).toContain('0.200');
    expect(html).toContain('2 / 3');
    expect(html).toContain('15.0s');
    expect(html).toContain('Show all metrics');
    expect(html).toContain('Provider calls');
    expect(html).toContain('Input tokens');
    expect(html).toContain('Reviewer disagreement');
    expect(html).toContain('False positives (strict)');
  });
});
