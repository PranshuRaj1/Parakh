import type { CodeEdgeType, IndexedSymbol } from '@parakh/shared';

export interface IndexedEdge {
  from: string;
  to: string;
  type: CodeEdgeType;
}

export function buildEdges(symbols: IndexedSymbol[]): IndexedEdge[] {
  const byName = new Map<string, IndexedSymbol>();
  for (const symbol of symbols) byName.set(symbol.qualifiedName.split('#')[1], symbol);
  const edges: IndexedEdge[] = [];

  for (const symbol of symbols) {
    for (const imported of symbol.imports) {
      const target = symbols.find((candidate) => candidate.path === imported || candidate.path.endsWith(imported));
      if (target) edges.push({ from: symbol.id, to: target.id, type: 'imports' });
    }
    for (const [name, target] of byName) {
      if (name !== symbol.qualifiedName.split('#')[1] && new RegExp(`\\b${name}\\s*\\(`).test(symbol.normalizedBody)) {
        edges.push({ from: symbol.id, to: target.id, type: 'calls' });
      }
    }
  }
  return edges;
}
