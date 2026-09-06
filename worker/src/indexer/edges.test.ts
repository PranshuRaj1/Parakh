import { describe, expect, it } from 'vitest';
import { buildRepositoryIndex } from './repository-index.js';

describe('index edges', () => {
  it('keeps imported Java contracts referenced as types rather than function calls', () => {
    const index = buildRepositoryIndex('acme/app', 'head', {
      'src/main/java/app/Service.java': 'package app;\nimport app.Group;\npublic class Service {\n  public Group get() { return null; }\n}',
      'src/main/java/app/Group.java': 'package app;\npublic interface Group {\n  String getId();\n}',
    });
    const caller = index.symbols.find(symbol => symbol.qualifiedName.endsWith('#get'))!;
    const target = index.symbols.find(symbol => symbol.qualifiedName.endsWith('#Group'))!;
    expect(index.edges).toContainEqual({ from: caller.id, to: target.id, type: 'references' });
  });

  it('resolves calls to the imported module when symbol names collide', () => {
    const index = buildRepositoryIndex('acme/app', 'head', {
      'src/reminders.ts': 'export async function removeReminder(id: number) { return id; }',
      'src/booking.ts': "import { removeReminder } from './reminders';\nexport async function cancel(id: number) { removeReminder(id); }",
      'src/other.ts': 'export async function removeReminder(id: number) { return id + 1; }',
    });
    const cancel = index.symbols.find((symbol) => symbol.qualifiedName === 'src/booking.ts#cancel')!;
    const reminder = index.symbols.find((symbol) => symbol.qualifiedName === 'src/reminders.ts#removeReminder')!;
    const other = index.symbols.find((symbol) => symbol.qualifiedName === 'src/other.ts#removeReminder')!;

    expect(index.edges).toContainEqual({ from: cancel.id, to: reminder.id, type: 'calls' });
    expect(index.edges).not.toContainEqual({ from: cancel.id, to: other.id, type: 'calls' });
  });
});
