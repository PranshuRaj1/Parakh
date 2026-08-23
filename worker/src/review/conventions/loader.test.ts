import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFileContent } = vi.hoisted(() => ({ getFileContent: vi.fn() }));

vi.mock('../../github/api.js', () => ({ getFileContent }));

import { loadConventionRules } from './loader.js';

function markdown(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n');
}

describe('loadConventionRules', () => {
  beforeEach(() => {
    getFileContent.mockReset();
  });

  it('returns empty and stays silent when no convention file exists', async () => {
    getFileContent.mockRejectedValue(new Error('GitHub API error (404) https://api.github.com/repos/acme/app/contents/AGENTS.md: Not Found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadConventionRules('acme', 'app', 'head-sha', 'token');

    expect(loaded).toEqual({ rules: [], filesFound: 0, truncated: false, fetchAttempts: 3 });
    expect(getFileContent).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('parses rules in precedence order: rules.md, then AGENTS.md, then CLAUDE.md', async () => {
    getFileContent.mockImplementation((_owner, _repo, path) => {
      if (path === '.parakh/rules.md') return Promise.resolve(markdown(['use snake_case columns']));
      if (path === 'AGENTS.md') return Promise.resolve(markdown(['keep handlers thin']));
      return Promise.reject(new Error('GitHub API error (404) missing CLAUDE.md'));
    });

    const loaded = await loadConventionRules('acme', 'app', 'head-sha', 'token');

    expect(loaded.filesFound).toBe(2);
    expect(loaded.fetchAttempts).toBe(3);
    expect(loaded.rules.map((rule) => rule.id)).toEqual([
      'conv:parakh-rules:1',
      'conv:agents-md:1',
    ]);
  });

  it('maps parsed conventions onto the Rule shape without DB identity', async () => {
    getFileContent.mockImplementation((_owner, _repo, path) =>
      path === 'AGENTS.md'
        ? Promise.resolve('---\npriority: high\nscope: src/**\n---\n- validate every webhook payload')
        : Promise.reject(new Error('GitHub API error (404)'))
    );

    const [rule] = await loadConventionRules('acme', 'app', 'head-sha', 'token').then((l) => l.rules);

    expect(rule).toMatchObject({
      id: 'conv:agents-md:1',
      repo: '',
      body: 'validate every webhook payload',
      priority: 'high',
      kind: 'standard',
      scope: { include: ['src/**'] },
      status: 'ACTIVE',
      embedding: null,
      evidence_count: 0,
    });
  });

  it('degrades to empty on a non-404 GitHub failure instead of failing the review', async () => {
    getFileContent.mockRejectedValue(new Error('GitHub API error (502) Bad gateway'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadConventionRules('acme', 'app', 'head-sha', 'token');

    expect(loaded.rules).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('caps convention bodies at the prompt budget without splitting rules', async () => {
    getFileContent.mockImplementation((_owner, _repo, path) =>
      path === '.parakh/rules.md'
        ? Promise.resolve(`- ${'a'.repeat(3995)}\n- drop me`)
        : Promise.reject(new Error('GitHub API error (404)'))
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const loaded = await loadConventionRules('acme', 'app', 'head-sha', 'token');

    expect(loaded.filesFound).toBe(1);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0].body.length).toBeLessThanOrEqual(4000);
    expect(loaded.truncated).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
