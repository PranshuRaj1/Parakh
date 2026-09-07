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

  it('preserves the complete daily quota response', async () => {
    const body = JSON.stringify({ error: {
      message: `Rate limit reached for model \`openai/gpt-oss-120b\` in organization \`org_test\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 198968, Requested 1200. Please try again in 86400s. Full diagnostic tail.`,
    } });
    const request = vi.fn().mockResolvedValue(new Response(body, { status: 429 }));
    const judge = new GroqJudgeTransport('secret', undefined, request, 0);
    await expect(judge.judge('prompt')).rejects.toThrow(body);
  });

  it('backs off and retries on a TPM rate limit with a delay hint', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'Rate limit reached for model `x` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 1200. Please try again in 2.00s.',
          type: 'tokens',
          code: 'rate_limit_exceeded',
        },
      }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              defectExists: true,
              matchedDefectId: null,
              correctness: 1,
              localization: 1,
              actionability: 1,
              unsupportedClaim: false,
              evidenceQuote: 'code',
              reason: 'reason',
            }),
          },
        }],
      }), { status: 200 }));
    const judge = new GroqJudgeTransport('secret', undefined, request, 0);
    const verdict = await judge.judge('prompt');

    expect(request).toHaveBeenCalledTimes(2);
    expect(verdict.correctness).toBe(1);
  });

  it('rotates to the next Groq key before waiting on a rate limit', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'TPD limit, try again in 1500s.' } }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          defectExists: true,
          matchedDefectId: null,
          correctness: 1,
          localization: 1,
          actionability: 1,
          unsupportedClaim: false,
          evidenceQuote: 'code',
          reason: 'reason',
        }) } }],
      }), { status: 200 }));
    const judge = new GroqJudgeTransport(['first-account', 'second-account'], undefined, request, 0);
    await judge.judge('prompt');

    expect((request.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer first-account' });
    expect((request.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer second-account' });
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

  it('converts a schema-validation generation failure into an unsupported verdict', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'json_validate_failed',
        message: 'Generated JSON does not match the expected schema.',
        failed_generation: '{"defectExists":true}',
      },
    }), { status: 400 }));
    const judge = new GroqJudgeTransport('secret', undefined, request, 0);

    await expect(judge.judge('prompt')).resolves.toMatchObject({
      defectExists: false,
      matchedDefectId: null,
      correctness: 0,
      localization: 0,
      actionability: 0,
      unsupportedClaim: true,
      evidenceQuote: '',
      reason: 'Groq judge could not produce a schema-valid verdict.',
    });
    const init = request.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.response_format.json_schema.schema.required).toContain('reason');
  });
});
