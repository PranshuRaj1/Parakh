import { describe, expect, it } from 'vitest';
import { buildChangeUnderstandingPlan } from './plan.js';

describe('change understanding plan', () => {
  it('composes semantic changes, token deltas, moves, and groups', async () => {
    const plan = await buildChangeUnderstandingPlan({
      repository: 'acme/app',
      oldSha: 'base',
      newSha: 'head',
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,5 +1,5 @@',
        ' export function update() {',
        '-  return value == null;',
        '+  return value !== null;',
        '}',
      ].join('\n'),
      sources: {
        'src/a.ts': { newSource: 'export function update() {\n  return value !== null;\n}' },
      },
    });

    expect(plan.files).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({ symbol: 'src/a.ts#update', confidence: 'high' });
    expect(plan.changes[0].tokenChanges).toEqual([
      { kind: 'changed', value: '!==', previous: '==' },
    ]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].changes[0].id).toBe(plan.changes[0].id);
  });

  it('detects a moved block across files', async () => {
    const plan = await buildChangeUnderstandingPlan({
      repository: 'acme/app',
      oldSha: 'base',
      newSha: 'head',
      diff: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,4 +1 @@',
        '-export function moved() {',
        '-  one();',
        '-  two();',
        '-}',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1,4 @@',
        ' export function other() {',
        '+export function moved() {',
        '+  one();',
        '+  two();',
        '+}',
      ].join('\n'),
    });

    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({
      from: { file: 'src/a.ts', startLine: 1, endLine: 4 },
      to: { file: 'src/b.ts', startLine: 2, endLine: 5 },
      confidence: 'high',
    });
  });
});
