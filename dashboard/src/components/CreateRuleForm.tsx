'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

export default function CreateRuleForm({ repo, canManage = true }: { repo: string; canManage?: boolean }) {
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<'high' | 'normal' | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo,
          body,
          priority: priority || undefined, // undefined lets Gemini auto-classify
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create rule');
      }

      setBody('');
      setPriority('');
      // In a real app we'd mutate SWR or call a router.refresh() here.
      // For now we'll just reload the page to see the new rule.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create rule');
    } finally {
      setLoading(false);
    }
  }

  if (!canManage) {
    return (
      <p className="font-dm-sans text-sm text-[#c0c9c0]">
        You need write access to this repository to create rules.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-label="Manually add a rule">
      {error && <div className="mb-4 text-sm text-[#ffdad6] bg-[#93000a]/20 p-3 rounded-md border border-[#93000a]">{error}</div>}
      <div className="space-y-4">
        <div>
          <label htmlFor="body" className="block font-dm-sans text-sm text-[#c0c9c0] mb-1">
            Rule Description
          </label>
          <textarea
            id="body"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="e.g. Always use early returns instead of nested if statements."
            className="w-full bg-[#000000] border border-white/20 rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#00FF8C] focus:ring-1 focus:ring-[#00FF8C] transition-all font-dm-sans resize-y"
            required
          />
        </div>
        <div>
          <label htmlFor="priority" className="block font-dm-sans text-sm text-[#c0c9c0] mb-1">
            Priority (Optional)
          </label>
          <select
            id="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as 'high' | 'normal' | '')}
            className="w-full bg-[#000000] border border-white/20 rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#00FF8C] focus:ring-1 focus:ring-[#00FF8C] transition-all font-dm-sans"
          >
            <option value="">Auto-detect via AI</option>
            <option value="normal">Normal (Style/Convention)</option>
            <option value="high">High (Security/Architecture)</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={loading || !body.trim()}
          className="w-full mt-4 bg-[#00FF8C] text-[#000000] font-anybody py-2.5 rounded font-bold hover:brightness-110 transition-all shadow-[0_0_10px_rgba(0,255,140,0.3)] flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          Add Rule
        </button>
      </div>
    </form>
  );
}
