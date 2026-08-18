/**
 * Provider Installations DB Layer
 *
 * Tracks which provider accounts (owner/org) have connected Parakh and which
 * repos the app can see. Written by provider webhook events, read by the
 * dashboard connect page. DB only — no business logic.
 */

import { getDb } from './client.js';
import { withDbRetry, isTransientDbError } from './db-retry.js';

const DB_RETRY_OPTS = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 3000,
  isRetryable: isTransientDbError,
  label: 'installations-db',
};

interface EnvWithDB {
  DATABASE_URL: string;
}

export interface ProviderInstallation {
  provider: string;
  owner: string;
  installationId: number;
  repos: string[];
  status: 'active' | 'removed' | 'suspended';
  installedBy: string | null;
  installedAt: string;
  updatedAt: string;
}

interface InstallationRow {
  provider: string;
  owner: string;
  installation_id: number;
  repos: string | string[];
  status: string;
  installed_by: string | null;
  installed_at: string;
  updated_at: string;
}

function rowToInstallation(row: InstallationRow): ProviderInstallation {
  return {
    provider: row.provider,
    owner: row.owner,
    installationId: row.installation_id,
    repos: Array.isArray(row.repos) ? row.repos : JSON.parse(row.repos ?? '[]'),
    status: row.status as ProviderInstallation['status'],
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

/** Create or refresh a provider installation (upsert on provider+owner). */
export async function upsertInstallation(
  input: {
    provider: string;
    owner: string;
    installationId: number;
    repos: string[];
    status?: ProviderInstallation['status'];
    installedBy?: string | null;
  },
  env: EnvWithDB
): Promise<ProviderInstallation> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await withDbRetry(
    () => sql`
      INSERT INTO provider_installations (provider, owner, installation_id, repos, status, installed_by)
      VALUES (${input.provider}, ${input.owner}, ${input.installationId},
              ${JSON.stringify(input.repos)}::jsonb, ${input.status ?? 'active'}, ${input.installedBy ?? null})
      ON CONFLICT (provider, owner) DO UPDATE SET
        installation_id = EXCLUDED.installation_id,
        repos = EXCLUDED.repos,
        status = EXCLUDED.status,
        installed_by = EXCLUDED.installed_by,
        updated_at = now()
      RETURNING *
    `,
    DB_RETRY_OPTS
  );
  return rowToInstallation(rows[0] as unknown as InstallationRow);
}

/** List all provider installations, newest first. */
export async function listInstallations(env: EnvWithDB, installedBy?: string): Promise<ProviderInstallation[]> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await withDbRetry(
    () => installedBy
      ? sql`SELECT * FROM provider_installations WHERE installed_by = ${installedBy} ORDER BY updated_at DESC`
      : sql`SELECT * FROM provider_installations ORDER BY updated_at DESC`,
    DB_RETRY_OPTS
  );
  return (rows as unknown as InstallationRow[]).map(rowToInstallation);
}

/** Mark an installation removed (app uninstalled, or user disconnects). */
export async function markInstallationRemoved(
  provider: string,
  owner: string,
  env: EnvWithDB,
  installedBy?: string
): Promise<void> {
  const sql = getDb(env.DATABASE_URL);
  await withDbRetry(
    () => sql`
      UPDATE provider_installations
      SET status = 'removed', updated_at = now()
      WHERE provider = ${provider} AND owner = ${owner}
        AND (${installedBy ?? null} IS NULL OR installed_by = ${installedBy ?? null})
    `,
    DB_RETRY_OPTS
  );
}
