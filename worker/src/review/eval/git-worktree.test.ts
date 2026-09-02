import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveGitPipelineVersion,
  withDetachedWorktree,
  type GitRunner,
} from './git-worktree.test-helper.js';

describe('git eval worktrees', () => {
  it('resolves a branch to an immutable commit', async () => {
    const git: GitRunner = vi.fn().mockResolvedValue({
      stdout: `${'a'.repeat(40)}\n`,
      stderr: '',
    });
    const version = await resolveGitPipelineVersion('old', 'main', 'repo', git);
    expect(version.resolvedSha).toBe('a'.repeat(40));
    expect(git).toHaveBeenCalledWith(['rev-parse', 'main^{commit}'], 'repo');
  });

  it('removes the detached worktree after the run', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'parakh-repo-'));
    const git: GitRunner = vi.fn().mockImplementation(async (args) => {
      if (args[1] === 'add') {
        const worktreePath = args[3];
        await mkdir(join(worktreePath, 'shared'), { recursive: true });
      }
      return { stdout: '', stderr: '' };
    });
    const version = {
      label: 'old' as const,
      branchRef: 'main',
      resolvedSha: 'a'.repeat(40),
    };

    const result = await withDetachedWorktree({
      repoRoot,
      version,
      git,
      run: async (path) => path,
    });
    expect(result).toContain(join('.eval-cache', 'worktrees', 'old-'));
    expect(git).toHaveBeenLastCalledWith(
      ['worktree', 'remove', '--force', result],
      repoRoot
    );
  });

  it('reuses a matching detached worktree left by an interrupted run', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'parakh-repo-'));
    const version = {
      label: 'old' as const,
      branchRef: 'main',
      resolvedSha: 'a'.repeat(40),
    };
    const worktreePath = join(
      repoRoot,
      '.eval-cache',
      'worktrees',
      `old-${version.resolvedSha.slice(0, 12)}`
    );
    await mkdir(join(worktreePath, 'shared'), { recursive: true });
    const git: GitRunner = vi.fn().mockImplementation(async (args, cwd) => {
      if (cwd === worktreePath && args[1] === '--show-toplevel') {
        return { stdout: worktreePath, stderr: '' };
      }
      if (cwd === worktreePath && args[1] === 'HEAD') {
        return { stdout: version.resolvedSha, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    await expect(withDetachedWorktree({
      repoRoot,
      version,
      git,
      run: async (path) => path,
    })).resolves.toBe(worktreePath);
    expect(git).not.toHaveBeenCalledWith(
      expect.arrayContaining(['add']),
      repoRoot
    );
    expect(git).toHaveBeenLastCalledWith(
      ['worktree', 'remove', '--force', worktreePath],
      repoRoot
    );
  });
});
