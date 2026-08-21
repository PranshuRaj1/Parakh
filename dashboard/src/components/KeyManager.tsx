'use client';

import { useState } from 'react';
import { KeyRound, Save, ShieldCheck } from 'lucide-react';

// Mirrors LLM_PROVIDER_RPM_ESTIMATES in @parakh/shared (the worker's source of
// truth). Kept local because Turbopack can't resolve the shared package's
// .js-suffixed TS source at runtime — only type imports cross the boundary.
const RPM_PER_KEY = {
  gemini: 15,
  groq: 30,
  cfai: 50,
  openrouter: 20,
} as const;

export interface StoredKeysView {
  geminiKeys: string[];
  groqKeys: string[];
  cfaiKeys: string[];
  cfaiAccountId: string | null;
  openrouterKeys: string[];
  updatedAt: string;
}

export interface KeysState {
  stored: boolean;
  keys: StoredKeysView | null;
}

interface KeyManagerProps {
  login: string;
  initialKeys: KeysState;
  usage: { totalCalls: number; completedCalls: number };
}

const PROVIDERS = [
  {
    id: 'geminiKeys' as const,
    name: 'Gemini',
    url: 'https://aistudio.google.com/apikey',
    rpm: RPM_PER_KEY.gemini,
    placeholder: 'One API key per line (AIza…)',
    note: 'Primary provider — reviews are gated on at least one Gemini key.',
  },
  {
    id: 'groqKeys' as const,
    name: 'Groq',
    url: 'https://console.groq.com/keys',
    rpm: RPM_PER_KEY.groq,
    placeholder: 'One API key per line (gsk_…)',
    note: 'Fallback provider when Gemini rate-limits.',
  },
  {
    id: 'openrouterKeys' as const,
    name: 'OpenRouter',
    url: 'https://openrouter.ai/settings/keys',
    rpm: RPM_PER_KEY.openrouter,
    placeholder: 'One API key per line (sk-or-…)',
    note: 'Secondary fallback provider.',
  },
];

function splitKeys(value: string): string[] {
  return value.split('\n').map((k) => k.trim()).filter(Boolean);
}

