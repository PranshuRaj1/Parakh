import type { Review } from '@parakh/shared';

export type IncrementalFallbackReason =
  | 'no_completed_parent'
  | 'parent_not_completed'
  | 'parent_metadata_missing'
  | 'base_changed'
  | 'rules_changed'
  | 'pipeline_changed'
  | 'head_not_descendant';

export type IncrementalPlan =
  | { decision: 'eligible'; parent: Review; comparisonBaseSha: string }
  | { decision: 'fallback'; reason: IncrementalFallbackReason };

export interface IncrementalPlanInput {
  parent: Review | null;
  currentBaseSha: string;
  activeRulesHash: string;
  pipelineVersion: string;
  parentIsAncestor: boolean | null;
}

/**
 * Decide whether a parent ledger is compatible with the current PR state.
 * Falling back to a full review is safer than reusing findings across changed
 * base commits, rules, pipeline versions, or unrelated commit histories.
 */
export function planIncrementalReview(input: IncrementalPlanInput): IncrementalPlan {
  const { parent } = input;
  if (!parent) return { decision: 'fallback', reason: 'no_completed_parent' };
  if (parent.status !== 'COMPLETED') {
    return { decision: 'fallback', reason: 'parent_not_completed' };
  }
  if (!parent.head_sha || !parent.base_sha || !parent.active_rules_hash || !parent.pipeline_version) {
    return { decision: 'fallback', reason: 'parent_metadata_missing' };
  }
  if (parent.base_sha !== input.currentBaseSha) {
    return { decision: 'fallback', reason: 'base_changed' };
  }
  if (parent.active_rules_hash !== input.activeRulesHash) {
    return { decision: 'fallback', reason: 'rules_changed' };
  }
  if (parent.pipeline_version !== input.pipelineVersion) {
    return { decision: 'fallback', reason: 'pipeline_changed' };
  }
  if (input.parentIsAncestor !== true) {
    return { decision: 'fallback', reason: 'head_not_descendant' };
  }
  return { decision: 'eligible', parent, comparisonBaseSha: parent.head_sha };
}
