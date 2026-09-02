import { readFile } from 'node:fs/promises';
import type { EvalCorpus } from './types.js';

const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

export async function loadEvalCorpus(path: string): Promise<EvalCorpus> {
  const corpus = JSON.parse(await readFile(path, 'utf8')) as EvalCorpus;
  validateEvalCorpus(corpus);
  return corpus;
}

export function validateEvalCorpus(corpus: EvalCorpus): void {
  if (corpus.schemaVersion !== 1) throw new Error('Unsupported eval corpus schema');
  if (!corpus.goldSetVersion.trim()) throw new Error('Missing gold set version');

  const caseIds = new Set<string>();
  for (const item of corpus.cases) {
    if (caseIds.has(item.id)) throw new Error(`Duplicate eval case: ${item.id}`);
    if (!item.baseSha || !item.headSha) throw new Error(`Unpinned eval case: ${item.id}`);
    caseIds.add(item.id);
  }

  const defectIds = new Set<string>();
  for (const defect of corpus.defects) {
    if (defectIds.has(defect.id)) throw new Error(`Duplicate eval defect: ${defect.id}`);
    if (!caseIds.has(defect.caseId)) {
      throw new Error(`Unknown case for defect ${defect.id}: ${defect.caseId}`);
    }
    if (!SEVERITIES.has(defect.severity)) {
      throw new Error(`Invalid severity for defect ${defect.id}: ${defect.severity}`);
    }
    defectIds.add(defect.id);
  }

  for (const item of corpus.cases) {
    const defectCount = corpus.defects.filter((defect) => defect.caseId === item.id).length;
    if (item.isNegativeControl && defectCount > 0) {
      throw new Error(`Negative control has gold defects: ${item.id}`);
    }
  }
}

