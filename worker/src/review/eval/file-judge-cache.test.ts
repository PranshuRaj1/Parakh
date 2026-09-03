import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJudgeCache } from './file-judge-cache.test-helper.js';
import type { JudgeVerdict } from './types.js';

const verdict: JudgeVerdict = {
  judgeModel: 'openai/gpt-oss-120b',
  judgeTier: 'free',
  defectExists: true,
  matchedDefectId: 'defect-1',
  correctness: 2,
  localization: 2,
  actionability: 2,
  unsupportedClaim: false,
  evidenceQuote: 'code',
  reason: 'reason',
};

describe('FileJudgeCache', () => {
  it('persists both judge passes across instances', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parakh-eval-'));
    const path = join(directory, 'judge.json');
    await new FileJudgeCache(path).set('key', [verdict, verdict]);

    expect(await new FileJudgeCache(path).get('key')).toEqual([verdict, verdict]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('key');
  });

  it('does not expose a partial pair as a complete cache hit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'parakh-eval-'));
    const path = join(directory, 'judge.json');
    const cache = new FileJudgeCache(path);
    await cache.setPartial('key', [verdict, null]);

    expect(await cache.get('key')).toBeNull();
    expect(await cache.getPartial('key')).toEqual([verdict, null]);
  });
});
