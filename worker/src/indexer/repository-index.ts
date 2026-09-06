import type { IndexedSymbol } from '@parakh/shared';
import { buildEdges, type IndexedEdge } from './edges.js';
import { parseSourceFile } from './parser.js';
import { dependencyPaths } from '../review/semantic-diff/dependency-paths.js';

export interface RepositoryIndex {
  symbols: IndexedSymbol[];
  edges: IndexedEdge[];
}

export function buildRepositoryIndex(
  repo: string,
  commitSha: string,
  files: Record<string, string>
): RepositoryIndex {
  const paths = Object.keys(files);
  const symbols = Object.entries(files).flatMap(([path, source]) => {
    const imports = dependencyPaths(repo, path, source, paths);
    return parseSourceFile(repo, commitSha, path, source)
      .map(symbol => ({ ...symbol, imports: [...new Set([...symbol.imports, ...imports])] }));
  });
  return { symbols, edges: buildEdges(symbols) };
}
