import { FINALIZE_BUDGET_RESERVE, SubrequestBudget } from '../../jobs/subrequest-budget.js';
import { dependencyPaths } from './dependency-paths.js';

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

export async function loadDependencyContext(input: {
  repository: string;
  oldSha: string;
  newSha: string;
  changedSources: Record<string, ContextSource>;
  state: ContextState;
  budget: SubrequestBudget;
  cache: ContextCache;
  fetcher: ContextFetcher;
  repositoryPaths?: readonly string[];
  requestLimit?: number;
  fileLimit?: number;
  changedCode?: Record<string, string>;
}): Promise<ContextLoadResult> {
  const sources = { ...input.changedSources };
  let used = input.state.contextSubrequestsUsed;
  let truncatedBy: ContextLoadResult['truncatedBy'] = null;
  const canSpend = () => used < (input.requestLimit ?? CONTEXT_SUBREQUEST_LIMIT) && input.budget.hasRoomFor(FINALIZE_BUDGET_RESERVE + 1);
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

  const candidates = new Map<string, number>();
  for (const [file, source] of Object.entries(input.changedSources)) {
    for (const content of [source.newSource, source.oldSource]) {
      for (const candidate of dependencyPaths(input.repository, file, content ?? '', input.repositoryPaths)) {
        if (candidate in sources) continue;
        const changed = (input.changedCode?.[file] ?? '').toLowerCase();
        const names = candidate.replace(/\.[^.\/]+$/, '').split('/').filter(name => name.length > 2);
        const score = names.filter(name => changed.includes(name.toLowerCase())).length;
        candidates.set(candidate, Math.max(candidates.get(candidate) ?? 0, score));
      }
    }
  }
  const files = [...candidates.keys()].sort((left, right) => candidates.get(right)! - candidates.get(left)!);
  const cacheKeys = files.flatMap((file) => [cacheKey(input.repository, input.oldSha, file), cacheKey(input.repository, input.newSha, file)]);
  const cached: Record<string, string | null> = {};
  if (cacheKeys.length > 0 && spendContext()) Object.assign(cached, await input.cache.getMany(cacheKeys));
  const writes: Record<string, string> = {};
  let bytes = 0;
  let loaded = 0;
  const read = async (file: string, sha: string, key: string) => {
    if (key in cached) return cached[key];
    if (!spendContext()) return null;
    const content = await input.fetcher.fetch(file, sha);
    if (content !== null) writes[key] = content;
    return content;
  };
  for (const file of files) {
    if (loaded >= (input.fileLimit ?? CONTEXT_FILE_LIMIT)) {
      truncatedBy = 'files';
      break;
    }
    const oldKey = cacheKey(input.repository, input.oldSha, file);
    const newKey = cacheKey(input.repository, input.newSha, file);
    const newSource = await read(file, input.newSha, newKey);
    const oldSource = await read(file, input.oldSha, oldKey);
    if (oldSource === null && newSource === null) {
      if (!canSpend()) break;
      continue;
    }
    const nextBytes = bytes + new TextEncoder().encode(oldSource ?? '').length + new TextEncoder().encode(newSource ?? '').length;
    if (nextBytes > CONTEXT_BYTE_LIMIT) {
      truncatedBy = 'bytes';
      continue;
    }
    sources[file] = { oldSource: oldSource ?? undefined, newSource: newSource ?? undefined };
    bytes = nextBytes;
    loaded++;
  }
  if (Object.keys(writes).length > 0 && spendContext()) await input.cache.setMany(writes);
  return { sources, contextSubrequestsUsed: used, truncatedBy };
}
