import { describe, expect, it } from 'vitest';
import { buildRepositoryIndex } from '../indexer/repository-index.js';
import { analyzeBlastRadius } from './blast-radius.js';
import { findReuseCandidates } from './reuse-detection.js';

const files = {
  'src/service.ts': `export function shared(value: string) { return value.trim(); }\nexport function changed(value: string) { return shared(value); }`,
  'src/caller-a.ts': `import { changed } from './service';\nexport function a() { return changed('a'); }`,
  'src/caller-b.ts': `import { changed } from './service';\nexport function b() { return changed('b'); }`,
  'src/service.test.ts': `import { changed } from './service';\ntest('changed', () => {\n  changed('x');\n});`,
};

describe('codebase impact analysis', () => {
  it('finds reverse callers and tests', () => {
    const index = buildRepositoryIndex('acme/app', 'head', files);
    const changed = index.symbols.filter((symbol) => symbol.qualifiedName === 'src/service.ts#changed');
    const report = analyzeBlastRadius(changed, index.symbols, index.edges);
    expect(report.affectedSymbols.map((symbol) => symbol.qualifiedName)).toContain('src/caller-a.ts#a');
    expect(report.relatedTests.map((symbol) => symbol.path)).toContain('src/service.test.ts');
    expect(report.level).toBe('medium');
  });

  it('finds a reusable implementation without embeddings', () => {
    const index = buildRepositoryIndex('acme/app', 'head', {
      'src/new.ts': `export function normalize(value: string) { return value.trim(); }`,
      'src/shared.ts': `export function clean(value: string) { return value.trim(); }`,
    });
    const changed = index.symbols.filter((symbol) => symbol.path === 'src/new.ts');
    const existing = index.symbols.filter((symbol) => symbol.path === 'src/shared.ts');
    expect(findReuseCandidates(changed, existing)).toHaveLength(1);
  });
});
