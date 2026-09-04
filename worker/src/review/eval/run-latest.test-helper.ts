import 'dotenv/config';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { loadEvalState } from './eval-state.js';

const exec = promisify(execFile);
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const has = (name: string) => args.includes(name);
const repoRoot = process.cwd();
const state = await loadEvalState(resolve(repoRoot, '.eval-cache', 'last-comparison.json'));

if (!has('--old-ref') && !state) {
  throw new Error('No previous comparison found. Run with --old-ref <baseline-sha> once.');
}

const evalArgs = [
  ...args,
  ...(has('--old-ref') ? [] : ['--old-ref', state!.newPipeline.resolvedSha]),
  ...(has('--new-ref') ? [] : ['--new-ref', 'HEAD']),
  ...(has('--reviewer-model') || !state ? [] : ['--reviewer-model', state.config.reviewerModel]),
  ...(has('--context-budget') || !state ? [] : ['--context-budget', String(state.config.contextBudget)]),
  ...(has('--judge-context-budget') || !state ? [] : ['--judge-context-budget', String(state.config.judgeContextBudget ?? state.config.contextBudget)]),
  ...(has('--timeout-ms') || !state ? [] : ['--timeout-ms', String(state.config.timeoutMs)]),
  ...(has('--output') ? [] : ['--output', '.eval-cache/reports/latest-comparison.json']),
  ...(has('--output-md') ? [] : ['--output-md', '.eval-cache/reports/latest-comparison.md']),
  ...(has('--output-review') ? [] : ['--output-review', '.eval-cache/reports/latest-comparison-adjudication.md']),
];

const viteNode = join(repoRoot, 'node_modules', 'vite-node', 'dist', 'cli.mjs');
await access(viteNode);
const result = await exec(process.execPath, [viteNode, '--script', join(repoRoot, 'worker/src/review/eval/run-evals.test-helper.ts'), '--', ...evalArgs], {
  cwd: repoRoot,
  env: process.env,
  maxBuffer: 10 * 1024 * 1024,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

await exec(process.execPath, [viteNode, '--script', join(repoRoot, 'worker/src/review/eval/dashboard-cli.test-helper.ts'), '--'], {
  cwd: repoRoot,
  env: process.env,
});
process.stdout.write('Open .eval-cache/reports/index.html to view the comparison.\n');
