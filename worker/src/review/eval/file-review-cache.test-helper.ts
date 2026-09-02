import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EvalRun } from './types.js';

type CacheData = Record<string, EvalRun>;

/**
 * Persists complete EvalRun objects to a JSON file keyed by a stable
 * (pipeline sha + case snapshot hash + config) identifier. On a retry the
 * runner short-circuits at the pipeline adapter level so the reviewer model
 * (Gemini) is never called again for a run that already completed.
 */
export class FileReviewCache {
  private data: CacheData | null = null;

  constructor(private readonly path: string) {}

  async get(key: string): Promise<EvalRun | null> {
    return (await this.load())[key] ?? null;
  }

  async set(key: string, run: EvalRun): Promise<void> {
    const data = await this.load();
    data[key] = run;
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2));
    await rename(temporaryPath, this.path);
  }

  private async load(): Promise<CacheData> {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await readFile(this.path, 'utf8')) as CacheData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = {};
    }
    return this.data;
  }
}