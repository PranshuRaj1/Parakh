export type RepoPermission = 'admin' | 'write' | 'read' | 'none';

const GITHUB_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

const READ_LEVELS: RepoPermission[] = ['admin', 'write', 'read'];
const WRITE_LEVELS: RepoPermission[] = ['admin', 'write'];

const cache = new Map<string, { permission: RepoPermission; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function isRepoString(repo: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo);
}

async function githubFetch<T>(url: string, token: string): Promise<{ ok: boolean; data: T | null }> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'parakh-dashboard',
      },
      next: { revalidate: 0 },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, data: null };
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    console.warn('[repo-auth] GitHub API request failed:', url, error);
    return { ok: false, data: null };
  }
}

export async function getRepoPermission(repo: string, login: string, token: string): Promise<RepoPermission> {
  const cacheKey = `${login}:${repo}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.permission;

  let permission: RepoPermission = 'none';
  if (isRepoString(repo)) {
    const { ok, data } = await githubFetch<{ permission: string }>(
      `${GITHUB_API_BASE}/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      token
    );
    if (ok && ['admin', 'write', 'read', 'none'].includes(data?.permission ?? '')) {
      permission = data!.permission as RepoPermission;
    }
  }

  cache.set(cacheKey, { permission, expiresAt: Date.now() + CACHE_TTL_MS });
  return permission;
}

export interface AuthSession {
  user?: { login?: string | null };
  accessToken?: string | null;
}

export async function requireRepoPermission(
  repo: string,
  level: 'read' | 'write',
  session: AuthSession | null
): Promise<boolean> {
  const login = session?.user?.login;
  const token = session?.accessToken;
  if (!session || !login || !token) return false;

  const permission = await getRepoPermission(repo, login, token);
  const allowed = level === 'read' ? READ_LEVELS : WRITE_LEVELS;
  return allowed.includes(permission);
}

export async function getUserRepos(token: string): Promise<string[]> {
  const url = `${GITHUB_API_BASE}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`;
  const { ok, data } = await githubFetch<Array<{ full_name: string }>>(url, token);
  if (!ok) {
    console.warn('[repo-auth] getUserRepos failed — check the session token has the repo scope:', url);
    return [];
  }
  return (data ?? []).map((r) => r.full_name);
}