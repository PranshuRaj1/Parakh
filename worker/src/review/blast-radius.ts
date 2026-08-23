import type { BlastRadiusReport, IndexedSymbol, SymbolReference } from '@parakh/shared';
import type { IndexedEdge } from '../indexer/edges.js';

function reference(symbol: IndexedSymbol): SymbolReference {
  const { id: _id, signature: _signature, exported: _exported, normalizedBody: _body, bodyHash: _hash, imports: _imports, ...result } = symbol;
  return result;
}

function isTest(symbol: IndexedSymbol): boolean {
  return /(?:\.test|\.spec|__tests__)/i.test(symbol.path);
}

export function analyzeBlastRadius(
  changed: IndexedSymbol[],
  symbols: IndexedSymbol[],
  edges: IndexedEdge[],
  maxDepth = 2
): BlastRadiusReport {
  const changedIds = new Set(changed.map((symbol) => symbol.id));
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const affected = new Set<string>();
  const tests = new Set<string>();
  let frontier = new Set(changed.map((symbol) => symbol.id));

  for (let depth = 0; depth < maxDepth; depth++) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (!frontier.has(edge.to) || changedIds.has(edge.from)) continue;
      next.add(edge.from);
      affected.add(edge.from);
    }
    frontier = next;
  }

  for (const edge of edges) {
    const source = byId.get(edge.from);
    if (changedIds.has(edge.to) && source && isTest(source)) tests.add(edge.from);
  }

  const affectedSymbols = symbols.filter((symbol) => affected.has(symbol.id));
  const relatedTests = symbols.filter((symbol) => tests.has(symbol.id));
  const signals: string[] = [];
  if (changed.some((symbol) => symbol.exported)) signals.push('exported symbol changed');
  if (changed.some((symbol) => /(?:route|auth|middleware|schema|migration|config)/i.test(symbol.path))) {
    signals.push('sensitive boundary changed');
  }
  if (affectedSymbols.length >= 5) signals.push(`${affectedSymbols.length} reverse callers found`);
  if (relatedTests.length < changed.length) signals.push('incomplete direct test coverage');

  const high = signals.some((signal) => signal === 'sensitive boundary changed') || affectedSymbols.length >= 8;
  const medium = high || signals.length > 0 || affectedSymbols.length > 0;
  return {
    level: high ? 'high' : medium ? 'medium' : 'low',
    changedSymbols: changed.map(reference),
    affectedSymbols: affectedSymbols.map(reference),
    relatedTests: relatedTests.map(reference),
    riskSignals: signals,
    confidence: symbols.length > 0 ? 'high' : 'low',
  };
}