export default function KeyManager({ login, initialKeys, usage }: KeyManagerProps) {
  const [storedView, setStoredView] = useState<StoredKeysView | null>(initialKeys.keys);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [geminiInput, setGeminiInput] = useState('');
  const [groqInput, setGroqInput] = useState('');
  const [cfaiAccountId, setCfaiAccountId] = useState(storedView?.cfaiAccountId ?? '');
  const [cfaiTokenInput, setCfaiTokenInput] = useState('');
  const [openrouterInput, setOpenrouterInput] = useState('');

  const estimatedRpm =
    splitKeys(geminiInput).length * PROVIDERS[0].rpm +
    splitKeys(groqInput).length * PROVIDERS[1].rpm +
    (splitKeys(cfaiTokenInput).length > 0 ? RPM_PER_KEY.cfai : 0) +
    splitKeys(openrouterInput).length * PROVIDERS[2].rpm;

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          geminiKeys: splitKeys(geminiInput),
          groqKeys: splitKeys(groqInput),
          cfaiKeys: splitKeys(cfaiTokenInput),
          cfaiAccountId: cfaiAccountId.trim() || null,
          openrouterKeys: splitKeys(openrouterInput),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save keys');
      setStoredView(data.keys);
      setGeminiInput('');
      setGroqInput('');
      setCfaiTokenInput('');
      setOpenrouterInput('');
      setMessage('Keys saved — they are encrypted at rest and only used to review your repos.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save keys');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card rounded-2xl p-6 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="font-anybody text-lg font-bold text-white flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-[#00FF8C]" />
          Your LLM API keys
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-[#c5c0ff]/15 text-[#c5c0ff] px-2 py-1 font-space-mono text-xs font-bold">
          <ShieldCheck className="w-3.5 h-3.5" />
          encrypted at rest
        </span>
      </div>

      <p className="font-dm-sans text-sm text-[#c0c9c0]">
        Reviews on your repositories bill against <strong className="text-white">your own keys</strong> —
        one rate-limit bucket per key, exactly like shared keys. Keys are encrypted with a secret that
        never leaves the worker, and only you can see how many you have stored.
      </p>

      {error && (
        <div className="rounded-xl border border-[#93000a]/30 bg-[#93000a]/20 p-4 text-[#ffdad6] font-dm-sans text-sm">
          {error}
        </div>
      )}
      {message && (
        <div className="rounded-xl border border-[#00FF8C]/30 bg-[#00FF8C]/10 p-4 text-[#b7ffd8] font-dm-sans text-sm">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {PROVIDERS.map((provider) => (
          <div key={provider.id} className="rounded-xl bg-white/5 border border-white/5 p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="font-anybody font-bold text-white">{provider.name}</span>
              <a href={provider.url} target="_blank" rel="noreferrer" className="text-xs font-dm-sans text-[#c5c0ff] hover:underline">
                get a key ↗
              </a>
            </div>
            <textarea
              value={provider.id === 'geminiKeys' ? geminiInput : provider.id === 'groqKeys' ? groqInput : openrouterInput}
              onChange={(e) => {
                if (provider.id === 'geminiKeys') setGeminiInput(e.target.value);
                else if (provider.id === 'groqKeys') setGroqInput(e.target.value);
                else setOpenrouterInput(e.target.value);
              }}
              rows={3}
              placeholder={provider.placeholder}
              spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 font-space-mono text-xs text-white placeholder:text-[#5c645c] focus:outline-none focus:border-[#00FF8C]/60"
            />
            <div className="flex items-center justify-between">
              <p className="font-dm-sans text-xs text-[#5c645c]">{provider.note}</p>
              {storedView && storedView[provider.id].length > 0 && (
                <span className="font-space-mono text-xs text-[#c0c9c0]">
                  stored: {storedView[provider.id].join(', ')}
                </span>
              )}
            </div>
          </div>
        ))}

        <div className="rounded-xl bg-white/5 border border-white/5 p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-anybody font-bold text-white">Cloudflare Workers AI</span>
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer" className="text-xs font-dm-sans text-[#c5c0ff] hover:underline">
              get a token ↗
            </a>
          </div>
          <input
            value={cfaiAccountId}
            onChange={(e) => setCfaiAccountId(e.target.value)}
            placeholder="Account ID"
            spellCheck={false}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 font-space-mono text-xs text-white placeholder:text-[#5c645c] focus:outline-none focus:border-[#00FF8C]/60"
          />
          <textarea
            value={cfaiTokenInput}
            onChange={(e) => setCfaiTokenInput(e.target.value)}
            rows={2}
            placeholder="API token"
            spellCheck={false}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 font-space-mono text-xs text-white placeholder:text-[#5c645c] focus:outline-none focus:border-[#00FF8C]/60"
          />
          <div className="flex items-center justify-between">
            <p className="font-dm-sans text-xs text-[#5c645c]">Embedding fallback when Gemini is exhausted.</p>
            {storedView && storedView.cfaiKeys.length > 0 && (
              <span className="font-space-mono text-xs text-[#c0c9c0]">stored token</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="font-dm-sans text-sm text-[#c0c9c0]">
          Projected capacity with the keys you&apos;ve typed:{' '}
          <span className="font-space-mono text-[#00FF8C] font-bold">~{estimatedRpm} req/min</span>
          {storedView && (
            <span className="ml-3 text-xs text-[#5c645c]">
              {storedView.geminiKeys.length > 0 ? 'saved as of ' : 'nothing saved yet'} {new Date(storedView.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 bg-[#00FF8C] text-black font-anybody font-bold py-2.5 px-6 rounded-lg hover:brightness-110 transition-all text-sm disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save keys'}
        </button>
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-white/5 p-4 font-dm-sans text-xs text-[#c0c9c0]">
        Usage attributed to your keys over the last 24h:{' '}
        <span className="font-space-mono text-white font-bold">{usage.totalCalls}</span> file reviews attempted,{' '}
        <span className="font-space-mono text-white font-bold">{usage.completedCalls}</span> completed.
        Signed in as <span className="font-space-mono text-[#00FF8C]">{login}</span>.
      </div>
    </div>
  );
}