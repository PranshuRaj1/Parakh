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

function split(ids: string[], graph: ChangeGraph): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < ids.length; index += MAX_SYMBOLS) result.push(ids.slice(index, index + MAX_SYMBOLS));
  return result.length > 0 ? result : [[]];
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
  for (const component of components(graph)) {
    for (const ids of split(component, graph)) {
      const nodes = ids.map((id) => byId.get(id)!).filter(Boolean);
      const changes = nodes.map((node) => node.change);
      const lowCount = changes.filter((change) => change.confidence === 'low').length;
      const demotionReason = changes.length > 0 && lowCount / changes.length > LOW_CONFIDENCE_LIMIT
        ? `more than 25% low-confidence changes (${lowCount}/${changes.length})`
        : undefined;
      const edges = graph.edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to));
      const group: BehaviorGroup = {
        id: groupId(repository, changes),
        anchor: canonicalAnchor(changes),
        changes: [...changes].sort((left, right) => left.file.localeCompare(right.file) || left.id.localeCompare(right.id)),
        context: [],
        riskSignals: risks(nodes),
        confidence: confidence(nodes),
        ...(demotionReason ? { demotionReason } : {}),
      };
      if (edges.length > MAX_EDGES) group.context.push(`graph truncated at ${MAX_EDGES} edges`);
      groups.push(group);
    }
  }
  return groups.sort((left, right) => left.id.localeCompare(right.id));
}
