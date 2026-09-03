import { describe, expect, it } from 'vitest';
import { buildShadowPlan } from './shadow-planner.js';

describe('buildShadowPlan', () => {
  it('reports deterministic planning metrics without invoking review providers', async () => {
    const result = await buildShadowPlan({
      repository: 'acme/app',
      oldSha: 'base',
      newSha: 'head',
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    });
    expect(result.metrics).toMatchObject({ changes: 1, groups: 1, estimatedReviewCalls: 1, coverage: 1 });
    expect(result.plan.groups[0].demotionReason).toContain('file fallback');
  });
});
