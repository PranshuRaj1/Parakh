import { adjudicateVerdicts } from './adjudication.js';
import type {
  JudgeInput,
  JudgeResult,
  JudgeVerdict,
} from './types.js';

export interface JudgeTransport {
  model: string;
  tier: JudgeVerdict['judgeTier'];
  judge(prompt: string): Promise<Omit<JudgeVerdict, 'judgeModel' | 'judgeTier'>>;
}

export interface JudgeCache {
  get(key: string): Promise<[JudgeVerdict, JudgeVerdict] | null>;
  set(key: string, verdicts: [JudgeVerdict, JudgeVerdict]): Promise<void>;
  getPartial?(key: string): Promise<[JudgeVerdict | null, JudgeVerdict | null] | null>;
  setPartial?(key: string, verdicts: [JudgeVerdict | null, JudgeVerdict | null]): Promise<void>;
}

export function buildJudgePrompt(input: JudgeInput): string {
  return [
    'Evaluate one pull request review finding using only the supplied evidence.',
    'First decide whether the claimed issue exists in the code.',
    'Only if it exists, decide whether it matches one listed gold defect.',
    'Then score correctness, localization, and actionability from 0 to 2.',
    'If the context is insufficient, set unsupportedClaim to true.',
    '',
    `Case: ${input.caseId}`,
    `Finding: ${JSON.stringify(input.finding)}`,
    `Gold defects: ${JSON.stringify(input.defects)}`,
    `Code context:\n${input.codeContext}`,
  ].join('\n');
}

export async function hashJudgeInput(
  input: JudgeInput,
  transport: Pick<JudgeTransport, 'model' | 'tier'>
): Promise<string> {
  const value = JSON.stringify({
    caseId: input.caseId,
    goldSetVersion: input.goldSetVersion,
    judgePromptVersion: input.judgePromptVersion,
    finding: input.finding,
    defects: input.defects,
    codeContext: input.codeContext,
    judgeModel: transport.model,
    judgeTier: transport.tier,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function judgeFindingTwice(
  input: JudgeInput,
  transport: JudgeTransport,
  cache: JudgeCache,
  matchedDefectIds: ReadonlySet<string> = new Set()
): Promise<JudgeResult> {
  const cacheKey = await hashJudgeInput(input, transport);
  const cached = await cache.get(cacheKey);
  if (cached) {
    return {
      cacheKey,
      verdicts: cached,
      outcome: adjudicateVerdicts(cached, matchedDefectIds),
      cacheHit: true,
    };
  }

  const partial = cache.getPartial ? await cache.getPartial(cacheKey) : null;

  const prompt = buildJudgePrompt(input);
  const addMetadata = (
    verdict: Omit<JudgeVerdict, 'judgeModel' | 'judgeTier'>
  ): JudgeVerdict => ({
    ...verdict,
    judgeModel: transport.model,
    judgeTier: transport.tier,
  });
  const first = partial?.[0] ?? addMetadata(await transport.judge(prompt));
  if (!partial?.[0] && cache.setPartial) await cache.setPartial(cacheKey, [first, null]);
  const second = partial?.[1] ?? addMetadata(await transport.judge(prompt));
  const verdicts: [JudgeVerdict, JudgeVerdict] = [first, second];

  await cache.set(cacheKey, verdicts);
  return {
    cacheKey,
    verdicts,
    outcome: adjudicateVerdicts(verdicts, matchedDefectIds),
    cacheHit: false,
  };
}
