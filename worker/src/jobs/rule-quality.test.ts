import { describe, expect, it } from 'vitest';
import { assessRuleBody, isInstructionRule } from './rule-quality.js';

describe('assessRuleBody', () => {
  it('rejects the production hex-coding chat one-liner', () => {
    const result = assessRuleBody('we use hex coding so remember that');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('dismissal');
    expect(result.reason).toBe('rebuttal_or_chat_text');
  });

  it('rejects the cron rebuttal (multi-paragraph, chat framing)', () => {
    const body = [
      'remember this — the DATABASE_URL is only read once at module load, not per request.',
      'The cron job sets it before any worker runs, and the timeout is global.',
      'The actual failure had nothing to do with what you flagged, so please look closer.',
    ].join('\n');
    const result = assessRuleBody(body);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rebuttal_or_chat_text');
  });

  it('rejects the queue-handler rebuttal (path:line reference + pasted code)', () => {
    const body = [
      'remember this — Not true as stated. Look at the actual scope (queue-handler.ts:22-52):',
      '',
      '    const handler = (payload) => {',
      '      routes[payload.type](payload)',
      '    }',
      '',
      'Nothing in that scope touches the token cache.',
    ].join('\n');
    const result = assessRuleBody(body);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rebuttal_or_chat_text');
  });

  it('rejects a body that is only a path:line reference', () => {
    const result = assessRuleBody('the real problem is in queue-handler.ts:22-52');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('line_reference_not_standard');
  });

  it('rejects pasted code blocks (backticks and 4-space indentation)', () => {
    expect(assessRuleBody('Use JSON like this:\n```json\n{"a": 1}\n```').ok).toBe(false);
    expect(assessRuleBody('Always fetch tokens like this:\n    const token = await getToken()').ok).toBe(false);
  });

  it('rejects "remember this" framing even when otherwise plausible', () => {
    expect(assessRuleBody('remember this: we use snake_case for DB columns').ok).toBe(false);
  });

  it('rejects "not true as stated" rebuttals', () => {
    expect(assessRuleBody('not true as stated — the handler never runs on that path').ok).toBe(false);
  });

  it('rejects bot-directed meta-instructions', () => {
    for (const body of [
      'verify before reporting findings',
      'ground your claims in the actual code',
      "don't hallucinate issues",
      'stop making things up',
      'check the actual file before flagging',
    ]) {
      const result = assessRuleBody(body);
      expect(result.ok).toBe(false, body);
      expect(result.reason).toBe('bot_directed_meta');
    }
  });

  it('rejects multi-sentence / long bodies that are not a single standard', () => {
    const result = assessRuleBody(
      'This is one thing we should do. And here is a second thing. And here is a third thing, so watch out.'
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('multi_sentence');
  });

  it('rejects empty bodies', () => {
    const result = assessRuleBody('   ');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('accepts "Always validate untrusted input before using it" as a standard', () => {
    const result = assessRuleBody('Always validate untrusted input before using it');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('standard');
  });

  it('accepts "Use snake_case for database columns" as a standard', () => {
    const result = assessRuleBody('Use snake_case for database columns');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('standard');
  });

  it('accepts the CF_API_TOKEN convention rule', () => {
    const result = assessRuleBody('we use CF_API_TOKEN, CF_ACCOUNT_ID as secret names just for convention');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('standard');
  });

  it('accepts a legitimate suppression directive as kind=instruction', () => {
    const result = assessRuleBody('Never flag EOF newline issues in future reviews');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('instruction');
  });

  it('strips a leading @parakh command prefix before assessing', () => {
    const result = assessRuleBody('@parakh verify: Please stop flagging "No newline at the end of the file"');
    expect(result.ok).toBe(true);
    expect(result.kind).toBe('instruction');
    expect(result.body).toBe('stop flagging "No newline at the end of the file"');
  });
});

describe('isInstructionRule', () => {
  it('detects suppression phrasing', () => {
    expect(isInstructionRule('stop flagging EOF newlines')).toBe(true);
    expect(isInstructionRule('do not raise unbounded loops in future reviews')).toBe(true);
    expect(isInstructionRule('never flag X in any future review')).toBe(true);
  });

  it('treats plain standards as non-instructions', () => {
    expect(isInstructionRule('use snake_case for database columns')).toBe(false);
    expect(isInstructionRule('always handle promise rejections')).toBe(false);
  });
});