import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../index.js';
import { DEFAULT_FEATURE_FLAGS, getFeatureFlags } from './feature-flags.js';

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

describe('getFeatureFlags', () => {
  it('uses documented defaults when bindings are absent or empty', () => {
    expect(getFeatureFlags(env())).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(getFeatureFlags(env({ SEMANTIC_DIFF_ENABLED: '   ' }))).toEqual(DEFAULT_FEATURE_FLAGS);
  });

  it('parses explicit true and false values case-insensitively', () => {
    const flags = getFeatureFlags(env({
      SEMANTIC_DIFF_ENABLED: ' TRUE ',
      BEHAVIOR_GROUPING_ENABLED: 'true',
      BEHAVIOR_GROUPING_SHADOW: 'FALSE',
      GROUPED_REVIEW_OUTPUT_ENABLED: ' true ',
      STALENESS_CHECK_ENABLED: 'TRUE',
      DETERMINISTIC_ANALYSIS_ENABLED: 'false',
    }));

    expect(flags).toEqual({
      semanticDiff: true,
      behaviorGrouping: true,
      behaviorGroupingShadow: false,
      groupedReviewOutput: true,
      stalenessCheck: true,
      deterministicAnalysis: false,
    });
  });

  it.each(['yes', 'no', '1', '0', 'enabled'])('fails closed for invalid value %j', (value) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getFeatureFlags(env({ SEMANTIC_DIFF_ENABLED: value })).semanticDiff).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      '[config] Invalid boolean for SEMANTIC_DIFF_ENABLED; using default false'
    );
  });

  it('allows shadow mode while behavior grouping is disabled', () => {
    const flags = getFeatureFlags(env({
      BEHAVIOR_GROUPING_ENABLED: 'false',
      BEHAVIOR_GROUPING_SHADOW: 'true',
    }));

    expect(flags.behaviorGrouping).toBe(false);
    expect(flags.behaviorGroupingShadow).toBe(true);
  });

  it('disables grouped output when behavior grouping is disabled', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flags = getFeatureFlags(env({
      BEHAVIOR_GROUPING_ENABLED: 'false',
      GROUPED_REVIEW_OUTPUT_ENABLED: 'true',
    }));

    expect(flags.groupedReviewOutput).toBe(false);
    expect(warning).toHaveBeenCalledWith(
      '[config] GROUPED_REVIEW_OUTPUT_ENABLED requires BEHAVIOR_GROUPING_ENABLED; disabling grouped output'
    );
  });

  it('does not mutate or cache the environment or returned snapshot', () => {
    const firstEnv = Object.freeze({ SEMANTIC_DIFF_ENABLED: 'true' }) as Env;
    const first = getFeatureFlags(firstEnv);
    const second = getFeatureFlags(env({ SEMANTIC_DIFF_ENABLED: 'false' }));

    expect(first.semanticDiff).toBe(true);
    expect(second.semanticDiff).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('never includes unrelated environment values in warnings', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getFeatureFlags(env({
      SEMANTIC_DIFF_ENABLED: 'not-a-boolean',
      GITHUB_APP_PRIVATE_KEY: 'private-secret',
      UPSTASH_REDIS_TOKEN: 'redis-secret',
    }));

    const output = warning.mock.calls.flat().join(' ');
    expect(output).not.toContain('private-secret');
    expect(output).not.toContain('redis-secret');
  });
});
