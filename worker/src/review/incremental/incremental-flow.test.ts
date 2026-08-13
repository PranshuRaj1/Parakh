import { describe, expect, it } from 'vitest';
import { computeScore, type Finding } from '@parakh/shared';
import { parseDiffChanges, prepareIncrementalLedger } from './changes.js';
import { ensureLedgerFindings, reconcileFileFindings, type LedgerFinding } from './ledger.js';

function priorFinding(file: string, id: string, line: number): LedgerFinding {
  return {
    severity: 'HIGH', file, line, body: `Issue ${id}`, suggestion: null, rule_id: null,
    finding_id: id, first_seen_head_sha: 'large-review', last_validated_head_sha: 'large-review',
  };
}

describe('incremental review snapshot flow', () => {
  it('reviews only a later ten-line delta while scoring unresolved findings from the large parent', async () => {
    const parentFindings = [
      priorFinding('src/large.ts', 'untouched', 1_750),
      priorFinding('src/small.ts', 'touched', 4),
    ];
    const tenLineDelta = [
      'diff --git a/src/small.ts b/src/small.ts',
      'index 1111111..2222222 100644',
      '--- a/src/small.ts',
      '+++ b/src/small.ts',
      '@@ -1,5 +1,10 @@',
      ' export const one = 1;',
      '+export const two = 2;',
      '+export const three = 3;',
      '+export const four = 4;',
      '+export const five = 5;',
      '+export const six = 6;',
    ].join('\n');

    const prepared = prepareIncrementalLedger(
      parentFindings,
      parseDiffChanges(tenLineDelta),
      'small-follow-up'
    );
    expect(prepared.initialFindings.map((finding) => finding.finding_id)).toEqual(['untouched']);
    expect([...prepared.priorFindingsByFile.keys()]).toEqual(['src/small.ts']);

    const reviewed = await reconcileFileFindings(
      prepared.priorFindingsByFile.get('src/small.ts')!,
      [],
      [{ findingId: 'touched', status: 'STILL_PRESENT', line: 9 }],
      'small-follow-up'
    );
    const completeSnapshot = [...prepared.initialFindings, ...reviewed.findings];
    expect(completeSnapshot).toHaveLength(2);
    expect(completeSnapshot.find((finding) => finding.finding_id === 'touched')?.line).toBe(9);
    expect(computeScore(completeSnapshot)).toBeLessThan(5);
  });

  it('a replacement full snapshot does not inherit incremental ambiguity', async () => {
    const raw: Finding = {
      severity: 'HIGH', file: 'src/repeated.ts', line: 30,
      body: 'Repeated issue', suggestion: null, rule_id: null,
    };
    const fullSnapshot = ensureLedgerFindings([raw], 'full-reset-head', () => 'fresh-full-id');
    expect(fullSnapshot).toHaveLength(1);
    expect(fullSnapshot[0]).toMatchObject({
      finding_id: 'fresh-full-id',
      first_seen_head_sha: 'full-reset-head',
      last_validated_head_sha: 'full-reset-head',
    });
  });
});
