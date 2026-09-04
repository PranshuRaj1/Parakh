import { readFile, writeFile } from 'node:fs/promises';
import type { EvalRunConfig, PipelineVersion } from './types.js';

export interface EvalState {
  oldPipeline: PipelineVersion;
  newPipeline: PipelineVersion;
  corpus: string;
  config: EvalRunConfig;
  report: string;
  updatedAt: string;
}

export async function loadEvalState(path: string): Promise<EvalState | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as EvalState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveEvalState(path: string, state: EvalState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2));
}
