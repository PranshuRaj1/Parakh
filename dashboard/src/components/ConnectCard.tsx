'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { GitBranch, Plug, Unplug, RefreshCw } from 'lucide-react';

const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/pranshu-parakh';

export interface ConnectionInfo {
  provider: string;
  displayName: string;
  url: string;
}

export interface InstallationInfo {
  provider: string;
  owner: string;
  status: 'active' | 'removed' | 'suspended';
  repos: string[];
  installedBy: string | null;
  installedAt: string;
}

export default function ConnectCard() {
  const router = useRouter();
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [installations, setInstallations] = useState<InstallationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listRes = await fetch('/api/connect');
      if (!listRes.ok) throw new Error('Failed to load connections');
      // providers come with their install url from the worker, so the list
      // is the single source of truth for the "Connect" buttons.
      const list = await listRes.json();
      setInstallations(list.installations ?? []);
      setConnections(list.providers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const disconnect = async (provider: string, owner: string) => {
    setRemoving(`${provider}/${owner}`);
    try {
      const res = await fetch('/api/connect/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, owner }),
      });
      if (!res.ok) throw new Error('Failed to disconnect');
      setInstallations((prev) => prev.filter((i) => !(i.provider === provider && i.owner === owner)));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setRemoving(null);
    }
  };

  const connected = installations.filter((i) => i.status === 'active');

  return (
    <div className="glass-card rounded-2xl p-6 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="font-anybody text-lg font-bold text-white flex items-center gap-2">
          <Plug className="w-5 h-5 text-[#00FF8C]" />
          Connected Repositories
        </h2>
        <button
          onClick={load}
          disabled={loading}
          className="text-[#c0c9c0] hover:text-white transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-[#93000a]/30 bg-[#93000a]/20 p-4 text-[#ffdad6] font-dm-sans text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-[#c0c9c0] font-dm-sans text-sm animate-pulse">Loading your connections…</div>
      ) : connected.length === 0 ? (
        <div className="rounded-xl bg-white/5 border border-white/5 p-6 text-center">
          <GitBranch className="w-8 h-8 text-[#c5c0ff] mx-auto mb-3" />
          <p className="font-dm-sans text-[#c0c9c0] text-sm">
            No repositories connected yet. Install the app to start reviewing pull requests.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {connected.map((inst) => (
            <div key={`${inst.provider}/${inst.owner}`} className="rounded-xl bg-white/5 border border-white/5 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md bg-[#00FF8C]/15 text-[#00FF8C] px-2 py-0.5 font-space-mono text-xs font-bold">
                    {inst.provider}
                  </span>
                  <span className="font-anybody font-bold text-white">{inst.owner}</span>
                  <span className="text-[#c0c9c0] font-dm-sans text-xs">
                    {inst.repos.length} repo{inst.repos.length === 1 ? '' : 's'}
                  </span>
                </div>
                <button
                  onClick={() => disconnect(inst.provider, inst.owner)}
                  disabled={removing === `${inst.provider}/${inst.owner}`}
                  className="inline-flex items-center gap-1.5 text-xs font-dm-sans text-[#c0c9c0] hover:text-[#ff8a8a] transition-colors disabled:opacity-40"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  {removing === `${inst.provider}/${inst.owner}` ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </div>
              {inst.repos.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {inst.repos.slice(0, 12).map((repo) => (
                    <Link
                      key={repo}
                      href={`/pulls/${repo}`}
                      className="rounded-md bg-white/[0.06] px-2 py-0.5 font-space-mono text-xs text-[#c0c9c0] hover:bg-[#c5c0ff]/15 hover:text-[#c5c0ff] transition-colors"
                    >
                      {repo}
                    </Link>
                  ))}
                  {inst.repos.length > 12 && (
                    <span className="font-space-mono text-xs text-[#c0c9c0]">
                      +{inst.repos.length - 12} more
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="pt-4 border-t border-white/10">
        <p className="font-dm-sans text-xs text-[#c0c9c0] mb-3">
          Authorize Parakh, then choose the repositories where it should review pull requests.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href={GITHUB_APP_INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 bg-[#00FF8C] text-black font-anybody font-bold py-2.5 px-5 rounded-lg hover:brightness-110 transition-all text-sm"
          >
            <Plug className="w-4 h-4" />
            Authorize & install GitHub
          </a>
          {connections.filter((conn) => conn.provider !== 'github').map((conn) => (
            <a
              key={conn.provider}
              href={conn.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 bg-[#00FF8C] text-black font-anybody font-bold py-2.5 px-5 rounded-lg hover:brightness-110 transition-all text-sm"
            >
              <Plug className="w-4 h-4" />
              Authorize & install {conn.displayName}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
