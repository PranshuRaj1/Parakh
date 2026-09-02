import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './unified-parser.js';

describe('parseUnifiedDiff', () => {
  it('preserves old and new coordinates for edited hunks', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -4,3 +4,4 @@ export function login() {',
      ' const user = findUser();',
      '-return user;',
      '+if (!user) return null;',
      '+return user;',
    ].join('\n'));

    expect(file).toMatchObject({ oldPath: 'src/auth.ts', newPath: 'src/auth.ts', binary: false });
    expect(file.hunks[0]).toMatchObject({
      oldStart: 4,
      oldCount: 3,
      newStart: 4,
      newCount: 4,
      evidence: {
        file: 'src/auth.ts',
        oldStart: 4,
        oldEnd: 6,
        newStart: 4,
        newEnd: 7,
        kind: 'edit',
      },
    });
    expect(file.hunks[0].evidence.patchHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses new-file coordinates for additions and old-file coordinates for deletions', async () => {
    const files = await parseUnifiedDiff([
      'diff --git a/old.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
    ].join('\n'));

    expect(files[0].hunks[0].evidence).toMatchObject({
      file: 'new.ts', newStart: 1, newEnd: 2, kind: 'add',
    });
    expect(files[1].hunks[0].evidence).toMatchObject({
      file: 'gone.ts', oldStart: 1, oldEnd: 2, kind: 'delete',
    });
  });

  it('parses quoted paths and binary files without inventing hunks', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git "a/src/old file.ts" "b/src/new file.ts"',
      'similarity index 100%',
      'rename from src/old file.ts',
      'rename to src/new file.ts',
      'Binary files a/src/old file.ts and b/src/new file.ts differ',
    ].join('\n'));

    expect(file).toMatchObject({
      oldPath: 'src/old file.ts',
      newPath: 'src/new file.ts',
      binary: true,
      hunks: [],
    });
  });

  it('keeps no-newline markers inside the hunk without changing coordinates', async () => {
    const [file] = await parseUnifiedDiff([
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
    ].join('\n'));

    expect(file.hunks[0].lines).toContain('\\ No newline at end of file');
    expect(file.hunks[0].evidence).toMatchObject({ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 });
  });
});
