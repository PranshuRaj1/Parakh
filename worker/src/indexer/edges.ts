import type { CodeEdgeType, IndexedSymbol } from '@parakh/shared';

export interface IndexedEdge {
  from: string;
  to: string;
  type: CodeEdgeType;
}

export function buildEdges(symbols: IndexedSymbol[]): IndexedEdge[] {
  const byName = new Map<string, IndexedSymbol>();
  for (const symbol of symbols) byName.set(symbol.qualifiedName.split('#')[1], symbol);
  const byPath = new Map<string, IndexedSymbol>();
  for (const symbol of symbols) {
    byPath.set(symbol.path, symbol);
    byPath.set(symbol.path.replace(/\.(?:tsx?|jsx?)$/, ''), symbol);
  }
  const calls = [...byName].map(([name, target]) => ({
    name,
    target,
    pattern: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`),
  }));
  const edges: IndexedEdge[] = [];

  for (const symbol of symbols) {
    for (const imported of symbol.imports) {
      const directory = symbol.path.includes('/') ? symbol.path.slice(0, symbol.path.lastIndexOf('/')) : '';
      const resolved = imported.startsWith('./') ? `${directory}/${imported.slice(2)}` : imported;
      const target = byPath.get(resolved) ?? byPath.get(imported);
      if (target) edges.push({ from: symbol.id, to: target.id, type: 'imports' });
    }
    for (const { name, target, pattern } of calls) {
      if (name !== symbol.qualifiedName.split('#')[1] && pattern.test(symbol.normalizedBody)) {
        edges.push({ from: symbol.id, to: target.id, type: 'calls' });
      }
    }
  }
  return edges;
}
