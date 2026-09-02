import type { IndexedSymbol } from '@parakh/shared';
import type { IndexedEdge } from '../../indexer/edges.js';
import type { SemanticChange } from '../semantic-diff/entity-parser.js';
import type { ChangeGraph, ChangeGraphEdge, ChangeGraphNode } from './types.js';

function symbolName(value: string | null): string | null {
  return value?.includes('#') ? value : null;
}

export function buildChangeGraph(
  changes: SemanticChange[],
  symbols: IndexedSymbol[],
  edges: IndexedEdge[],
): ChangeGraph {
  const nodes: ChangeGraphNode[] = changes.map((change) => ({ change, symbol: symbolName(change.symbol) }));
  const bySymbol = new Map(nodes.filter((node) => node.symbol).map((node) => [node.symbol!, node.change.id]));
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol.qualifiedName]));
  const graphEdges: ChangeGraphEdge[] = [];
  for (const edge of edges) {
    const from = bySymbol.get(symbolById.get(edge.from) ?? '');
    const to = bySymbol.get(symbolById.get(edge.to) ?? '');
    if (!from || !to || from === to) continue;
    graphEdges.push({ from, to, strength: 'strong', reason: edge.type });
  }
  const byFile = new Map<string, string[]>();
  for (const node of nodes) byFile.set(node.change.file, [...(byFile.get(node.change.file) ?? []), node.change.id]);
  for (const ids of byFile.values()) {
    for (let index = 1; index < ids.length; index++) {
      graphEdges.push({ from: ids[0], to: ids[index], strength: 'weak', reason: 'same file' });
    }
  }
  const uniqueEdges = new Map(graphEdges.map((edge) => [`${edge.from}:${edge.to}:${edge.reason}`, edge]));
  return {
    nodes: [...nodes].sort((left, right) => left.change.id.localeCompare(right.change.id)),
    edges: [...uniqueEdges.values()].sort((left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.reason.localeCompare(right.reason)),
  };
}
