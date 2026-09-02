import { execFile } from 'node:child_process';
import { access, mkdir, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PipelineLabel, PipelineVersion } from './types.js';
import { resolvePipelineVersion } from './runner.js';

const execFileAsync = promisify(execFile);

export type GitRunner = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string }>;

const runGit: GitRunner = async (args, cwd) =>
  execFileAsync('git', args, { cwd });

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function matchesWorktree(
  git: GitRunner,
  path: string,
  sha: string
): Promise<boolean> {
  try {
    const root = (await git(['rev-parse', '--show-toplevel'], path)).stdout.trim();
    const head = (await git(['rev-parse', 'HEAD'], path)).stdout.trim();
    return resolve(root) === resolve(path) && head === sha;
  } catch {
    return false;
  }
}

export async function resolveGitPipelineVersion(
  label: PipelineLabel,
  branchRef: string,
  repoRoot: string,
  git: GitRunner = runGit
): Promise<PipelineVersion> {
  return resolvePipelineVersion(label, branchRef, async (ref) =>
    (await git(['rev-parse', `${ref}^{commit}`], repoRoot)).stdout
  );
}

export async function withDetachedWorktree<T>(input: {
  repoRoot: string;
  version: PipelineVersion;
  run: (worktreePath: string) => Promise<T>;
  git?: GitRunner;
}): Promise<T> {
  const git = input.git ?? runGit;
  const worktreeRoot = resolve(input.repoRoot, '.eval-cache', 'worktrees');
  const worktreePath = join(
    worktreeRoot,
    `${input.version.label}-${input.version.resolvedSha.slice(0, 12)}`
  );
  if (relative(worktreeRoot, worktreePath).startsWith('..')) {
    throw new Error('Eval worktree escaped its cache root');
  }

  await mkdir(dirname(worktreePath), { recursive: true });
  const exists = await pathExists(worktreePath);
  const reusable = exists && await matchesWorktree(
    git,
    worktreePath,
    input.version.resolvedSha
  );
  if (exists && !reusable) {
    throw new Error(`Eval worktree path exists with unexpected Git state: ${worktreePath}`);
  }
  if (!reusable) {
    await git(
      ['worktree', 'add', '--detach', worktreePath, input.version.resolvedSha],
      input.repoRoot
    );
  }
  try {
    const packageRoot = join(worktreePath, 'node_modules', '@parakh');
    await mkdir(packageRoot, { recursive: true });
    const sharedPackage = join(packageRoot, 'shared');
    if (!await pathExists(sharedPackage)) {
      await symlink(join(worktreePath, 'shared'), sharedPackage, 'junction');
    }
    return await input.run(worktreePath);
  } finally {
    await git(['worktree', 'remove', '--force', worktreePath], input.repoRoot);
  }
}
