/**
 * Code-host provider abstraction.
 *
 * One adapter per code host (GitHub today; GitLab, Bitbucket, etc. later).
 * Adding a provider = one file implementing this interface + one registry
 * entry. Callers never touch provider-specific payload shapes.
 */

export interface ProviderInstallationEvent {
  /** Provider id, e.g. 'github'. */
  provider: string;
  /** Account that installed the app: org login or username. */
  owner: string;
  /** Provider-side installation id. */
  installationId: number;
  /** Repos the app can see after this event. */
  repos: string[];
  /** Installer login (nullable). */
  installedBy: string | null;
  /** 'active' when installed/updated, 'removed' when uninstalled. */
  status: 'active' | 'removed';
}

/** Env vars consumed by providers when building connect/install links. */
export type ProviderInstallEnv = { GITHUB_APP_SLUG?: string };

export interface CodeHostProvider {
  id: string;
  displayName: string;
  /** True when this event type belongs to this provider. */
  isEvent(eventType: string): boolean;
  /** Normalize a webhook payload into a provider-agnostic shape. */
  parseEvent(eventType: string, payload: unknown): ProviderInstallationEvent | null;
  /** Deep link that starts the connect flow (install page). */
  getInstallUrl(env: ProviderInstallEnv): string;
}
