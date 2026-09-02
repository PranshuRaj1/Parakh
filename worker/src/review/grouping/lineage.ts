import type { BehaviorGroup, GroupLineage } from './types.js';

export function buildLineage(previous: BehaviorGroup[], current: BehaviorGroup[]): GroupLineage[] {
  const result: GroupLineage[] = [];
  for (const parent of previous) {
    const parentIds = new Set(parent.changes.map((change) => change.id));
    for (const child of current) {
      const overlap = child.changes.map((change) => change.id).filter((id) => parentIds.has(id)).sort();
      const childIds = new Set(child.changes.map((change) => change.id));
      if (overlap.length === 0 && parent.changes.length === child.changes.length) continue;
      if (overlap.length === parent.changes.length && overlap.length === childIds.size) continue;
      result.push({ parentId: parent.id, childId: child.id, overlap });
    }
  }
  return result.sort((left, right) => left.parentId.localeCompare(right.parentId) || left.childId.localeCompare(right.childId));
}
