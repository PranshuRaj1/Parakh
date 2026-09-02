import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JudgeCache } from './judge.js';
import type { JudgeVerdict } from './types.js';

type CacheData = Record<string, [JudgeVerdict, JudgeVerdict]>;

export class FileJudgeCache implements JudgeCache {
  private data: CacheData | null = null;

  constructor(private readonly path: string) {}

  async get(key: string): Promise<[JudgeVerdict, JudgeVerdict] | null> {
    return (await this.load())[key] ?? null;
  }

  async set(key: string, verdicts: [JudgeVerdict, JudgeVerdict]): Promise<void> {
    const data = await this.load();
    data[key] = verdicts;
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
