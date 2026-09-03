import { FINALIZE_BUDGET_RESERVE, SubrequestBudget } from '../../jobs/subrequest-budget.js';

export const CONTEXT_SUBREQUEST_LIMIT = 8;
export const CONTEXT_FILE_LIMIT = 20;
export const CONTEXT_SYMBOL_LIMIT = 40;
export const CONTEXT_DEPTH_LIMIT = 1;
export const CONTEXT_BYTE_LIMIT = 120_000;

export interface ContextSource {
  oldSource?: string;
  newSource?: string;
}

export interface ContextState {
  contextSubrequestsUsed: number;
}

export interface ContextLoadResult {
  sources: Record<string, ContextSource>;
  contextSubrequestsUsed: number;
  truncatedBy: 'files' | 'bytes' | 'symbols' | 'depth' | 'subrequests' | null;
}

interface ContextCache {
  getMany(keys: string[]): Promise<Record<string, string | null>>;
  setMany(values: Record<string, string>): Promise<void>;
}

interface ContextFetcher {
  fetch(file: string, sha: string): Promise<string | null>;
}

function cacheKey(repository: string, sha: string, path: string): string {
  return `parakh:semantic-context:v1:${repository}:${sha}:${path}`;
}

function importsFor(source: string): string[] {
  const matches = source.matchAll(/(?:import\s+(?:[\s\S]*?\s+from\s+)?|from\s+|require\s*\(\s*)['\"]([^'\"]+)['\"]/g);
  return [...matches].map((match) => match[1]);
}

function resolveImport(file: string, imported: string): string | null {
  if (!imported.startsWith('.')) return null;
  const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const path = `${directory}/${imported.slice(2)}`.replace(/\/+/g, '/');
  return path.replace(/\/$/, '');
}

function candidatePaths(file: string, imported: string): string[] {
  const base = resolveImport(file, imported);
  if (!base) return [];
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.py`, `${base}.go`, `${base}.java`, `${base}.lua`, `${base}/index.ts`, `${base}/index.js`];
}

function symbolCount(source: string): number {
  return (source.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|def|func|public|private|protected)\b/gm) ?? []).length;
}

export async function loadDependencyContext(input: {
  repository: string;
  oldSha: string;
  newSha: string;
  changedSources: Record<string, ContextSource>;
  state: ContextState;
  budget: SubrequestBudget;
  cache: ContextCache;
  fetcher: ContextFetcher;
}): Promise<ContextLoadResult> {
  const sources = { ...input.changedSources };
  let used = input.state.contextSubrequestsUsed;
  let truncatedBy: ContextLoadResult['truncatedBy'] = null;
  const canSpend = () => used < CONTEXT_SUBREQUEST_LIMIT && input.budget.hasRoomFor(FINALIZE_BUDGET_RESERVE + 1);
  const spendContext = () => {
    if (!canSpend()) {
      truncatedBy = 'subrequests';
      return false;
    }
    input.budget.spend(1);
    used++;
    input.state.contextSubrequestsUsed = used;
    return true;
  };

  const candidates = new Set<string>();
  for (const [file, source] of Object.entries(input.changedSources)) {
    for (const imported of importsFor(source.newSource ?? source.oldSource ?? '')) {
      for (const candidate of candidatePaths(file, imported)) candidates.add(candidate);
    }
  }
  const files = [...candidates].sort().slice(0, CONTEXT_FILE_LIMIT);
  if (candidates.size > CONTEXT_FILE_LIMIT) truncatedBy = 'files';
  const cacheKeys = files.flatMap((file) => [cacheKey(input.repository, input.oldSha, file), cacheKey(input.repository, input.newSha, file)]);
  const cached: Record<string, string | null> = {};
  if (cacheKeys.length > 0 && spendContext()) Object.assign(cached, await input.cache.getMany(cacheKeys));
  const writes: Record<string, string> = {};
  let bytes = Object.values(sources).reduce((total, source) => total + (source.oldSource?.length ?? 0) + (source.newSource?.length ?? 0), 0);
  let symbols = Object.values(sources).reduce((total, source) => total + symbolCount(source.oldSource ?? '') + symbolCount(source.newSource ?? ''), 0);
  for (const file of files) {
    if (Object.keys(sources).length >= CONTEXT_FILE_LIMIT) {
      truncatedBy = 'files';
      break;
    }
    const oldKey = cacheKey(input.repository, input.oldSha, file);
    const newKey = cacheKey(input.repository, input.newSha, file);
    const oldSource = cached[oldKey] ?? (canSpend() ? await input.fetcher.fetch(file, input.oldSha) : null);
    if (cached[oldKey] === undefined && oldSource !== null && oldSource !== undefined) {
      if (!spendContext()) break;
      writes[oldKey] = oldSource;
    }
    const newSource = cached[newKey] ?? (canSpend() ? await input.fetcher.fetch(file, input.newSha) : null);
    if (cached[newKey] === undefined && newSource !== null && newSource !== undefined) {
      if (!spendContext()) break;
      writes[newKey] = newSource;
    }
    if (oldSource === null && newSource === null) continue;
    const nextBytes = bytes + (oldSource?.length ?? 0) + (newSource?.length ?? 0);
    const nextSymbols = symbols + symbolCount(oldSource ?? '') + symbolCount(newSource ?? '');
    if (nextBytes > CONTEXT_BYTE_LIMIT) {
      truncatedBy = 'bytes';
      break;
    }
    if (nextSymbols > CONTEXT_SYMBOL_LIMIT) {
      truncatedBy = 'symbols';
      break;
    }
    sources[file] = { oldSource: oldSource ?? undefined, newSource: newSource ?? undefined };
    bytes = nextBytes;
    symbols = nextSymbols;
  }
  if (Object.keys(writes).length > 0 && spendContext()) await input.cache.setMany(writes);
  return { sources, contextSubrequestsUsed: used, truncatedBy };
}
