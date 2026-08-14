import { describe, expect, it } from 'vitest';
import type { Rule } from '@parakh/shared';
import { hashActiveRules } from './compatibility.js';

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: 'rule-1', repo: 'acme/app', body: 'Use parameterized SQL', embedding: null,
    status: 'ACTIVE', scope: {}, priority: 'normal', kind: 'standard',
    supersedes: null, superseded_by: null, source_pr: null, evidence_count: 0,
    reinforcement_count: 0, created_at: '2026-01-01', superseded_at: null,
    ...overrides,
  };
}

describe('hashActiveRules', () => {
  it('is stable across rule and scope-key ordering', async () => {
    const left = [rule({ id: 'b', scope: { z: 1, a: 2 } }), rule({ id: 'a' })];
    const right = [rule({ id: 'a' }), rule({ id: 'b', scope: { a: 2, z: 1 } })];
    expect(await hashActiveRules(left)).toBe(await hashActiveRules(right));
  });

  it('changes when review-relevant rule data changes', async () => {
    expect(await hashActiveRules([rule({})])).not.toBe(
      await hashActiveRules([rule({ priority: 'high' })])
    );
  });
});
