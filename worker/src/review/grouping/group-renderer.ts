import type { BehaviorGroup, ChangeGraph } from './types.js';
import { CONTEXT_FILE_LIMIT, CONTEXT_SYMBOL_LIMIT } from '../semantic-diff/context-loader.js';

interface HunkLike {
  header: string;
  lines: string[];
  evidence?: { newStart?: number; oldStart?: number };
}

type Sources = Record<string, { oldSource?: string; newSource?: string }>;

export function renderGroupContext(input: {
  group: BehaviorGroup;
  graph: ChangeGraph;
  sources: Sources;
  maxCharacters: number;
  contextExclude?: RegExp[];
}): { text: string; files: string[] } {
  const ids = new Set(input.group.changes.map(change => change.id));
  const exclude = input.contextExclude ?? [];
  const isExcluded = (path: string) => exclude.some(pattern => pattern.test(path));
  const dependencies = (input.graph.contextNodes ?? []).filter(node => node.changeIds.some(id => ids.has(id)));
  const adjacent = new Set(input.graph.edges.filter(edge => edge.strength === 'strong' && (ids.has(edge.from) !== ids.has(edge.to)))
    .map(edge => ids.has(edge.from) ? edge.to : edge.from));
  const neighbors = input.graph.nodes.filter(node => adjacent.has(node.change.id)).flatMap(node => node.entity ? [node.entity] : []);
  const entities = input.graph.nodes.filter(node => ids.has(node.change.id)).flatMap(node => node.entity ? [node.entity] : []);
  const symbols = [...new Map([...dependencies.map(node => node.symbol), ...neighbors, ...entities].map(symbol => [symbol.id, symbol])).values()];
  const sections: string[] = [];
  const files = new Set<string>();
  let used = 0;
  for (const symbol of symbols) {
    if (isExcluded(symbol.path)) continue;
    const source = input.sources[symbol.path];
    const side = symbol.commitSha === input.graph.baseSha ? 'base' : 'head';
    const content = side === 'base' ? source?.oldSource : source?.newSource;
    if (sections.length >= CONTEXT_SYMBOL_LIMIT) break;
    if (!content || files.size >= CONTEXT_FILE_LIMIT && !files.has(symbol.path)) continue;
    const body = content.split(/\r?\n/).slice(symbol.startLine - 1, symbol.endLine)
      .map((line, index) => `${symbol.startLine + index}: ${line}`).join('\n');
    const section = `CONTEXT_FILE: ${symbol.path}\nCONTEXT_SYMBOL: ${symbol.qualifiedName}\nSIDE: ${side}\n--- This is unchanged dependency context, not changed code ---\n${body}`;
    if (used + section.length + 2 > input.maxCharacters) continue;
    sections.push(section);
    files.add(symbol.path);
    used += section.length + 2;
  }
  return { text: sections.join('\n\n'), files: [...files].sort() };
}

export function renderBehaviorGroup(input: {
  group: BehaviorGroup;
  graph: ChangeGraph;
  hunks: Map<string, HunkLike>;
  sources?: Sources;
  maxCharacters?: number;
  contextExclude?: RegExp[];
}): string {
  const { group, graph, hunks, sources = {} } = input;
  const ids = new Set(group.changes.map((change) => change.id));
  const relationships = graph.edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.strength === 'strong')
    .map((edge) => `${edge.from} -> ${edge.to}: ${edge.reason}`)
    .sort();
  const sections = [...new Map(group.changes.map(change => [change.evidence.patchHash, change])).values()].map((change) => {
    const hunk = hunks.get(change.evidence.patchHash);
    const symbols = group.changes.filter(item => item.evidence.patchHash === change.evidence.patchHash)
      .map(item => item.symbol ?? 'hunk fallback').join(', ');
    return [
      `CHANGED_EVIDENCE: ${change.id}`,
      `FILE: ${change.file}`,
      `SYMBOL: ${symbols}`,
      `CONFIDENCE: ${change.confidence}`,
      `SIGNATURE: ${change.symbol ?? 'unresolved'}`,
      hunk ? hunk.header : '',
      ...(hunk?.lines ?? []),
    ].filter(Boolean).join('\n');
  });
  const evidence = [
    `BEHAVIOR_GROUP: ${group.id}`,
    `ANCHOR: ${group.anchor}`,
    `GROUP_CONFIDENCE: ${group.confidence}`,
    group.riskSignals.length > 0 ? `RISKS: ${group.riskSignals.join(', ')}` : '',
    relationships.length > 0 ? `RELATIONSHIPS:\n${relationships.join('\n')}` : '',
    'CHANGED_EVIDENCE_SECTIONS:',
    ...sections,
  ].filter(Boolean).join('\n');
  const context = renderGroupContext({ group, graph, sources,
    maxCharacters: Math.max(0, (input.maxCharacters ?? Infinity) - evidence.length - 32),
    contextExclude: input.contextExclude });
  return `${evidence}\nUNCHANGED_CONTEXT_SECTIONS: ${context.text ? `\n${context.text}` : 'none'}`;
}
