import { describe, expect, it } from 'vitest';
import { githubProvider } from './github.js';
import { getProvider, getProviderByEvent, providers } from './registry.js';

describe('githubProvider.isEvent', () => {
  it('matches installation lifecycle events', () => {
    expect(githubProvider.isEvent('installation')).toBe(true);
    expect(githubProvider.isEvent('installation_repositories')).toBe(true);
  });

  it('ignores PR and comment events', () => {
    expect(githubProvider.isEvent('pull_request')).toBe(false);
    expect(githubProvider.isEvent('issue_comment')).toBe(false);
  });
});

describe('githubProvider.parseEvent', () => {
  it('returns null for a payload without installation/account', () => {
    expect(githubProvider.parseEvent('installation', { action: 'created' })).toBeNull();
  });

  it('normalizes installation.created with the full repo list', () => {
    const event = githubProvider.parseEvent('installation', {
      action: 'created',
      installation: { id: 42, account: { login: 'acme', type: 'Organization' } },
      repositories: [{ full_name: 'acme/app' }, { full_name: 'acme/lib' }],
      sender: { login: 'dev' },
    })!;
    expect(event.provider).toBe('github');
    expect(event.owner).toBe('acme');
    expect(event.installationId).toBe(42);
    expect(event.repos).toEqual(['acme/app', 'acme/lib']);
    expect(event.installedBy).toBe('dev');
    expect(event.status).toBe('active');
  });

  it('normalizes installation.deleted as removed', () => {
    const event = githubProvider.parseEvent('installation', {
      action: 'deleted',
      installation: { id: 42, account: { login: 'acme' } },
    })!;
    expect(event.status).toBe('removed');
    expect(event.repos).toEqual([]);
  });

  it('uses the authoritative full repo list on installation_repositories (no added/removed reconciliation)', () => {
    const event = githubProvider.parseEvent('installation_repositories', {
      action: 'added',
      installation: { id: 42, account: { login: 'acme' } },
      repositories: [{ full_name: 'acme/app' }],
      repositories_added: [{ full_name: 'acme/tool' }], // ignored: payload already carries the full list
      repositories_removed: [{ full_name: 'acme/old' }],
    })!;
    expect(event.repos).toEqual(['acme/app']);
    expect(event.status).toBe('active');
  });

  it('treats an empty repository list on installation_repositories as authoritative', () => {
    const event = githubProvider.parseEvent('installation_repositories', {
      action: 'removed',
      installation: { id: 42, account: { login: 'acme' } },
      repositories: [],
      repositories_removed: [{ full_name: 'acme/app' }],
    })!;
    expect(event.repos).toEqual([]);
    expect(event.status).toBe('active');
  });
});

describe('provider registry', () => {
  it('registers github with a display name', () => {
    expect(providers.map((p) => p.id)).toEqual(['github']);
    expect(getProvider('github')?.displayName).toBe('GitHub');
    expect(getProvider('nope')).toBeNull();
  });

  it('routes installation events to the right provider', () => {
    expect(getProviderByEvent('installation_repositories')?.id).toBe('github');
    expect(getProviderByEvent('pull_request')).toBeNull();
  });
});

describe('install url', () => {
  it('builds a link from the app slug', () => {
    expect(githubProvider.getInstallUrl({ GITHUB_APP_SLUG: 'parakh-bot' })).toBe(
      'https://github.com/apps/parakh-bot/installations/new'
    );
  });

  it('falls back to a default slug', () => {
    expect(githubProvider.getInstallUrl({})).toContain('github.com/apps/');
  });
});