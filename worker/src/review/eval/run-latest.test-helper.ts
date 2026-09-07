import 'dotenv/config';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadEvalState } from './eval-state.js';
import { publishEvalReport } from './publisher.js';
import type { EvalReport } from './types.js';

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const has = (name: string) => args.includes(name);
const repoRoot = process.cwd();
const state = await loadEvalState(resolve(repoRoot, '.eval-cache', 'last-comparison.json'));

if (!has('--old-ref') && !state) {
  throw new Error('No previous comparison found. Run with --old-ref <baseline-sha> once.');
}

const evalArgs = [
  ...args,
  ...(has('--old-ref') ? [] : ['--old-ref', state!.oldPipeline.resolvedSha]),
  ...(has('--new-ref') ? [] : ['--new-ref', 'HEAD']),
  ...(has('--corpus') ? [] : ['--corpus', state!.corpus ?? 'worker/src/review/eval/fixtures/gold-v1.json']),
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
await run(process.execPath, [viteNode, '--script', join(repoRoot, 'worker/src/review/eval/run-evals.test-helper.ts'), '--', ...evalArgs]);

const report = JSON.parse(await readFile(resolve(repoRoot, '.eval-cache/reports/latest-comparison.json'), 'utf8')) as EvalReport;
const runId = await publishEvalReport(report);
process.stdout.write(`Published eval run ${runId}\n`);

await run(process.execPath, [viteNode, '--script', join(repoRoot, 'worker/src/review/eval/dashboard-cli.test-helper.ts'), '--']);
const dashboardPath = resolve(repoRoot, '.eval-cache/reports/index.html');
if (process.platform === 'win32') {
  await run('cmd', ['/c', 'start', '', dashboardPath]);
} else if (process.platform === 'darwin') {
  await run('open', [dashboardPath]);
} else {
  await run('xdg-open', [dashboardPath]);
}
process.stdout.write('Dashboard opened.\n');
