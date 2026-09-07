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
  ) {
    throw new Error('Groq judge returned an invalid verdict');
  }
  return {
    ...value,
    reason: typeof value.reason === 'string'
      ? value.reason
      : 'No reason provided by judge.',
  } as VerdictBody;
}

export class GroqJudgeTransport implements JudgeTransport {
  readonly tier = 'free' as const;
  private nextRequestAt = 0;

  constructor(
    apiKey: string | string[],
    readonly model = DEFAULT_EVAL_JUDGE_MODEL,
    private readonly request: typeof fetch = fetch,
    private readonly minIntervalMs = 2_000,
    private readonly maxRetryWaitMs = 5 * 60_000
  ) {
    this.apiKeys = (Array.isArray(apiKey) ? apiKey : apiKey.split(','))
      .map((key) => key.trim())
      .filter(Boolean);
    if (this.apiKeys.length === 0) throw new Error('Groq judge requires at least one API key');
  }

  private readonly apiKeys: string[];
  private keyIndex = 0;

  async judge(prompt: string): Promise<VerdictBody> {
    const attemptedKeys = new Set<number>();
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
            Authorization: `Bearer ${this.apiKeys[this.keyIndex]}`,
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
        attemptedKeys.add(this.keyIndex);
        if (attemptedKeys.size < this.apiKeys.length) {
          this.keyIndex = (this.keyIndex + 1) % this.apiKeys.length;
          this.nextRequestAt = Date.now() + this.minIntervalMs;
          continue;
        }
        if (retryAfterMs > 0 && retryAfterMs <= this.maxRetryWaitMs) {
          attemptedKeys.clear();
          this.nextRequestAt = Date.now() + Math.max(retryAfterMs, 1_000);
          continue;
        }
        if (retryAfterMs > 0) {
          throw new Error(`Groq judge quota wait exceeds retry limit after trying ${this.apiKeys.length} configured key(s); rerun the eval to resume cached passes. ${body}`);
        }
        throw new Error(
          `Groq judge failed with status ${response.status}: ${body.slice(0, 400)}`
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (response.status === 400 && isSchemaValidationFailure(body)) {
          return {
            defectExists: false,
            matchedDefectId: null,
            correctness: 0,
            localization: 0,
            actionability: 0,
            unsupportedClaim: true,
            evidenceQuote: '',
            reason: 'Groq judge could not produce a schema-valid verdict.',
          };
        }
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

function isSchemaValidationFailure(body: string): boolean {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code === 'json_validate_failed';
  } catch {
    return false;
  }
}
