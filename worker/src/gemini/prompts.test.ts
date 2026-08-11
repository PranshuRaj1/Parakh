import { describe, expect, it } from 'vitest';
import { buildIntentPrompt, buildReviewPrompt } from './prompts.js';
import type { Rule } from '@parakh/shared';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    repo: 'acme/app',
    body: 'some standard',
    embedding: null,
    status: 'ACTIVE',
    scope: {},
    priority: 'normal',
    kind: 'standard',
    supersedes: null,
    superseded_by: null,
    source_pr: null,
    evidence_count: 0,
    reinforcement_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    superseded_at: null,
    ...overrides,
  };
}

describe('buildReviewPrompt', () => {
  it('lists standard rules as enforceable coding rules', () => {
    const prompt = buildReviewPrompt('a.ts', 'diff', [
      rule({ id: 'r2', body: 'always validate input', priority: 'high' }),
    ]);

    expect(prompt).toContain('## Active Coding Rules for This Repository');
    expect(prompt).toContain('**[r2]** (priority: high): always validate input');
    expect(prompt).not.toContain('## Suppressed Issues');
  });

  it('renders instruction rules as suppressions, never as enforceable rules', () => {
    const prompt = buildReviewPrompt('a.ts', 'diff', [
      rule({ id: 'r1', kind: 'instruction', body: 'never flag "No newline at the end of the file"' }),
      rule({ id: 'r2', body: 'always validate input', priority: 'high' }),
    ]);

    expect(prompt).toContain('## Suppressed Issues');
    expect(prompt).toContain('never flag "No newline at the end of the file"');
    expect(prompt).not.toContain('[r1]');
    expect(prompt).toContain('**[r2]** (priority: high): always validate input');
  });

  it('omits both rule sections when there are no rules at all', () => {
    const prompt = buildReviewPrompt('a.ts', 'diff', []);
    expect(prompt).not.toContain('## Active Coding Rules for This Repository');
    expect(prompt).not.toContain('## Suppressed Issues');
  });
});

describe('buildIntentPrompt', () => {
  it('instructs the classifier that forward-looking standards win over dismissive tone', () => {
    const prompt = buildIntentPrompt(
      '@parakh Please stop flagging "No newline at the end of the file" — this check is useless for me. Do not raise missing-EOF-newline issues in any future review',
      ''
    );

    expect(prompt).toContain('in any future review');
    expect(prompt).toContain('stop flagging X');
    expect(prompt).toContain('never raise X');
    expect(prompt).toContain('Forward-looking standards always win');
  });

  it('keeps bare dismissals as DISMISSAL (no corrective standard)', () => {
    const prompt = buildIntentPrompt('This is useless', '');
    expect(prompt).toContain('"This is useless" alone is DISMISSAL');
    expect(prompt).toContain('stop flagging EOF newlines in future reviews');
  });
});
