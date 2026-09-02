import { execFile } from 'node:child_process';
import { mkdir, symlink } from 'node:fs/promises';
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
  await git(
    ['worktree', 'add', '--detach', worktreePath, input.version.resolvedSha],
    input.repoRoot
  );
  try {
    const packageRoot = join(worktreePath, 'node_modules', '@parakh');
    await mkdir(packageRoot, { recursive: true });
    await symlink(join(worktreePath, 'shared'), join(packageRoot, 'shared'), 'junction');
    return await input.run(worktreePath);
  } finally {
    await git(['worktree', 'remove', '--force', worktreePath], input.repoRoot);
  }
}
