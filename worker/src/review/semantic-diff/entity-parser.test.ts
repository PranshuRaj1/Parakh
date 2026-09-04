import { describe, expect, it } from 'vitest';
import { mapDiffToChanges, mapHunkToChange } from './entity-parser.js';
import { parseUnifiedDiff } from './unified-parser.js';

describe('entity parser', () => {
  it('maps an edited hunk to its changed function', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,5 +1,6 @@',
      ' export function login() {',
      '   const user = findUser();',
      '-  return user;',
      '+  if (!user) return null;',
      '+  return user;',
      '}',
    ].join('\n'));

    const change = mapHunkToChange(
      'acme/app',
      'base',
      'head',
      file.hunks[0],
      { newSource: 'export function login() {\n  const user = findUser();\n  if (!user) return null;\n  return user;\n}' },
    );

    expect(change).toMatchObject({
      file: 'src/auth.ts',
      operation: 'edit',
      symbol: 'src/auth.ts#login',
      confidence: 'high',
    });
  });

  it('falls back to low-confidence hunk evidence when the symbol is unavailable', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git a/config.yaml b/config.yaml',
      '--- a/config.yaml',
      '+++ b/config.yaml',
      '@@ -1 +1 @@',
      '-timeout: 10',
      '+timeout: 20',
    ].join('\n'));

    const change = mapHunkToChange('acme/app', 'base', 'head', file.hunks[0], {
      newSource: 'timeout: 20',
    });

    expect(change).toMatchObject({
      file: 'config.yaml',
      symbol: null,
      confidence: 'low',
      reason: 'no reliable symbol range match',
    });
  });

  it('maps deleted lines against the old source', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1,4 +1,2 @@',
      ' export function keep() {',
      '-  return 1;',
      '-  return 2;',
      '}',
    ].join('\n'));

    const change = mapHunkToChange(
      'acme/app',
      'base',
      'head',
      file.hunks[0],
      { oldSource: 'export function keep() {\n  return 1;\n  return 2;\n}' },
    );

    expect(change).toMatchObject({ symbol: 'src/old.ts#keep', confidence: 'high' });
    expect(change.evidence.newStart).toBe(1);
  });

  it('maps nested Python changes to the smallest enclosing symbol', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git a/user.py b/user.py',
      '--- a/user.py',
      '+++ b/user.py',
      '@@ -2,2 +2,2 @@',
      '     def save(self):',
      '-        return False',
      '+        return True',
    ].join('\n'));

    const change = mapHunkToChange('acme/app', 'base', 'head', file.hunks[0], {
      newSource: 'class User:\n    def save(self):\n        return True\n',
    });

    expect(change).toMatchObject({ symbol: 'user.py#save', confidence: 'high' });
  });

  it('returns deterministic ordering for multiple hunks', async () => {
    const files = await parseUnifiedDiff([
      'diff --git a/z.ts b/z.ts',
      '--- a/z.ts',
      '+++ b/z.ts',
      '@@ -10 +10 @@',
      '-old',
      '+new',
      '@@ -2 +2 @@',
      '-old',
      '+new',
    ].join('\n'));

    const changes = mapDiffToChanges('acme/app', 'base', 'head', files[0].hunks, {
      'z.ts': { newSource: 'export function a() {\nnew\n}\nexport function b() {\nnew\n}' },
    });

    expect(changes.map((change) => change.evidence.newStart)).toEqual([2, 10]);
  });
});
