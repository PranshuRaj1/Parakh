import { readFile } from 'node:fs/promises';

export interface GitHubSnapshot {
  baseSha: string;
  headSha: string;
  diff: string;
  files: Record<string, string>;
}

interface GhPrResponse {
  base: { sha: string };
  head: { sha: string };
  diff_url: string;
}

interface GhFile {
  filename: string;
  patch?: string;
  status: string;
}

interface GhCompareResponse {
  base_commit: { sha: string };
  head_commit: { sha: string };
  files: GhFile[];
  diff_url: string;
}

const GITHUB_API = 'https://api.github.com';

async function ghFetch<T>(
  url: string,
  token: string,
  accept = 'application/vnd.github+json'
): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub API ${response.status} for ${url}: ${body.slice(0, 200)}`
    );
  }
  return response.json() as Promise<T>;
}

async function fetchRawDiff(
  diffUrl: string,
  token: string
): Promise<string> {
  const response = await fetch(diffUrl, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3.diff',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch diff: ${response.status}`);
  }
  return response.text();
}

async function fetchFileContent(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  token: string
): Promise<string> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${sha}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) return '';
  return response.text();
}

function parseRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function fetchPrSnapshot(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  options: {
    fetchFiles?: boolean;
    fileBudget?: number;
  } = {}
): Promise<GitHubSnapshot | null> {
  const { fetchFiles = true, fileBudget = 50 } = options;

  try {
    const pr = await ghFetch<GhPrResponse>(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
      token
    );

    const baseSha = pr.base.sha;
    const headSha = pr.head.sha;

    const diff = await fetchRawDiff(pr.diff_url, token);

    const files: Record<string, string> = {};
    if (fetchFiles) {
      const compare = await ghFetch<GhCompareResponse>(
        `${GITHUB_API}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
        token
      );

      const changedFiles = compare.files
        .filter((f) => f.status !== 'removed')
        .slice(0, fileBudget);

      await Promise.all(
        changedFiles.map(async (file) => {
          const content = await fetchFileContent(
            owner,
            repo,
            headSha,
            file.filename,
            token
          );
          if (content) {
            files[file.filename] = content;
          }
        })
      );
    }

    return { baseSha, headSha, diff, files };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Warning: failed to fetch PR ${owner}/${repo}#${prNumber}: ${message}\n`
    );
    return null;
  }
}

export async function fetchMartianPrSnapshot(
  prUrl: string,
  token: string,
  options: {
    fetchFiles?: boolean;
    fileBudget?: number;
  } = {}
): Promise<GitHubSnapshot | null> {
  const parsed = prUrl.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!parsed) {
    process.stderr.write(`Warning: cannot parse PR URL: ${prUrl}\n`);
    return null;
  }
  return fetchPrSnapshot(parsed[1], parsed[2], Number(parsed[3]), token, options);
}

export interface SnapshotCacheEntry {
  key: string;
  snapshot: GitHubSnapshot;
}

export class SnapshotCache {
  private cache = new Map<string, GitHubSnapshot>();

  async getOrFetch(
    key: string,
    fetcher: () => Promise<GitHubSnapshot | null>
  ): Promise<GitHubSnapshot | null> {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    const snapshot = await fetcher();
    if (snapshot) {
      this.cache.set(key, snapshot);
    }
    return snapshot;
  }

  async save(path: string): Promise<void> {
    const entries: SnapshotCacheEntry[] = [];
    for (const [key, snapshot] of this.cache) {
      entries.push({ key, snapshot });
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify(entries, null, 2));
  }

  async load(path: string): Promise<void> {
    try {
      const content = await readFile(path, 'utf8');
      const entries = JSON.parse(content) as SnapshotCacheEntry[];
      for (const entry of entries) {
        this.cache.set(entry.key, entry.snapshot);
      }
    } catch {
      // Cache file doesn't exist yet
    }
  }

  get size(): number {
    return this.cache.size;
  }
}
