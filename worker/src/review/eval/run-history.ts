import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EvalReport } from './types.js';

export function reportId(report: EvalReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export async function archiveReport(directory: string, report: EvalReport): Promise<string> {
  const file = join('runs', `${reportId(report)}.json`);
  await mkdir(join(directory, 'runs'), { recursive: true });
  try {
    await writeFile(join(directory, file), JSON.stringify(report, null, 2), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
}

export async function saveEvalReport(output: string, report: EvalReport): Promise<void> {
  try {
    const previous = JSON.parse(await readFile(output, 'utf8')) as EvalReport;
    await archiveReport(dirname(output), previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await archiveReport(dirname(output), report);
  await writeFile(output, JSON.stringify(report, null, 2));
}

export function comparisonKey(report: EvalReport): string | null {
  if (!report.config || !report.goldSetVersion || report.cases.some(item => !item.runs?.newA.run.caseSnapshotHash)) return null;
  return JSON.stringify({
    gold: report.goldSetVersion,
    config: report.config,
    judge: [report.judgeModel, report.judgeTier],
    cases: report.cases.map(item => [item.caseId, item.runs.newA.run.caseSnapshotHash]).sort((a, b) => a[0].localeCompare(b[0])),
  });
}

export function runScore(report: EvalReport): number | null {
  const scores = report.cases.map(item => item.comparison.newMetrics.strictF1)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}
