import { describe, expect, it, vi } from 'vitest';
import { SubrequestBudget } from '../../jobs/subrequest-budget.js';
import { CONTEXT_SUBREQUEST_LIMIT, loadDependencyContext } from './context-loader.js';

function input(overrides: Partial<Parameters<typeof loadDependencyContext>[0]> = {}) {
  return {
    repository: 'acme/app',
    oldSha: 'base',
    newSha: 'head',
    changedSources: { 'src/api.ts': { newSource: "import { save } from './service';\nexport function update() { return save(); }" } },
    state: { contextSubrequestsUsed: 0 },
    budget: new SubrequestBudget(44),
    cache: { getMany: vi.fn().mockResolvedValue({}), setMany: vi.fn().mockResolvedValue(undefined) },
    fetcher: { fetch: vi.fn((file: string) => Promise.resolve(file.endsWith('.ts') ? 'export function save() { return true; }' : null)) },
    ...overrides,
  };
}

describe('loadDependencyContext', () => {
  it('prioritizes dependencies named in the changed code over import order', async () => {
    const value = input({
      changedSources: { 'src/api.ts': { newSource: "import { other } from './other';\nimport { service } from './service';" } },
      repositoryPaths: ['src/other.ts', 'src/service.ts'],
      changedCode: { 'src/api.ts': '+service.save();' }, requestLimit: 3,
    });
    const result = await loadDependencyContext(value);
    expect(result.sources['src/service.ts']).toBeDefined();
    expect(result.sources['src/other.ts']).toBeUndefined();
  });

  it('resolves parent imports against real paths even for large changed files', async () => {
    const value = input({
      changedSources: { 'src/routes/api.ts': { newSource: "import { save } from '../service.js';\n" + 'x'.repeat(130000) } },
      repositoryPaths: ['src/routes/api.ts', 'src/service.ts'],
    });
    const result = await loadDependencyContext(value);
    expect(result.sources['src/service.ts'].newSource).toContain('save');
    expect(value.fetcher.fetch).toHaveBeenCalledTimes(2);
  });

  it('charges failed fetches to the request limit', async () => {
    const value = input({ fetcher: { fetch: vi.fn().mockResolvedValue(null) } });
    const result = await loadDependencyContext(value);
    expect(value.fetcher.fetch.mock.calls.length).toBeLessThan(CONTEXT_SUBREQUEST_LIMIT);
    expect(result.contextSubrequestsUsed).toBe(CONTEXT_SUBREQUEST_LIMIT);
    expect(result.truncatedBy).toBe('subrequests');
  });

  it('loads bounded dependency context and persists usage', async () => {
    const value = input();
    const result = await loadDependencyContext(value);
    expect(Object.keys(result.sources)).toContain('src/service.ts');
    expect(result.contextSubrequestsUsed).toBeGreaterThan(0);
    expect(value.state.contextSubrequestsUsed).toBe(result.contextSubrequestsUsed);
  });

  it('shares one allowance across repeated loads', async () => {
    const value = input();
    const first = await loadDependencyContext(value);
    value.changedSources = { 'src/other.ts': { newSource: "import { save } from './service';" } };
    const second = await loadDependencyContext(value);
    expect(second.contextSubrequestsUsed).toBeLessThanOrEqual(CONTEXT_SUBREQUEST_LIMIT);
    expect(first.contextSubrequestsUsed).toBeLessThanOrEqual(second.contextSubrequestsUsed);
  });

  it('does not spend context allowance after persisted quota is exhausted', async () => {
    const value = input({ state: { contextSubrequestsUsed: CONTEXT_SUBREQUEST_LIMIT } });
    const result = await loadDependencyContext(value);
    expect(result.truncatedBy).toBe('subrequests');
    expect(value.fetcher.fetch).not.toHaveBeenCalled();
    expect(result.contextSubrequestsUsed).toBe(CONTEXT_SUBREQUEST_LIMIT);
  });
});
