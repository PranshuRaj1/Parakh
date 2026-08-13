import { describe, expect, it } from 'vitest';
import { parseDiffChanges, prepareIncrementalLedger } from './changes.js';
import type { LedgerFinding } from './ledger.js';

const finding = (file: string, id: string): LedgerFinding => ({
  severity: 'HIGH', file, line: 3, body: id, suggestion: null, rule_id: null,
  finding_id: id, first_seen_head_sha: 'h1', last_validated_head_sha: 'h1',
});

describe('incremental change preparation', () => {
  it('distinguishes pure and edited renames plus deletions', () => {
    const changes = parseDiffChanges([
      'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n',
      'diff --git a/a.ts b/b.ts\nsimilarity index 80%\nrename from a.ts\nrename to b.ts\n@@ -1 +1 @@\n-a\n+b\n',
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n',
    ].join(''));
    expect(changes.map((change) => change.kind)).toEqual(['renamed', 'renamed_edited', 'deleted']);
  });

  it('carries untouched and pure-renamed findings but revalidates edited renames', () => {
    const changes = [
      { oldPath: 'old.ts', newPath: 'new.ts', kind: 'renamed' as const },
      { oldPath: 'a.ts', newPath: 'b.ts', kind: 'renamed_edited' as const },
      { oldPath: 'gone.ts', newPath: null, kind: 'deleted' as const },
    ];
    const result = prepareIncrementalLedger([
      finding('untouched.ts', 'u'), finding('old.ts', 'r'),
      finding('a.ts', 'e'), finding('gone.ts', 'd'),
    ], changes, 'h2');

    expect(result.initialFindings.map((item) => [item.finding_id, item.file])).toEqual([
      ['u', 'untouched.ts'], ['r', 'new.ts'],
    ]);
    expect(result.priorFindingsByFile.get('b.ts')?.map((item) => item.finding_id)).toEqual(['e']);
    expect(result.summary).toMatchObject({ carriedCount: 2, resolvedCount: 1 });
  });

  it('carries prior findings for ignored generated files without scheduling a model call', () => {
    const changes = [{ oldPath: 'package-lock.json', newPath: 'package-lock.json', kind: 'modified' as const }];
    const result = prepareIncrementalLedger(
      [finding('package-lock.json', 'lock')],
      changes,
      'h2',
      (path) => path !== 'package-lock.json'
    );
    expect(result.initialFindings.map((item) => item.finding_id)).toEqual(['lock']);
    expect(result.priorFindingsByFile.size).toBe(0);
    expect(result.summary.carriedCount).toBe(1);
  });
});
