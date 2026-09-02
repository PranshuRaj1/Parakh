import type { SemanticChange } from '../semantic-diff/entity-parser.js';

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

export function canonicalAnchor(changes: SemanticChange[]): string {
  return [...changes].sort((left, right) => left.file.localeCompare(right.file)
    || (left.evidence.newStart ?? left.evidence.oldStart ?? 0) - (right.evidence.newStart ?? right.evidence.oldStart ?? 0)
    || (left.symbol ?? '').localeCompare(right.symbol ?? '')
  )[0]?.symbol ?? changes[0]?.file ?? 'unknown';
}

export function groupId(repository: string, changes: SemanticChange[]): string {
  return `g2:${hash(`${repository}:${canonicalAnchor(changes)}`)}`;
}
