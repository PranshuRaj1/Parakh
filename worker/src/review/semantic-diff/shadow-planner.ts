import { buildChangeUnderstandingPlan, type ChangeUnderstandingPlan } from './plan.js';

export interface ShadowPlanMetrics {
  changes: number;
  groups: number;
  fallbackGroups: number;
  estimatedReviewCalls: number;
  coverage: number;
}

export async function buildShadowPlan(input: {
  repository: string;
  oldSha: string;
  newSha: string;
  diff: string;
}): Promise<{ plan: ChangeUnderstandingPlan; metrics: ShadowPlanMetrics }> {
  const plan = await buildChangeUnderstandingPlan(input);
  const metrics = {
    changes: plan.changes.length,
    groups: plan.groups.length,
    fallbackGroups: plan.groups.filter((group) => group.demotionReason).length,
    estimatedReviewCalls: plan.groups.length,
    coverage: plan.changes.length === 0 ? 1 : plan.groups.flatMap((group) => group.changes).length / plan.changes.length,
  };
  return { plan, metrics };
}
