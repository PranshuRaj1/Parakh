import type { BehaviorGroup, ChangeGraph } from './types.js';

interface HunkLike {
  header: string;
  lines: string[];
  evidence?: { newStart?: number; oldStart?: number };
}

function sourceWindow(source: string | undefined, start: number | undefined): string {
  if (!source || !start) return '';
  const lines = source.split(/\r?\n/);
  const first = Math.max(0, start - 4);
  const last = Math.min(lines.length, start + 5);
  return lines.slice(first, last).map((line, index) => `${first + index + 1}: ${line}`).join('\n');
}

export function renderBehaviorGroup(input: {
  group: BehaviorGroup;
  graph: ChangeGraph;
  hunks: Map<string, HunkLike>;
  sources?: Record<string, { oldSource?: string; newSource?: string }>;
}): string {
  const { group, graph, hunks, sources = {} } = input;
  const ids = new Set(group.changes.map((change) => change.id));
  const relationships = graph.edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.strength === 'strong')
    .map((edge) => `${edge.from} -> ${edge.to}: ${edge.reason}`)
    .sort();
  const sections = group.changes.map((change) => {
    const hunk = hunks.get(change.evidence.patchHash);
    const source = sources[change.file];
    return [
      `CHANGED_EVIDENCE: ${change.id}`,
      `FILE: ${change.file}`,
      `SYMBOL: ${change.symbol ?? 'hunk fallback'}`,
      `CONFIDENCE: ${change.confidence}`,
      `SIGNATURE: ${change.symbol ?? 'unresolved'}`,
      hunk ? hunk.header : '',
      ...(hunk?.lines ?? []),
      sourceWindow(source?.oldSource, change.evidence.oldStart),
      sourceWindow(source?.newSource, change.evidence.newStart),
    ].filter(Boolean).join('\n');
  });
  return [
    `BEHAVIOR_GROUP: ${group.id}`,
    `ANCHOR: ${group.anchor}`,
    `GROUP_CONFIDENCE: ${group.confidence}`,
    group.riskSignals.length > 0 ? `RISKS: ${group.riskSignals.join(', ')}` : '',
    relationships.length > 0 ? `RELATIONSHIPS:\n${relationships.join('\n')}` : '',
    'CHANGED_EVIDENCE_SECTIONS:',
    ...sections,
    'UNCHANGED_CONTEXT_SECTIONS: none',
  ].filter(Boolean).join('\n');
}
