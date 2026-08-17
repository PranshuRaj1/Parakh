/**
 * GitHub provider adapter.
 *
 * Normalizes GitHub App installation webhooks (installation,
 * installation_repositories) into ProviderInstallationEvent and builds the
 * public install deep link used by the dashboard "Connect" page.
 */

import type { CodeHostProvider, ProviderInstallationEvent, ProviderInstallEnv } from './types.js';

const INSTALL_EVENTS = new Set(['installation', 'installation_repositories']);

interface Account {
  login?: string;
  type?: string;
}

interface InstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: Account;
    suspended_at?: string | null;
  };
  repositories?: Array<{ full_name?: string }>;
  repositories_added?: Array<{ full_name?: string }>;
  repositories_removed?: Array<{ full_name?: string }>;
  sender?: { login?: string };
}

function repoName(fullName: string | undefined): string {
  return typeof fullName === 'string' ? fullName.trim() : '';
}

export const githubProvider: CodeHostProvider = {
  id: 'github',
  displayName: 'GitHub',

  isEvent(eventType: string): boolean {
    return INSTALL_EVENTS.has(eventType);
  },

  parseEvent(eventType: string, payload: unknown): ProviderInstallationEvent | null {
    const event = payload as InstallationPayload;
    const installationId = event.installation?.id;
    const accountLogin = event.installation?.account?.login;
    if (typeof installationId !== 'number' || !accountLogin) return null;

    if (event.installation?.suspended_at) {
      return {
        provider: 'github',
        owner: accountLogin,
        installationId,
        repos: [],
        installedBy: null,
        status: 'removed',
      };
    }

    let repos: string[];
    if (eventType === 'installation') {
      // 'created': full list. 'deleted': no repos.
      repos = event.action === 'created' ? (event.repositories ?? []).map((r) => repoName(r.full_name)) : [];
    } else {
      // installation_repositories: previous list + added - removed.
      const base = (event.repositories ?? []).map((r) => repoName(r.full_name));
      const removed = new Set((event.repositories_removed ?? []).map((r) => repoName(r.full_name)));
      const added = (event.repositories_added ?? []).map((r) => repoName(r.full_name));
      repos = [...new Set([...base.filter((name) => !removed.has(name)), ...added])].filter(Boolean);
    }

    if (event.action === 'deleted' || event.action === 'removed') {
      return {
        provider: 'github',
        owner: accountLogin,
        installationId,
        repos: [],
        installedBy: null,
        status: 'removed',
      };
    }

    return {
      provider: 'github',
      owner: accountLogin,
      installationId,
      repos: repos.filter(Boolean),
      installedBy: event.sender?.login ?? null,
      status: 'active',
    };
  },

  getInstallUrl(env: ProviderInstallEnv): string {
    const slug = env.GITHUB_APP_SLUG ?? 'parakh-bot';
    return `https://github.com/apps/${slug}/installations/new`;
  },
};
