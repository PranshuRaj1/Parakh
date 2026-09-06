import { afterEach, expect, it, vi } from 'vitest';
import { expandSnapshotContext } from './github-snapshot.js';

afterEach(() => vi.unstubAllGlobals());

it('expands a frozen snapshot without following a moving PR ref', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    requests.push(input);
    if (/\/git\/trees\/(head|base)\?/.test(input)) return Response.json({ truncated: false, tree: [
      { path: 'src/api.ts', type: 'blob' }, { path: 'src/service.ts', type: 'blob' },
    ] });
    if (input.endsWith('/base/src/api.ts')) return new Response("import { save } from './service';\nexport function update() { return save(true); }");
    if (input.endsWith('/src/service.ts')) return new Response('export function save(authorized) { return authorized; }');
    return new Response('', { status: 404 });
  }));
  const snapshot = await expandSnapshotContext('acme', 'app', {
    baseSha: 'base', headSha: 'head',
    files: { 'src/api.ts': "import { save } from './service';\nexport function update() { return save(false); }" },
    diff: ['diff --git a/src/api.ts b/src/api.ts', '--- a/src/api.ts', '+++ b/src/api.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
  }, 'test-token');
  expect(snapshot.files['src/service.ts']).toContain('save');
  expect(snapshot.baseFiles?.['src/api.ts']).toContain('save(true)');
  expect(snapshot.baseFiles?.['src/service.ts']).toContain('save');
  expect(snapshot.files['src/api.ts']).toContain('save(false)');
  expect(requests.every(url => /\/git\/trees\/(head|base)\?/.test(url) || /\/(base|head)\/src\//.test(url))).toBe(true);
});

it('reports unavailable repository context instead of silently caching empty content', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
  await expect(expandSnapshotContext('acme', 'app', { baseSha: 'base', headSha: 'head', files: {}, diff: '' }, 'test-token'))
    .rejects.toThrow('403');
});
