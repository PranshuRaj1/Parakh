'use client';

import { useState } from 'react';
import type { DashboardUser } from '@/lib/dashboard-users';

export default function AdminUsers({ initialUsers }: { initialUsers: DashboardUser[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  async function updateStatus(login: string, status: 'approved' | 'declined') {
    setSaving(login);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(login)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Unable to update this request');
      const updated = await response.json() as DashboardUser;
      setUsers((current) => current.map((user) => user.githubLogin === login ? updated : user));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update this request');
    } finally {
      setSaving(null);
    }
  }

  const pending = users.filter((user) => user.status === 'pending');
  const reviewed = users.filter((user) => user.status !== 'pending');

  return (
    <main className="w-full px-6 pt-10 pb-16">
      <div className="max-w-[1000px] mx-auto">
        <div className="mb-8">
          <p className="font-space-mono text-xs uppercase tracking-widest text-[#00FF8C] mb-2">Admin</p>
          <h1 className="font-anybody text-4xl font-bold text-white">Access requests</h1>
          <p className="font-dm-sans text-[#c0c9c0] mt-2">Approve users before they can view repositories, reviews, or connections.</p>
        </div>
        {error && <div className="mb-6 rounded-xl border border-[#93000a]/30 bg-[#93000a]/20 p-4 text-[#ffdad6] font-dm-sans text-sm">{error}</div>}
        <section className="glass-card rounded-2xl p-6 mb-8">
          <h2 className="font-anybody text-xl font-bold text-white mb-4">Pending ({pending.length})</h2>
          {pending.length === 0 ? (
            <p className="font-dm-sans text-[#c0c9c0]">No pending requests.</p>
          ) : (
            <div className="space-y-3">
              {pending.map((user) => <UserRow key={user.githubId} user={user} saving={saving === user.githubLogin} onUpdate={updateStatus} />)}
            </div>
          )}
        </section>
        <section className="glass-card rounded-2xl p-6">
          <h2 className="font-anybody text-xl font-bold text-white mb-4">Reviewed ({reviewed.length})</h2>
          {reviewed.length === 0 ? <p className="font-dm-sans text-[#c0c9c0]">No reviewed users yet.</p> : <div className="space-y-3">{reviewed.map((user) => <UserRow key={user.githubId} user={user} saving={saving === user.githubLogin} onUpdate={updateStatus} />)}</div>}
        </section>
      </div>
    </main>
  );
}

function UserRow({ user, saving, onUpdate }: { user: DashboardUser; saving: boolean; onUpdate: (login: string, status: 'approved' | 'declined') => void }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
      <div>
        <a href={`https://github.com/${encodeURIComponent(user.githubLogin)}`} target="_blank" rel="noreferrer" className="font-anybody text-white hover:text-[#00FF8C]">{user.githubLogin}</a>
        <p className="font-dm-sans text-sm text-[#c0c9c0]">{user.email ?? 'No public email'} · {new Date(user.requestedAt).toISOString()}</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-space-mono text-xs uppercase text-[#c5c0ff]">{user.status}</span>
        <button onClick={() => onUpdate(user.githubLogin, 'approved')} disabled={saving} className="rounded-lg bg-[#00FF8C] px-3 py-2 text-sm font-bold text-black disabled:opacity-40">Approve</button>
        <button onClick={() => onUpdate(user.githubLogin, 'declined')} disabled={saving} className="rounded-lg border border-[#ffb4ab]/50 px-3 py-2 text-sm font-bold text-[#ffb4ab] disabled:opacity-40">Decline</button>
      </div>
    </div>
  );
}
