import type { ChangeGraph, ChangeGraphNode, BehaviorGroup } from './types.js';
import { groupId, canonicalAnchor } from './group-id.js';

const MAX_SYMBOLS = 40;
const MAX_EDGES = 80;
const LOW_CONFIDENCE_LIMIT = 0.25;

function components(graph: ChangeGraph): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) adjacency.set(node.change.id, new Set());
  for (const edge of graph.edges) {
    if (edge.strength !== 'strong') continue;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const node of graph.nodes) {
    if (seen.has(node.change.id)) continue;
    const pending = [node.change.id];
    const component: string[] = [];
    seen.add(node.change.id);
    while (pending.length > 0) {
      const current = pending.shift()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(next);
      }
    }
    result.push(component.sort());
  }
  return result;
}

function split<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += MAX_SYMBOLS) {
    result.push(items.slice(index, index + MAX_SYMBOLS));
  }
  return result;
}

function splitComponent(ids: string[], graph: ChangeGraph): string[][] {
  const remaining = new Set(ids);
  const neighbors = new Map<string, Set<string>>();
  for (const id of ids) neighbors.set(id, new Set());
  for (const edge of graph.edges) {
    if (edge.strength !== 'strong' || !remaining.has(edge.from) || !remaining.has(edge.to)) continue;
    neighbors.get(edge.from)?.add(edge.to);
    neighbors.get(edge.to)?.add(edge.from);
  }
  const result: string[][] = [];
  while (remaining.size > 0) {
    const seed = [...remaining].sort((left, right) =>
      (neighbors.get(right)?.size ?? 0) - (neighbors.get(left)?.size ?? 0)
      || left.localeCompare(right))[0];
    const selected = new Set<string>([seed]);
    const pending = [seed];
    remaining.delete(seed);
    while (pending.length > 0 && selected.size < MAX_SYMBOLS) {
      const current = pending.shift()!;
      const next = [...(neighbors.get(current) ?? [])]
        .filter((id) => remaining.has(id))
        .sort((left, right) =>
          (neighbors.get(right)?.size ?? 0) - (neighbors.get(left)?.size ?? 0)
          || left.localeCompare(right));
      for (const id of next) {
        if (selected.size >= MAX_SYMBOLS) break;
        selected.add(id);
        remaining.delete(id);
        pending.push(id);
      }
    }
    result.push([...selected].sort());
  }
  return result;
}

function confidence(nodes: ChangeGraphNode[]): BehaviorGroup['confidence'] {
  if (nodes.some((node) => node.change.confidence === 'low')) return 'medium';
  if (nodes.some((node) => node.change.confidence === 'medium')) return 'medium';
  return 'high';
}

function risks(nodes: ChangeGraphNode[]): string[] {
  const risks = new Set<string>();
  for (const node of nodes) {
    if (node.change.symbol?.match(/#(?:route|auth|schema|config|migration)/i)) risks.add('sensitive symbol changed');
    if (node.change.file.match(/(?:route|auth|schema|migration|config)/i)) risks.add('sensitive boundary changed');
  }
  return [...risks].sort();
}

export function buildBehaviorGroups(repository: string, graph: ChangeGraph): BehaviorGroup[] {
  const byId = new Map(graph.nodes.map((node) => [node.change.id, node]));
  const groups: BehaviorGroup[] = [];
  const fallbackByFile = new Map<string, ChangeGraphNode[]>();

  const createGroup = (
    nodes: ChangeGraphNode[],
    demotionReason?: string,
  ): BehaviorGroup => {
    const changes = nodes.map((node) => node.change);
    const ids = new Set(changes.map((change) => change.id));
    const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return {
      id: groupId(repository, changes),
      anchor: canonicalAnchor(changes),
      changes: [...changes].sort((left, right) => left.file.localeCompare(right.file) || left.id.localeCompare(right.id)),
      context: edges.length > MAX_EDGES ? [`graph truncated at ${MAX_EDGES} edges`] : [],
      riskSignals: risks(nodes),
      confidence: confidence(nodes),
      ...(demotionReason ? { demotionReason } : {}),
    };
  };

  for (const component of components(graph)) {
    const nodes = component.map((id) => byId.get(id)).filter((node): node is ChangeGraphNode => Boolean(node));
    for (const ids of splitComponent(component, graph)) {
      const partition = ids.map((id) => byId.get(id)).filter((node): node is ChangeGraphNode => Boolean(node));
      const low = partition.filter((node) => node.change.confidence === 'low');
      if (low.length / partition.length > LOW_CONFIDENCE_LIMIT) {
        const reliable = partition.filter((node) => node.change.confidence !== 'low');
        if (reliable.length > 0) groups.push(createGroup(reliable));
        for (const node of low) {
          fallbackByFile.set(node.change.file, [...(fallbackByFile.get(node.change.file) ?? []), node]);
        }
        continue;
      }
      groups.push(createGroup(partition));
    }
  }

  for (const file of [...fallbackByFile.keys()].sort()) {
    const nodes = fallbackByFile.get(file)!;
    nodes.sort((left, right) =>
      (left.change.evidence.newStart ?? left.change.evidence.oldStart ?? 0)
      - (right.change.evidence.newStart ?? right.change.evidence.oldStart ?? 0)
      || left.change.id.localeCompare(right.change.id));
    for (const chunk of split(nodes)) {
      groups.push(createGroup(chunk, 'file fallback: low-confidence changes'));
    }
  }

  const expected = new Set(graph.nodes.map((node) => node.change.id));
  const assigned = groups.flatMap((group) => group.changes.map((change) => change.id));
  if (assigned.length !== expected.size || new Set(assigned).size !== expected.size
    || assigned.some((id) => !expected.has(id))) {
    throw new Error('Behavior grouping must assign every change exactly once');
  }

  return groups.sort((left, right) => left.id.localeCompare(right.id));
}
