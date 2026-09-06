import type { IndexedSymbol } from '@parakh/shared';
import type { IndexedEdge } from '../../indexer/edges.js';
import type { SemanticChange } from '../semantic-diff/entity-parser.js';
import type { ChangeGraph, ChangeGraphEdge, ChangeGraphNode } from './types.js';

const MAX_BRIDGE_HOPS = 2;
const MAX_BRIDGE_PAIRS_PER_COMPONENT = 32;
const MAX_BRIDGE_PAIRS_PER_SYMBOL = 8;
const MAX_BRIDGE_PAIRS_TOTAL = 256;

function symbolName(value: string | null): string | null {
  return value?.includes('#') ? value : null;
}

function bridgeEdges(
  nodes: ChangeGraphNode[],
  symbols: IndexedSymbol[],
  edges: IndexedEdge[],
  contextNodes: Map<string, NonNullable<ChangeGraph['contextNodes']>[number]>,
): ChangeGraphEdge[] {
  const changedIds = new Map(nodes.flatMap((node) => node.symbol ? [[node.symbol, node.change.id] as const] : []));
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const byName = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol.id]));
  const parent = new Map(nodes.map((node) => [node.change.id, node.change.id]));
  const pairCount = new Map<string, number>();
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current || current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return leftRoot;
    parent.set(rightRoot, leftRoot);
    pairCount.set(leftRoot, (pairCount.get(leftRoot) ?? 0) + (pairCount.get(rightRoot) ?? 0));
    pairCount.delete(rightRoot);
    return leftRoot;
  };
  const adjacency = new Map<string, Array<{ id: string; type: string }>>();
  const add = (from: string, to: string, type: string) => {
    adjacency.set(from, [...(adjacency.get(from) ?? []), { id: to, type }]);
  };
  for (const edge of edges) {
    add(edge.from, edge.to, edge.type);
    add(edge.to, edge.from, edge.type);
    const fromChangeId = changedIds.get(byId.get(edge.from)?.qualifiedName ?? '');
    const toChangeId = changedIds.get(byId.get(edge.to)?.qualifiedName ?? '');
    if (fromChangeId && toChangeId && fromChangeId !== toChangeId) union(fromChangeId, toChangeId);
  }

  const result: ChangeGraphEdge[] = [];
  const pairKeys = new Set<string>();
  const pairsByBridge = new Map<string, number>();
  for (const start of nodes) {
    if (!start.symbol) continue;
    const startId = byName.get(start.symbol);
    if (!startId) continue;
    const pending = [{ id: startId, depth: 0, path: new Set([startId]), bridges: [] as string[], types: [] as string[] }];
    while (pending.length > 0 && result.length < MAX_BRIDGE_PAIRS_TOTAL) {
      const current = pending.shift()!;
      for (const next of adjacency.get(current.id) ?? []) {
        if (current.path.has(next.id)) continue;
        const targetChangeId = changedIds.get(byId.get(next.id)?.qualifiedName ?? '');
        const path = new Set([...current.path, next.id]);
        const bridges = targetChangeId ? current.bridges : [...current.bridges, next.id];
        const types = [...current.types, next.type];
        if (targetChangeId && targetChangeId !== start.change.id && bridges.length > 0) {
          const pair = [start.change.id, targetChangeId].sort().join('\u0000');
          const startRoot = find(start.change.id);
          const targetRoot = find(targetChangeId);
          const componentPairs = startRoot === targetRoot
            ? MAX_BRIDGE_PAIRS_PER_COMPONENT
            : (pairCount.get(startRoot) ?? 0) + (pairCount.get(targetRoot) ?? 0) + 1;
          if (!pairKeys.has(pair)
            && startRoot !== targetRoot
            && result.length < MAX_BRIDGE_PAIRS_TOTAL
            && componentPairs <= MAX_BRIDGE_PAIRS_PER_COMPONENT
            && bridges.every((id) => (pairsByBridge.get(id) ?? 0) < MAX_BRIDGE_PAIRS_PER_SYMBOL)) {
            pairKeys.add(pair);
            pairCount.set(union(start.change.id, targetChangeId), componentPairs);
            result.push({
              from: start.change.id,
              to: targetChangeId,
              strength: 'strong',
              reason: `bridge dependency: ${[...new Set(types)].sort().join(', ')}`,
            });
            for (const bridgeId of bridges) {
              pairsByBridge.set(bridgeId, (pairsByBridge.get(bridgeId) ?? 0) + 1);
              const bridge = byId.get(bridgeId);
              if (!bridge) continue;
              const previous = contextNodes.get(bridge.qualifiedName);
              contextNodes.set(bridge.qualifiedName, {
                symbol: bridge,
                changeIds: [...new Set([...(previous?.changeIds ?? []), start.change.id, targetChangeId])].sort(),
                reason: 'bridge dependency',
              });
            }
          }
          continue;
        }
        if (current.depth < MAX_BRIDGE_HOPS && !targetChangeId) {
          pending.push({ id: next.id, depth: current.depth + 1, path, bridges, types });
        }
      }
    }
  }
  return result;
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
  graphEdges.push(...bridgeEdges(nodes, symbols, edges, contextNodes));
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
