import { describe, expect, it } from 'vitest';
import { buildIntentPrompt, buildRuleModePrompt, buildReviewPrompt, buildRelationshipPrompt } from './prompts.js';

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

describe('buildRuleModePrompt', () => {
  it('describes enforce vs suppress modes and pattern extraction', () => {
    const prompt = buildRuleModePrompt('never flag EOF newline issues');

    expect(prompt).toContain('enforce');
    expect(prompt).toContain('suppress');
    expect(prompt).toContain('never/don\'t/stop flagging X');
    expect(prompt).toContain('end of the file');
    expect(prompt).toContain('{"mode": "enforce" or "suppress", "patterns": ["..."]}');
  });

  it('embeds the rule body being classified', () => {
    expect(buildRuleModePrompt('Use snake_case for DB columns')).toContain('Use snake_case for DB columns');
  });
});

describe('buildReviewPrompt', () => {
  it('instructs the model not to flag EOF-newline and style nits', () => {
    const prompt = buildReviewPrompt('src/a.ts', 'diff', []);

    expect(prompt).toContain('Missing newline at the end of a file');
    expect(prompt).toContain('Trailing whitespace or trailing commas');
    expect(prompt).toContain('When in doubt, do not report it');
  });

  it('forbids inventing violations against rules not in the list', () => {
    const prompt = buildReviewPrompt(
      'src/a.ts',
      'diff',
      [
        { id: 'rule-2', body: 'Use camelCase', priority: 'normal', mode: 'enforce' },
      ] as never
    );

    // The prompt renders whatever rules it is handed; mode filtering (suppress
    // rules never reach the LLM) happens in review.ts before reviewDiff.
    expect(prompt).toContain('rule-2');
    expect(prompt).toContain('never reference a rule that is not in this list');
  });
});

describe('buildRelationshipPrompt', () => {
  it('renders both rule bodies so the classifier can compare them', () => {
    const prompt = buildRelationshipPrompt(
      { body: 'Use Zustand for state management' },
      { body: 'Use Redux for state management' }
    );

    expect(prompt).toContain('Use Zustand for state management');
    expect(prompt).toContain('Use Redux for state management');
  });

  it('defines all four relationship types for the contradiction engine', () => {
    const prompt = buildRelationshipPrompt({ body: 'A' }, { body: 'B' });

    expect(prompt).toContain('**DUPLICATE**');
    expect(prompt).toContain('**REFINEMENT**');
    expect(prompt).toContain('**CONTRADICTION**');
    expect(prompt).toContain('**UNRELATED**');
    expect(prompt).toContain('mutually exclusive');
  });
});
