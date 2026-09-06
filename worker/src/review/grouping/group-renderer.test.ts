import { describe, expect, it } from 'vitest';
import { buildBehaviorGroups } from './group-builder.js';
import { buildChangeGraph } from './graph.js';
import { renderBehaviorGroup } from './group-renderer.js';

describe('renderBehaviorGroup', () => {
  it('renders every changed hunk and separates unchanged context', () => {
    const changes = [
      { id: 'one', file: 'src/api.ts', operation: 'edit' as const, symbol: 'src/api.ts#update', evidence: { file: 'src/api.ts', newStart: 2, oldStart: 2, patchHash: 'one', kind: 'edit' as const }, confidence: 'high' as const, reason: 'exact' },
      { id: 'two', file: 'src/service.ts', operation: 'edit' as const, symbol: 'src/service.ts#save', evidence: { file: 'src/service.ts', newStart: 3, oldStart: 3, patchHash: 'two', kind: 'edit' as const }, confidence: 'high' as const, reason: 'exact' },
    ];
    const symbols = [
      { id: 'a', repo: 'acme/app', commitSha: 'head', path: 'src/api.ts', qualifiedName: changes[0].symbol!, kind: 'function' as const, startLine: 1, endLine: 4, signature: 'update()', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
      { id: 'b', repo: 'acme/app', commitSha: 'head', path: 'src/service.ts', qualifiedName: changes[1].symbol!, kind: 'function' as const, startLine: 1, endLine: 5, signature: 'save()', exported: true, normalizedBody: '', bodyHash: '', imports: [] },
    ];
    const graph = buildChangeGraph(changes, symbols, [{ from: 'a', to: 'b', type: 'calls' }]);
    const group = buildBehaviorGroups('acme/app', graph)[0];
    const rendered = renderBehaviorGroup({
      group,
      graph,
      hunks: new Map([['one', { header: '@@ api', lines: ['-old api', '+new api'] }], ['two', { header: '@@ service', lines: ['-old service', '+new service'] }]]),
      sources: { 'src/api.ts': { newSource: 'line 1\nnew api\nline 3' }, 'src/service.ts': { newSource: 'line 1\nline 2\nnew service' } },
    });
    expect(rendered).toContain('+new api');
    expect(rendered).toContain('+new service');
    expect(rendered).toContain('RELATIONSHIPS:');
    expect(rendered).toContain('CONTEXT_FILE: src/service.ts');
    expect(rendered).toContain('3: new service');
  });
});
