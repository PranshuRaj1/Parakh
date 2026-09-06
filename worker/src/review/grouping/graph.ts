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
  const entities = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
  const nodes: ChangeGraphNode[] = changes.map((change) => ({
    change, symbol: symbolName(change.symbol), entity: entities.get(change.symbol ?? ''),
  }));
  const bySymbol = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.symbol) continue;
    bySymbol.set(node.symbol, [...(bySymbol.get(node.symbol) ?? []), node.change.id]);
  }
  for (const ids of bySymbol.values()) ids.sort();
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol.qualifiedName]));
  const graphEdges: ChangeGraphEdge[] = [];
  const contextNodes = new Map<string, NonNullable<ChangeGraph['contextNodes']>[number]>();
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  for (const ids of bySymbol.values()) {
    for (let index = 1; index < ids.length; index++) {
      graphEdges.push({ from: ids[0], to: ids[index], strength: 'strong', reason: 'same symbol' });
    }
  }
  for (const edge of edges) {
    const from = bySymbol.get(symbolById.get(edge.from) ?? '') ?? [];
    const to = bySymbol.get(symbolById.get(edge.to) ?? '') ?? [];
    for (const [changeIds, target] of [[from, edge.to], [to, edge.from]] as const) {
      const indexed = byId.get(target);
      const symbol = indexed && entities.get(indexed.qualifiedName);
      if (!changeIds.length || !symbol || bySymbol.has(symbol.qualifiedName)) continue;
      const previous = contextNodes.get(symbol.qualifiedName);
      contextNodes.set(symbol.qualifiedName, {
        symbol, changeIds: [...new Set([...(previous?.changeIds ?? []), ...changeIds])].sort(), reason: edge.type,
      });
    }
    for (const fromId of from) {
      for (const toId of to) {
        if (fromId !== toId) graphEdges.push({ from: fromId, to: toId, strength: 'strong', reason: edge.type });
      }
    }
  }
  const byFile = new Map<string, string[]>();
  for (const node of nodes) byFile.set(node.change.file, [...(byFile.get(node.change.file) ?? []), node.change.id]);
  for (const ids of byFile.values()) {
    for (let index = 1; index < ids.length; index++) {
      graphEdges.push({ from: ids[0], to: ids[index], strength: 'weak', reason: 'same file' });
    }
  }
  const weakSignals = new Map<string, Set<string>>();
  const pairKey = (left: string, right: string) => [left, right].sort().join('\u0000');
  const addWeakSignal = (left: ChangeGraphNode, right: ChangeGraphNode, reason: string) => {
    const key = pairKey(left.change.id, right.change.id);
    weakSignals.set(key, new Set([...(weakSignals.get(key) ?? []), reason]));
  };
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex++) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (left.change.file === right.change.file) addWeakSignal(left, right, 'same file');
      const leftName = left.symbol?.split('#').pop();
      const rightName = right.symbol?.split('#').pop();
      if (leftName && leftName === rightName) addWeakSignal(left, right, 'matching changed identifier');
      const leftTest = /(?:^|[./_-])(?:test|spec)(?:[./_-]|$)/i.test(left.change.file);
      const rightTest = /(?:^|[./_-])(?:test|spec)(?:[./_-]|$)/i.test(right.change.file);
      if (leftTest !== rightTest && leftName && leftName === rightName) {
        addWeakSignal(left, right, 'implementation and test pairing');
      }
    }
  }
  for (const [key, reasons] of weakSignals) {
    if (reasons.size < 2) continue;
    const [from, to] = key.split('\u0000');
    graphEdges.push({ from, to, strength: 'strong', reason: `corroborated weak signals: ${[...reasons].sort().join(', ')}` });
  }
  const uniqueEdges = new Map(graphEdges.map((edge) => [`${edge.from}:${edge.to}:${edge.reason}`, edge]));
  return {
    contextNodes: [...contextNodes.values()].sort((left, right) => left.symbol.qualifiedName.localeCompare(right.symbol.qualifiedName)),
    nodes: [...nodes].sort((left, right) => left.change.id.localeCompare(right.change.id)),
    edges: [...uniqueEdges.values()].sort((left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.reason.localeCompare(right.reason)),
  };
}
