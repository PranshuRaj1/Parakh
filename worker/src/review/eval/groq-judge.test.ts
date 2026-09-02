import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EVAL_JUDGE_MODEL,
  GroqJudgeTransport,
} from './groq-judge.js';

describe('GroqJudgeTransport', () => {
  it('requests strict structured output from the pinned model', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            defectExists: true,
            matchedDefectId: 'defect-1',
            correctness: 2,
            localization: 2,
            actionability: 2,
            unsupportedClaim: false,
            evidenceQuote: 'code',
            reason: 'reason',
          }),
        },
      }],
    }), { status: 200 }));
    const judge = new GroqJudgeTransport('secret', undefined, request, 0);
    const verdict = await judge.judge('prompt');

    const init = request.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.model).toBe(DEFAULT_EVAL_JUDGE_MODEL);
    expect(payload.response_format.json_schema.strict).toBe(true);
    expect(verdict.correctness).toBe(2);
  });

  it('fails without exposing the API response body', async () => {
    const request = vi.fn().mockResolvedValue(new Response('sensitive', {
      status: 429,
    }));
    const judge = new GroqJudgeTransport('secret', undefined, request, 0);
    await expect(judge.judge('prompt')).rejects.toThrow(
      'Groq judge failed with status 429'
    );
  });

  it('rejects malformed structured output', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ correctness: 2 }) } }],
    }), { status: 200 }));
    const judge = new GroqJudgeTransport('secret', undefined, request, 0);
    await expect(judge.judge('prompt')).rejects.toThrow(
      'Groq judge returned an invalid verdict'
    );
  });
});
