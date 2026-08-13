import { describe, expect, it } from 'vitest';
import { buildShadowObservation } from './shadow.js';

const full = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const delta = 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n';

describe('buildShadowObservation', () => {
  it('measures both inputs and proves the executed input remained full', () => {
    const run = buildShadowObservation({
      reviewId: 'r', parentReviewId: 'p', decision: 'eligible', fallbackReason: null,
      parentHeadSha: 'h1', currentHeadSha: 'h2', fullDiff: full, incrementalDiff: delta,
      executionDiffHash: 'full-hash', fullDiffHash: 'full-hash',
    });
    expect(run.fullFileCount).toBe(1);
    expect(run.incrementalFileCount).toBe(1);
    expect(run.inputRatio).toBe(delta.length / full.length);
    expect(run.executionMatchesFull).toBe(true);
  });

  it('keeps unavailable delta measurements null for fallbacks', () => {
    const run = buildShadowObservation({
      reviewId: 'r', parentReviewId: null, decision: 'fallback', fallbackReason: 'no_completed_parent',
      parentHeadSha: null, currentHeadSha: 'h2', fullDiff: full, incrementalDiff: null,
      executionDiffHash: 'full-hash', fullDiffHash: 'full-hash',
    });
    expect(run.incrementalInputCharacters).toBeNull();
    expect(run.inputRatio).toBeNull();
  });
});
