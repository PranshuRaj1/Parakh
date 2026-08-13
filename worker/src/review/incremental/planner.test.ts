import { describe, expect, it } from 'vitest';
import type { Review } from '@parakh/shared';
import { planIncrementalReview } from './planner.js';

const parent = {
  id: 'parent', status: 'COMPLETED', head_sha: 'head-1', base_sha: 'base-1',
  active_rules_hash: 'rules-1', pipeline_version: '2a',
} as Review;

const valid = {
  parent,
  currentBaseSha: 'base-1',
  activeRulesHash: 'rules-1',
  pipelineVersion: '2a',
  parentIsAncestor: true,
};

describe('planIncrementalReview', () => {
  it('selects the previous completed head for an eligible delta', () => {
    expect(planIncrementalReview(valid)).toEqual({
      decision: 'eligible', parent, comparisonBaseSha: 'head-1',
    });
  });

  it.each([
    [{ ...valid, parent: null }, 'no_completed_parent'],
    [{ ...valid, parent: { ...parent, status: 'FAILED' } }, 'parent_not_completed'],
    [{ ...valid, parent: { ...parent, active_rules_hash: null } }, 'parent_metadata_missing'],
    [{ ...valid, currentBaseSha: 'base-2' }, 'base_changed'],
    [{ ...valid, activeRulesHash: 'rules-2' }, 'rules_changed'],
    [{ ...valid, pipelineVersion: '2b' }, 'pipeline_changed'],
    [{ ...valid, parentIsAncestor: false }, 'head_not_descendant'],
    [{ ...valid, parentIsAncestor: null }, 'head_not_descendant'],
  ] as const)('falls back deterministically: %s', (input, reason) => {
    expect(planIncrementalReview(input)).toEqual({ decision: 'fallback', reason });
  });
});
