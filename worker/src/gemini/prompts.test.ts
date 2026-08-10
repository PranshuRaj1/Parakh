import { describe, expect, it } from 'vitest';
import { buildIntentPrompt } from './prompts.js';

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
