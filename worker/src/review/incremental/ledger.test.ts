import { describe, expect, it } from 'vitest';
import type { Finding, PriorFindingResolution } from '@parakh/shared';
import {
  ensureLedgerFindings,
  reconcileFileFindings,
  retainPriorFindings,
  strictFindingFingerprint,
  type LedgerFinding,
} from './ledger.js';

function finding(overrides: Partial<LedgerFinding> = {}): LedgerFinding {
  return {
    severity: 'HIGH', file: 'src/a.ts', line: 10, body: 'Unsafe query', suggestion: null,
    rule_id: 'rule-1', finding_id: 'finding-1', first_seen_head_sha: 'h1',
    last_validated_head_sha: 'h1', ...overrides,
  };
}

describe('finding ledger reconciliation', () => {
  it('assigns stable metadata to historical findings without it', () => {
    const ids = ['one', 'two'];
    const result = ensureLedgerFindings([
      finding({ finding_id: undefined, first_seen_head_sha: undefined, last_validated_head_sha: undefined }),
      finding({ finding_id: 'existing' }),
    ], 'h2', () => ids.shift()!);
    expect(result[0]).toMatchObject({
      finding_id: 'one', first_seen_head_sha: 'h2', last_validated_head_sha: 'h2',
    });
    expect(result[1].finding_id).toBe('existing');
  });

  it.each([
    ['STILL_PRESENT', true],
    ['UNCERTAIN', true],
    ['RESOLVED', false],
  ] as const)('applies an explicit %s resolution', async (status, retained) => {
    const result = await reconcileFileFindings(
      [finding()], [], [{ findingId: 'finding-1', status, line: status === 'STILL_PRESENT' ? 20 : undefined }],
      'h2'
    );
    expect(result.findings.some((item) => item.finding_id === 'finding-1')).toBe(retained);
    if (status === 'STILL_PRESENT') {
      expect(result.findings[0]).toMatchObject({ line: 20, last_validated_head_sha: 'h2' });
    }
  });

  it.each([
    [null, 'MODEL_RESULT_MISSING'],
    [[], 'MODEL_RESULT_MISSING'],
    [[{ findingId: 'finding-1', status: 'BROKEN' }], 'MODEL_RESULT_MALFORMED'],
    [[
      { findingId: 'finding-1', status: 'RESOLVED' },
      { findingId: 'finding-1', status: 'STILL_PRESENT' },
    ], 'MODEL_RESULT_MALFORMED'],
  ] as Array<[PriorFindingResolution[] | null, string]>)('retains conservative outcome %s', async (resolutions, status) => {
    const result = await reconcileFileFindings([finding()], [], resolutions, 'h2');
    expect(result.findings).toHaveLength(1);
    expect(result.outcomes[0].status).toBe(status);
  });

  it('deduplicates exact new findings deterministically', async () => {
    const raw: Finding = finding({ finding_id: undefined, first_seen_head_sha: undefined, last_validated_head_sha: undefined });
    const result = await reconcileFileFindings([], [raw, { ...raw }], [], 'h2', () => 'new-id');
    expect(result.findings).toHaveLength(1);
    expect(result.summary.newCount).toBe(1);
  });

  it('reuses one semantic prior ID when its line moved', async () => {
    const raw: Finding = { ...finding(), line: 30, finding_id: undefined };
    const result = await reconcileFileFindings(
      [finding()], [raw], [{ findingId: 'finding-1', status: 'UNCERTAIN' }], 'h2'
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ finding_id: 'finding-1', line: 30 });
  });

  it('keeps distinct new repeated violations instead of collapsing them by body', async () => {
    const first: Finding = { ...finding(), line: 30, finding_id: undefined };
    const second: Finding = { ...first, line: 40 };
    const ids = ['new-1', 'new-2'];
    const result = await reconcileFileFindings([], [first, second], [], 'h2', () => ids.shift()!);
    expect(result.findings.map((item) => item.finding_id)).toEqual(['new-1', 'new-2']);
  });

  it('reuses a prior ID at most once when two new violations share its body', async () => {
    const raw: Finding = { ...finding(), line: 30, finding_id: undefined };
    const result = await reconcileFileFindings(
      [finding()],
      [raw, { ...raw, line: 40 }],
      [{ findingId: 'finding-1', status: 'UNCERTAIN' }],
      'h2',
      () => 'new-2'
    );
    expect(result.findings.map((item) => item.finding_id)).toEqual(['finding-1', 'new-2']);
  });

  it('keeps an ambiguous repeated-code match and records every involved ID', async () => {
    const prior = [finding(), finding({ finding_id: 'finding-2', line: 20 })];
    const resolutions: PriorFindingResolution[] = prior.map((item) => ({
      findingId: item.finding_id, status: 'UNCERTAIN',
    }));
    const raw: Finding = { ...finding(), line: 30, finding_id: undefined };
    const result = await reconcileFileFindings(prior, [raw], resolutions, 'h2', () => 'finding-3');
    expect(result.findings).toHaveLength(3);
    expect(result.summary.ambiguousDedupKeptCount).toBe(1);
    expect(result.summary.ambiguousFindingIds).toEqual(['finding-3', 'finding-1', 'finding-2']);
  });

  it('retains prior findings and distinguishes provider failure from missing output', () => {
    const result = retainPriorFindings([finding()], 'PROVIDER_FAILURE');
    expect(result.findings).toEqual([finding()]);
    expect(result.outcomes[0].status).toBe('PROVIDER_FAILURE');
    expect(result.summary).toMatchObject({ providerFailureCount: 1, missingCount: 0 });
  });

  it('treats a non-array resolution payload as malformed and retains the finding', async () => {
    const result = await reconcileFileFindings(
      [finding()], [], { findingId: 'finding-1', status: 'RESOLVED' } as never, 'h2'
    );
    expect(result.findings).toHaveLength(1);
    expect(result.outcomes[0].status).toBe('MODEL_RESULT_MALFORMED');
  });

  it('normalizes whitespace but keeps case-sensitive paths distinct', async () => {
    expect(await strictFindingFingerprint(finding({ body: 'Unsafe   query' }))).toBe(
      await strictFindingFingerprint(finding({ body: ' unsafe query ' }))
    );
    expect(await strictFindingFingerprint(finding({ file: 'src/A.ts' }))).not.toBe(
      await strictFindingFingerprint(finding({ file: 'src/a.ts' }))
    );
  });
});
