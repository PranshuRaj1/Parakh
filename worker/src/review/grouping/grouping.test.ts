import { describe, expect, it } from 'vitest';
import type { SemanticChange } from '../semantic-diff/entity-parser.js';
import { buildBehaviorGroups } from './group-builder.js';
import { buildChangeGraph } from './graph.js';
import { buildLineage } from './lineage.js';

function change(id: string, file: string, symbol: string | null, confidence: SemanticChange['confidence'] = 'high'): SemanticChange {
  return {
    id,
    file,
    operation: 'edit',
    symbol,
    evidence: { file, newStart: 1, newEnd: 2, patchHash: id, kind: 'edit' },
    confidence,
    reason: 'test',
  };
}

describe('behavior grouping', () => {
  it('groups changed symbols connected by an indexed edge', () => {
    const first = change('one', 'src/api.ts', 'src/api.ts#update');
    const second = change('two', 'src/service.ts', 'src/service.ts#save');
    const graph = buildChangeGraph(
      [first, second],
      [
        { id: 'a', repo: 'acme/app', commitSha: 'head', path: 'src/api.ts', qualifiedName: first.symbol!, kind: 'function', startLine: 1, endLine: 2, signature: '', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
        { id: 'b', repo: 'acme/app', commitSha: 'head', path: 'src/service.ts', qualifiedName: second.symbol!, kind: 'function', startLine: 1, endLine: 2, signature: '', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
      ],
      [{ from: 'a', to: 'b', type: 'calls' }],
    );

    const groups = buildBehaviorGroups('acme/app', graph);
    expect(groups).toHaveLength(1);
    expect(groups[0].changes.map((item) => item.id)).toEqual(['one', 'two']);
    expect(groups[0].confidence).toBe('high');
  });

  it('demotes groups with more than 25 percent low-confidence changes', () => {
    const changes = [
      change('one', 'a.ts', 'a.ts#one', 'high'),
      change('two', 'b.ts', null, 'low'),
      change('three', 'c.ts', null, 'low'),
    ];
    const groups = buildBehaviorGroups('acme/app', buildChangeGraph(changes, [], []));
    expect(groups).toHaveLength(3);
    expect(groups.filter((group) => group.demotionReason)).toHaveLength(2);
  });

  it('combines low-confidence changes from one file into one fallback group', () => {
    const changes = [
      change('one', 'src/buffer.py', null, 'low'),
      change('two', 'src/buffer.py', null, 'low'),
      change('three', 'src/buffer.py', null, 'low'),
    ];
    const groups = buildBehaviorGroups('acme/app', buildChangeGraph(changes, [], []));

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      demotionReason: expect.stringContaining('file fallback'),
    });
    expect(groups[0].changes.map((item) => item.id)).toEqual(['one', 'three', 'two']);
  });

  it('creates one fallback group per file for a demoted cross-file component', () => {
    const first = change('one', 'src/a.py', null, 'low');
    const second = change('two', 'src/b.py', null, 'low');
    const symbols = [
      { id: 'a', repo: 'acme/app', commitSha: 'head', path: 'src/a.py', qualifiedName: 'src/a.py#one', kind: 'function' as const, startLine: 1, endLine: 2, signature: '', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
      { id: 'b', repo: 'acme/app', commitSha: 'head', path: 'src/b.py', qualifiedName: 'src/b.py#two', kind: 'function' as const, startLine: 1, endLine: 2, signature: '', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
    ];
    const groups = buildBehaviorGroups('acme/app', buildChangeGraph(
      [first, second],
      symbols,
      [{ from: 'a', to: 'b', type: 'calls' }],
    ));

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.demotionReason?.includes('file fallback'))).toBe(true);
    expect(groups.flatMap((group) => group.changes.map((item) => item.id)).sort()).toEqual(['one', 'two']);
  });

  it('splits a large fallback file using the existing 40-change limit', () => {
    const changes = Array.from({ length: 45 }, (_, index) =>
      change(`change-${String(index).padStart(2, '0')}`, 'src/buffer.py', null, 'low'));
    const groups = buildBehaviorGroups('acme/app', buildChangeGraph(changes, [], []));

    expect(groups.map((group) => group.changes.length)).toEqual([40, 5]);
    expect(groups.flatMap((group) => group.changes)).toHaveLength(45);
    expect(new Set(groups.flatMap((group) => group.changes.map((item) => item.id))).size).toBe(45);
  });

  it('keeps IDs stable when unrelated changes are added', () => {
    const first = change('one', 'src/api.ts', 'src/api.ts#update');
    const base = buildBehaviorGroups('acme/app', buildChangeGraph([first], [], []))[0];
    const withUnrelated = buildBehaviorGroups('acme/app', buildChangeGraph([
      first,
      change('two', 'docs/readme.md', null),
    ], [], []));
    expect(withUnrelated.find((group) => group.changes.some((item) => item.id === 'one'))?.id).toBe(base.id);
  });

  it('records overlap when a previous group splits', () => {
    const first = change('one', 'a.ts', 'a.ts#one');
    const second = change('two', 'b.ts', 'b.ts#two');
    const symbols = [
      { id: 'a', repo: 'acme/app', commitSha: 'head', path: 'a.ts', qualifiedName: first.symbol!, kind: 'function' as const, startLine: 1, endLine: 2, signature: '', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
      { id: 'b', repo: 'acme/app', commitSha: 'head', path: 'b.ts', qualifiedName: second.symbol!, kind: 'function' as const, startLine: 1, endLine: 2, signature: '', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
    ];
    const previous = buildBehaviorGroups('acme/app', buildChangeGraph([first, second], symbols, [{ from: 'a', to: 'b', type: 'calls' }]));
    const current = [
      buildBehaviorGroups('acme/app', buildChangeGraph([first], [], []))[0],
      buildBehaviorGroups('acme/app', buildChangeGraph([second], [], []))[0],
    ];
    expect(buildLineage(previous, current)).toMatchObject([
      { parentId: previous[0].id, childId: current[0].id, overlap: ['one'] },
      { parentId: previous[0].id, childId: current[1].id, overlap: ['two'] },
    ]);
  });
});
