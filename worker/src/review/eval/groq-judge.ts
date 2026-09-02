import type { JudgeTransport } from './judge.js';
import type { JudgeVerdict } from './types.js';

export const DEFAULT_EVAL_JUDGE_MODEL = 'openai/gpt-oss-120b';

const verdictSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    defectExists: { type: 'boolean' },
    matchedDefectId: { type: ['string', 'null'] },
    correctness: { type: 'integer', enum: [0, 1, 2] },
    localization: { type: 'integer', enum: [0, 1, 2] },
    actionability: { type: 'integer', enum: [0, 1, 2] },
    unsupportedClaim: { type: 'boolean' },
    evidenceQuote: { type: 'string' },
    reason: { type: 'string' },
  },
  required: [
    'defectExists',
    'matchedDefectId',
    'correctness',
    'localization',
    'actionability',
    'unsupportedClaim',
    'evidenceQuote',
    'reason',
  ],
} as const;

type VerdictBody = Omit<JudgeVerdict, 'judgeModel' | 'judgeTier'>;

function parseVerdict(content: string): VerdictBody {
  const value = JSON.parse(content) as Partial<VerdictBody>;
  const score = (candidate: unknown): candidate is 0 | 1 | 2 =>
    candidate === 0 || candidate === 1 || candidate === 2;
  if (
    typeof value.defectExists !== 'boolean'
    || !(typeof value.matchedDefectId === 'string' || value.matchedDefectId === null)
    || !score(value.correctness)
    || !score(value.localization)
    || !score(value.actionability)
    || typeof value.unsupportedClaim !== 'boolean'
    || typeof value.evidenceQuote !== 'string'
    || typeof value.reason !== 'string'
  ) {
    throw new Error('Groq judge returned an invalid verdict');
  }
  return value as VerdictBody;
}

export class GroqJudgeTransport implements JudgeTransport {
  readonly tier = 'free' as const;
  private nextRequestAt = 0;

  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_EVAL_JUDGE_MODEL,
    private readonly request: typeof fetch = fetch,
    private readonly minIntervalMs = 2_000
  ) {}

  async judge(prompt: string): Promise<VerdictBody> {
    for (let attempt = 0; ; attempt++) {
      const waitMs = this.nextRequestAt - Date.now();
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.nextRequestAt = Date.now() + this.minIntervalMs;
      const response = await this.request(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.1,
            messages: [{ role: 'user', content: prompt }],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'pr_review_judge_verdict',
                strict: true,
                schema: verdictSchema,
              },
            },
          }),
        }
      );
      if (response.status === 429 && attempt < 10) {
        const body = await response.text().catch(() => '');
        const retryAfterMs = retryDelayMsFrom(body, response.headers);
        if (retryAfterMs > 0 && retryAfterMs <= 5 * 60_000) {
          this.nextRequestAt = Date.now() + Math.max(retryAfterMs, 1_000);
          continue;
        }
        throw new Error(
          `Groq judge failed with status ${response.status}: ${body.slice(0, 400)}`
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Groq judge failed with status ${response.status}: ${body.slice(0, 400)}`
        );
      }

      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('Groq judge returned no content');
      return parseVerdict(content);
    }
  }
}

function retryDelayMsFrom(body: string, headers: Headers): number {
  const header = headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const match = body.match(/try again in ([\d.]+)s/);
  if (match) return Number(match[1]) * 1000;
  return 0;
}
