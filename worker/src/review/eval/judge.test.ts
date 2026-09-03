import { describe, expect, it, vi } from 'vitest';
import { judgeFindingTwice, type JudgeCache, type JudgeTransport } from './judge.js';
import type { JudgeInput, JudgeVerdict } from './types.js';

const input: JudgeInput = {
  caseId: 'case-1',
  goldSetVersion: 'gold-v1',
  judgePromptVersion: 'judge-v1',
  finding: {
    severity: 'HIGH',
    file: 'src/a.ts',
    line: 3,
    body: 'Missing authorization check.',
    suggestion: null,
    rule_id: null,
  },
  defects: [{
    id: 'defect-1',
    caseId: 'case-1',
    claim: 'Authorization is missing.',
    evidence: 'The handler deletes without checking ownership.',
    files: ['src/a.ts'],
    severity: 'HIGH',
    fixCondition: 'Identify the missing ownership check.',
  }],
  codeContext: 'deleteProject(projectId)',
};

function body(
  overrides: Partial<Omit<JudgeVerdict, 'judgeModel' | 'judgeTier'>> = {}
): Omit<JudgeVerdict, 'judgeModel' | 'judgeTier'> {
  return {
    defectExists: true,
    matchedDefectId: 'defect-1',
    correctness: 2,
    localization: 2,
    actionability: 2,
    unsupportedClaim: false,
    evidenceQuote: 'deleteProject(projectId)',
    reason: 'The ownership check is missing.',
    ...overrides,
  };
}

function memoryCache(): JudgeCache {
  const values = new Map<string, [JudgeVerdict, JudgeVerdict]>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, verdicts) => {
      values.set(key, verdicts);
    },
  };
}

function transport(...verdicts: ReturnType<typeof body>[]): JudgeTransport {
  const judge = vi.fn();
  for (const verdict of verdicts) judge.mockResolvedValueOnce(verdict);
  return {
    model: 'openai/gpt-oss-120b',
    tier: 'free',
    judge,
  };
}

describe('judgeFindingTwice', () => {
  it('runs and stores two independent verdicts', async () => {
    const cache = memoryCache();
    const judge = transport(body(), body());
    const result = await judgeFindingTwice(input, judge, cache);

    expect(judge.judge).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('correct');
    expect(result.verdicts[0].judgeModel).toBe('openai/gpt-oss-120b');
    expect(result.cacheHit).toBe(false);
  });

  it('reuses both cached passes without another judge call', async () => {
    const cache = memoryCache();
    await judgeFindingTwice(input, transport(body()), cache);
    const judge = transport(body());
    const result = await judgeFindingTwice(input, judge, cache);

    expect(judge.judge).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
  });

  it('holds judge disagreement for human review', async () => {
    const result = await judgeFindingTwice(
      input,
      transport(body(), body({ correctness: 1 })),
      memoryCache()
    );
    expect(result.outcome).toBe('needs_human_review');
  });

  it('normalizes unsupported-claim-only negative disagreement as incorrect', async () => {
    const result = await judgeFindingTwice(
      input,
      transport(
        body({ defectExists: false, matchedDefectId: null, correctness: 0 }),
        body({ defectExists: false, matchedDefectId: null, correctness: 0, unsupportedClaim: true }),
      ),
      memoryCache()
    );
    expect(result.outcome).toBe('incorrect');
  });

  it('resumes the second pass from a partial cache', async () => {
    const cache = memoryCache();
    const firstJudge = transport(body(), body());
    await judgeFindingTwice(input, firstJudge, cache);
    const secondJudge = transport(body());
    const result = await judgeFindingTwice(input, secondJudge, cache);
    expect(result.cacheHit).toBe(true);
    expect(secondJudge.judge).not.toHaveBeenCalled();
  });

  it('changes the cache key when evidence or gold version changes', async () => {
    const cache = memoryCache();
    const judge = transport(body(), body(), body(), body());
    const first = await judgeFindingTwice(input, judge, cache);
    const second = await judgeFindingTwice(
      { ...input, codeContext: 'different evidence' },
      judge,
      cache
    );
    expect(second.cacheKey).not.toBe(first.cacheKey);
    expect(judge.judge).toHaveBeenCalledTimes(4);
  });
});
