import { describe, expect, it } from 'vitest';
import type { ConventionRule } from '@parakh/shared';
import {
  capConventionRules,
  MAX_CONVENTION_CHARS,
  parseConventionRules,
} from './parser.js';

function bodies(rules: ConventionRule[]): string[] {
  return rules.map((r) => r.body);
}

describe('parseConventionRules', () => {
  it('turns bullets into discrete rules with stable ids and normal priority', () => {
    const rules = parseConventionRules('AGENTS.md', [
      '# Conventions',
      '',
      '- Use pnpm db:push instead of migrations',
      '- Name test files after the module they cover',
    ].join('\n'));

    expect(bodies(rules)).toEqual([
      'Conventions: Use pnpm db:push instead of migrations',
      'Conventions: Name test files after the module they cover',
    ]);
    expect(rules.map((r) => r.id)).toEqual(['conv:agents-md:1', 'conv:agents-md:2']);
    expect(rules.every((r) => r.priority === 'normal' && r.kind === 'standard')).toBe(true);
    expect(rules.every((r) => r.sourceFile === 'AGENTS.md')).toBe(true);
  });

  it('classifies never-flag phrasing as instruction kind', () => {
    const rules = parseConventionRules('.parakh/rules.md', '- Never flag missing EOF newlines');
    expect(rules[0].kind).toBe('instruction');
  });

  it('strips auto-generated agent-rule blocks before parsing', () => {
    const markdown = [
      '# Real conventions',
      '',
      '- keep handlers thin',
      '',
      '<!-- BEGIN:nextjs-agent-rules -->',
      'This is NOT the Next.js you know',
      '<!-- END:nextjs-agent-rules -->',
      '',
      '- second real rule',
    ].join('\n');

    expect(bodies(parseConventionRules('AGENTS.md', markdown))).toEqual([
      'Real conventions: keep handlers thin',
      'Real conventions: second real rule',
    ]);
  });

  it('applies front-matter priority and scope to every rule in the file', () => {
    const markdown = [
      '---',
      'priority: high',
      'scope: worker/src/**, shared/src/**',
      '---',
      '',
      '- one argument per function',
    ].join('\n');

    const [rule] = parseConventionRules('CLAUDE.md', markdown);
    expect(rule.priority).toBe('high');
    expect(rule.scope).toEqual({ include: ['worker/src/**', 'shared/src/**'] });
    expect(rule.id).toBe('conv:claude-md:1');
  });

  it('collapses prose paragraphs under a heading into single rules', () => {
    const markdown = ['# Database workflow', '', 'We do pnpm db:push for schema changes.', 'Migrations are not used.'].join('\n');
    expect(bodies(parseConventionRules('AGENTS.md', markdown))).toEqual([
      'Database workflow: We do pnpm db:push for schema changes. Migrations are not used.',
    ]);
  });

  it('skips fenced code blocks entirely', () => {
    const markdown = ['- real rule', '', '```ts', 'const x = code example line;', '```', '', '- another rule'].join('\n');
    expect(bodies(parseConventionRules('AGENTS.md', markdown))).toEqual(['real rule', 'another rule']);
  });

  it('joins indented continuation lines into the preceding bullet rule', () => {
    const markdown = [
      '- Use pnpm db:push',
      '  for all schema changes',
      '- second standalone rule',
    ].join('\n');

    expect(bodies(parseConventionRules('AGENTS.md', markdown))).toEqual([
      'Use pnpm db:push for all schema changes',
      'second standalone rule',
    ]);
    expect(parseConventionRules('AGENTS.md', markdown)).toHaveLength(2);
  });

  it('does not attach continuation lines to a rule from before a blank line or heading', () => {
    const markdown = ['- first rule', '', 'standalone prose sentence here'].join('\n');
    expect(bodies(parseConventionRules('AGENTS.md', markdown))).toEqual([
      'first rule',
      'standalone prose sentence here',
    ]);
  });

  it('recognizes headings indented by up to three spaces per CommonMark', () => {
    const markdown = [' ##  Setup steps', '', '- run the setup script'].join('\n');
    expect(bodies(parseConventionRules('AGENTS.md', markdown))).toEqual([
      'Setup steps: run the setup script',
    ]);
  });

  it('still finds front matter after leading whitespace left by a stripped generated block', () => {
    const markdown = [
      '<!-- BEGIN:nextjs-agent-rules -->',
      'machine text',
      '<!-- END:nextjs-agent-rules -->',
      '---',
      'priority: high',
      '---',
      '',
      '- scoped high-priority rule',
    ].join('\n');

    const [rule] = parseConventionRules('AGENTS.md', markdown);
    expect(rule.priority).toBe('high');
  });

  it('ignores checkbox state — both checked and unchecked items are conventions', () => {
    const rules = parseConventionRules('.parakh/rules.md', '- [x] always use zod\n- [ ] skip any-type imports');
    expect(bodies(rules)).toEqual(['always use zod', 'skip any-type imports']);
  });

  it('produces no rules from empty input or sub-minimal fragments', () => {
    expect(parseConventionRules('AGENTS.md', '')).toEqual([]);
    expect(parseConventionRules('AGENTS.md', '# Title only\n- ok')).toEqual([]);
    expect(parseConventionRules('AGENTS.md', '# Title only\n- no any')).toHaveLength(1);
  });
});

describe('capConventionRules', () => {
  function rule(body: string): ConventionRule {
    return {
      id: `conv:x:${body.length}`,
      body,
      priority: 'normal',
      kind: 'standard',
      scope: {},
      sourceFile: 'AGENTS.md',
    };
  }

  it('keeps whole rules until the budget is exceeded and reports truncation', () => {
    const half = 'a'.repeat(MAX_CONVENTION_CHARS / 2);
    const result = capConventionRules([rule(half), rule(half), rule(half)]);

    expect(result.kept).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('is deterministic and keeps everything under budget', () => {
    const rules = [rule('short'), rule('also short')];
    expect(capConventionRules(rules)).toEqual({ kept: rules, truncated: false });
    expect(capConventionRules(rules)).toEqual(capConventionRules(rules));
  });
});
