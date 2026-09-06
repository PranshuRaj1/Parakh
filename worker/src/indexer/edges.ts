import type { CodeEdgeType, IndexedSymbol } from '@parakh/shared';

export interface IndexedEdge {
  from: string;
  to: string;
  type: CodeEdgeType;
}

function name(symbol: IndexedSymbol): string {
  return symbol.qualifiedName.split('#')[1];
}

function withoutExtension(path: string): string {
  return path.replace(/\.(?:tsx?|jsx?)$/, '');
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function importedPath(symbol: IndexedSymbol, imported: string): string {
  if (!imported.startsWith('.')) return imported;
  const directory = symbol.path.slice(0, Math.max(0, symbol.path.lastIndexOf('/') + 1));
  return normalizePath(`${directory}${imported}`);
}

function add<K>(map: Map<K, IndexedSymbol[]>, key: K, symbol: IndexedSymbol): void {
  map.set(key, [...(map.get(key) ?? []), symbol]);
}

export function buildEdges(symbols: IndexedSymbol[]): IndexedEdge[] {
  const byName = new Map<string, IndexedSymbol[]>();
  const byPath = new Map<string, IndexedSymbol[]>();
  for (const symbol of symbols) {
    add(byName, name(symbol), symbol);
    add(byPath, symbol.path, symbol);
    add(byPath, withoutExtension(symbol.path), symbol);
    if (/\/index\.(?:tsx?|jsx?)$/.test(symbol.path)) {
      add(byPath, symbol.path.replace(/\/index\.(?:tsx?|jsx?)$/, ''), symbol);
    }
  }
  const patterns = new Map([...byName].map(([symbolName]) => [
    symbolName,
    new RegExp(`\\b${symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`),
  ]));
  const edges: IndexedEdge[] = [];

  for (const symbol of symbols) {
    const imported = symbol.imports.flatMap((path) => {
      const resolved = importedPath(symbol, path);
      return byPath.get(resolved) ?? byPath.get(withoutExtension(resolved)) ?? [];
    });
    const scoped = new Set([
      ...symbols.filter((candidate) => candidate.path === symbol.path),
      ...imported,
    ]);

    if (imported.length === 1) edges.push({ from: symbol.id, to: imported[0].id, type: 'imports' });

    for (const target of scoped) {
      if (target.id === symbol.id || !['class', 'interface', 'type'].includes(target.kind)) continue;
      const identifier = name(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${identifier}\\b`).test(symbol.normalizedBody)) {
        edges.push({ from: symbol.id, to: target.id, type: 'references' });
      }
    }

    for (const [symbolName, candidates] of byName) {
      if (!patterns.get(symbolName)!.test(symbol.normalizedBody)) continue;
      const scopedCandidates = candidates.filter((candidate) => candidate.id !== symbol.id && scoped.has(candidate));
      const targets = scopedCandidates.length > 0
        ? scopedCandidates
        : candidates.length === 1 && candidates[0].id !== symbol.id ? candidates : [];
      for (const target of targets) edges.push({ from: symbol.id, to: target.id, type: 'calls' });
    }
  }
  return [...new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()];
}
