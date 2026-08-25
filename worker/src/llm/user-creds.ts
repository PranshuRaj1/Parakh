/**
 * User Credentials Resolution
 *
 * Maps a repo owner → the dashboard user who installed the app → that user's
 * decrypted LLM API keys. Reviews (and comment-triggered LLM work) bill
 * exclusively against the installing user's keys, so the resolution chain is:
 *
 *   provider_installations(provider+owner).installed_by
 *     → dashboard_users.github_login
 *     → user_llm_keys (encrypted at rest, decrypted here)
 *
 * Returns null when no install or no stored keys exist — callers decide
 * whether to skip or hard-gate.
 */

import type { Env } from '../index.js';
import { LLM_PROVIDER_RPM_ESTIMATES } from '@parakh/shared';
import { getInstallationByOwner } from '../db/installations.js';
import { getStoredUserLLMKeysByLogin } from '../db/user-llm-keys.js';
import { decryptKey } from './encryption.js';

export interface UserLLMCreds {
  /** Dashboard login that owns these keys. */
  githubLogin: string;
  geminiKeys: string[];
  groqKeys: string[];
  /** CF Workers AI account + first stored token (client takes a single token). */
  cfaiAccountId: string | null;
  cfaiToken: string | null;
  openrouterKey: string | null;
}

const MASTER_LOGIN = 'PranshuRaj1';
const SHARED_KEY_LOGIN = new Map([
  ['pranshuraj1', 'pranshu3961-lang'],
  ['pranshu3961-lang', 'PranshuRaj1'],
]);

export function isSharedLLMKeyAccount(login: string): boolean {
  return SHARED_KEY_LOGIN.has(login.toLowerCase());
}

function parseKeys(...values: (string | undefined)[]): string[] {
  return values.flatMap(value => value?.split(',') ?? []).map(value => value.trim()).filter(Boolean);
}

function getMasterEnvCreds(env: Env): UserLLMCreds {
  return {
    githubLogin: MASTER_LOGIN,
    geminiKeys: parseKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY),
    groqKeys: parseKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY),
    cfaiAccountId: env.CF_ACCOUNT_ID?.trim() || null,
    cfaiToken: env.CF_API_TOKEN?.trim() || null,
    openrouterKey: env.OPENROUTER_API_KEY?.trim() || null,
  };
}

/**
 * Resolve the keys of the user who installed Parakh on `owner`'s account.
 * Returns null when there is no installation, no installer, or no stored keys.
 */
export async function resolveUserCreds(owner: string, env: Env): Promise<UserLLMCreds | null> {
  if (owner.toLowerCase() === MASTER_LOGIN.toLowerCase()) {
    return await resolveUserCredsByLogin(MASTER_LOGIN, env) ?? getMasterEnvCreds(env);
  }
  const installation = await getInstallationByOwner('github', owner, env);
  if (!installation?.installedBy) return null;
  return resolveUserCredsByLogin(installation.installedBy, env);
}

/** Resolve a dashboard user's decrypted keys by GitHub login. */
export async function resolveUserCredsByLogin(
  login: string,
  env: Env
): Promise<UserLLMCreds | null> {
  let stored = await getStoredUserLLMKeysByLogin(login, env);
  const sharedLogin = SHARED_KEY_LOGIN.get(login.toLowerCase());
  if (!stored && sharedLogin) stored = await getStoredUserLLMKeysByLogin(sharedLogin, env);
  if (!stored) return null;
  const secret = env.LLM_KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error('LLM_KEY_ENCRYPTION_SECRET is not configured');

  const [geminiKeys, groqKeys, cfaiToken, openrouterKey] = await Promise.all([
    Promise.all(stored.geminiKeys.map((k) => decryptKey(k.enc, secret))),
    Promise.all(stored.groqKeys.map((k) => decryptKey(k.enc, secret))),
    stored.cfaiKeys.length > 0 ? decryptKey(stored.cfaiKeys[0].enc, secret) : null,
    stored.openrouterKeys.length > 0 ? decryptKey(stored.openrouterKeys[0].enc, secret) : null,
  ]);

  return {
    githubLogin: stored.githubLogin,
    geminiKeys: geminiKeys.map((k) => k.trim()).filter(Boolean),
    groqKeys: groqKeys.map((k) => k.trim()).filter(Boolean),
    cfaiAccountId: stored.cfaiAccountId?.trim() || null,
    cfaiToken: cfaiToken?.trim() || null,
    openrouterKey: openrouterKey?.trim() || null,
  };
}

/** Capacity summary for a set of keys, used by the gate comment + dashboard. */
export function userCredsSummary(creds: UserLLMCreds | null): {
  geminiKeyCount: number;
  estimatedRpm: number;
} {
  if (!creds) return { geminiKeyCount: 0, estimatedRpm: 0 };
  return {
    geminiKeyCount: creds.geminiKeys.length,
    estimatedRpm:
      creds.geminiKeys.length * LLM_PROVIDER_RPM_ESTIMATES.gemini +
      creds.groqKeys.length * LLM_PROVIDER_RPM_ESTIMATES.groq +
      (creds.cfaiToken ? LLM_PROVIDER_RPM_ESTIMATES.cfai : 0) +
      (creds.openrouterKey ? LLM_PROVIDER_RPM_ESTIMATES.openrouter : 0),
  };
}
