import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEvalCorpus, validateEvalCorpus } from './corpus.test-helper.js';
import type { EvalCorpus } from './types.js';

const fixturePath = fileURLToPath(
  new URL('./fixtures/gold-v1.json', import.meta.url)
);

describe('eval corpus', () => {
  it('loads the checked-in gold set', async () => {
    const corpus = await loadEvalCorpus(fixturePath);
    expect(corpus.goldSetVersion).toBe('gold-v1');
    expect(corpus.cases).toHaveLength(2);
    expect(corpus.defects).toHaveLength(1);
  });

  it('rejects defects attached to negative controls', () => {
    const corpus: EvalCorpus = {
      schemaVersion: 1,
      goldSetVersion: 'gold-test',
      cases: [{
        id: 'clean',
        repo: 'fixture/repo',
        baseSha: 'base',
        headSha: 'head',
        language: 'typescript',
        isNegativeControl: true,
        diff: '',
        files: {},
      }],
      defects: [{
        id: 'defect',
        caseId: 'clean',
        claim: 'claim',
        evidence: 'evidence',
        files: ['src/a.ts'],
        severity: 'HIGH',
        fixCondition: 'condition',
      }],
    };

    expect(() => validateEvalCorpus(corpus)).toThrow('Negative control has gold defects');
  });
});

