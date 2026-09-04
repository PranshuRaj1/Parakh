import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { writeEvalDashboard } from './dashboard.js';

const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const reportDirectory = value('--reports', '.eval-cache/reports');
const output = value('--output', '.eval-cache/reports/index.html');
await mkdir(dirname(resolve(output)), { recursive: true });
await writeEvalDashboard(reportDirectory, output);
process.stdout.write(`Wrote eval dashboard to ${resolve(output)}\n`);
