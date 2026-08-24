/**
 * User LLM Keys DB Layer
 *
 * Stored encrypted key material for dashboard users (BYO-keys). The worker
 * encrypts before persisting and decrypts when building a provider stack —
 * plaintext never reaches the database or the dashboard. DB only — no
 * business logic, no crypto.
 */

import { getDb } from './client.js';
import { withDbRetry, isTransientDbError } from './db-retry.js';

const DB_RETRY_OPTS = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 3000,
  isRetryable: isTransientDbError,
  label: 'user-llm-keys-db',
};

interface EnvWithDB {
  DATABASE_URL: string;
}

export interface StoredEncryptedKey {
  enc: string;
  hint: string;
}

export interface StoredUserLLMKeys {
  githubId: number;
  githubLogin: string;
  geminiKeys: StoredEncryptedKey[];
  groqKeys: StoredEncryptedKey[];
  cfaiKeys: StoredEncryptedKey[];
  cfaiAccountId: string | null;
  openrouterKeys: StoredEncryptedKey[];
  updatedAt: string;
}

interface UserLLMKeysRow {
  github_id: number;
  github_login: string;
  gemini_keys: string | unknown[];
  groq_keys: string | unknown[];
  cfai_keys: string | unknown[];
  cfai_account_id: string | null;
  openrouter_keys: string | unknown[];
  updated_at: string;
}

function parseJsonArray(value: string | unknown[]): StoredEncryptedKey[] {
  return Array.isArray(value) ? (value as StoredEncryptedKey[]) : JSON.parse(value ?? '[]');
}

function rowToUserLLMKeys(row: UserLLMKeysRow): StoredUserLLMKeys {
  return {
    githubId: Number(row.github_id),
    githubLogin: row.github_login,
    geminiKeys: parseJsonArray(row.gemini_keys),
    groqKeys: parseJsonArray(row.groq_keys),
    cfaiKeys: parseJsonArray(row.cfai_keys),
    cfaiAccountId: row.cfai_account_id,
    openrouterKeys: parseJsonArray(row.openrouter_keys),
    updatedAt: row.updated_at,
  };
}

/** Load a user's stored keys by GitHub numeric ID. */
export async function getStoredUserLLMKeysByGithubId(
  githubId: number,
  env: EnvWithDB
): Promise<StoredUserLLMKeys | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await withDbRetry(
    () => sql`
      SELECT k.github_id, d.github_login, k.gemini_keys, k.groq_keys, k.cfai_keys,
             k.cfai_account_id, k.openrouter_keys, k.updated_at
      FROM user_llm_keys k
      JOIN dashboard_users d ON d.github_id = k.github_id
      WHERE k.github_id = ${githubId}
    `,
    DB_RETRY_OPTS
  );
  const row = rows[0] as unknown as UserLLMKeysRow | undefined;
  return row ? rowToUserLLMKeys(row) : null;
}

/** Load a user's stored keys by dashboard login. */
export async function getStoredUserLLMKeysByLogin(
  login: string,
  env: EnvWithDB
): Promise<StoredUserLLMKeys | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await withDbRetry(
    () => sql`
      SELECT k.github_id, d.github_login, k.gemini_keys, k.groq_keys, k.cfai_keys,
             k.cfai_account_id, k.openrouter_keys, k.updated_at
      FROM user_llm_keys k
      JOIN dashboard_users d ON d.github_id = k.github_id
      WHERE lower(d.github_login) = lower(${login})
    `,
    DB_RETRY_OPTS
  );
  const row = rows[0] as unknown as UserLLMKeysRow | undefined;
  return row ? rowToUserLLMKeys(row) : null;
}

/** GitHub numeric ID for a dashboard login, or null if the user doesn't exist. */
export async function getGithubIdByLogin(login: string, env: EnvWithDB): Promise<number | null> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await withDbRetry(
    () => sql`SELECT github_id FROM dashboard_users WHERE github_login = ${login}`,
    DB_RETRY_OPTS
  );
  const row = rows[0] as unknown as { github_id: number } | undefined;
  return row ? Number(row.github_id) : null;
}

/** Full-replace a user's stored keys (all arrays are overwritten atomically). */
export async function upsertUserLLMKeys(
  input: {
    githubId: number;
    geminiKeys: StoredEncryptedKey[];
    groqKeys: StoredEncryptedKey[];
    cfaiKeys: StoredEncryptedKey[];
    cfaiAccountId: string | null;
    openrouterKeys: StoredEncryptedKey[];
  },
  env: EnvWithDB
): Promise<StoredUserLLMKeys> {
  const sql = getDb(env.DATABASE_URL);
  const rows = await withDbRetry(
    () => sql`
      INSERT INTO user_llm_keys (
        github_id, gemini_keys, groq_keys, cfai_keys, cfai_account_id, openrouter_keys
      ) VALUES (
        ${input.githubId},
        ${JSON.stringify(input.geminiKeys)}::jsonb,
        ${JSON.stringify(input.groqKeys)}::jsonb,
        ${JSON.stringify(input.cfaiKeys)}::jsonb,
        ${input.cfaiAccountId},
        ${JSON.stringify(input.openrouterKeys)}::jsonb
      )
      ON CONFLICT (github_id) DO UPDATE SET
        gemini_keys = EXCLUDED.gemini_keys,
        groq_keys = EXCLUDED.groq_keys,
        cfai_keys = EXCLUDED.cfai_keys,
        cfai_account_id = EXCLUDED.cfai_account_id,
        openrouter_keys = EXCLUDED.openrouter_keys,
        updated_at = now()
      RETURNING github_id, updated_at
    `,
    DB_RETRY_OPTS
  );
  const row = rows[0] as unknown as UserLLMKeysRow;
  return rowToUserLLMKeys({
    ...row,
    github_login: String(input.githubId),
    gemini_keys: input.geminiKeys,
    groq_keys: input.groqKeys,
    cfai_keys: input.cfaiKeys,
    openrouter_keys: input.openrouterKeys,
  });
}
