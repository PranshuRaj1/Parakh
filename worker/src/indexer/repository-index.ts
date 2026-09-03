import type { IndexedSymbol } from '@parakh/shared';
import { buildEdges, type IndexedEdge } from './edges.js';
import { parseSourceFile } from './parser.js';

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
    .flatMap(([path, source]) => parseSourceFile(repo, commitSha, path, source));
  return { symbols, edges: buildEdges(symbols) };
}
