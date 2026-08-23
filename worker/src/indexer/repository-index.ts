import type { IndexedSymbol } from '@parakh/shared';
import { buildEdges, type IndexedEdge } from './edges.js';
import { parseTypeScriptFile } from './parser.js';

export interface RepositoryIndex {
  symbols: IndexedSymbol[];
  edges: IndexedEdge[];
}

export function buildRepositoryIndex(
  repo: string,
  commitSha: string,
  files: Record<string, string>
): RepositoryIndex {
  const symbols = Object.entries(files)
    .filter(([path]) => /\.(?:ts|tsx|js|jsx)$/.test(path))
    .flatMap(([path, source]) => parseTypeScriptFile(repo, commitSha, path, source));
  return { symbols, edges: buildEdges(symbols) };
}
