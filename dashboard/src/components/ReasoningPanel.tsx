'use client';

import { useState, useEffect } from 'react';
import { Brain, ChevronDown, ChevronUp, Loader2, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ReasoningRow {
  id: string;
  review_id: string;
  file: string;
  model: string | null;
  thinking: string | null;
  error_message: string | null;
  created_at: string;
  expires_at: string;
}

interface ReasoningResponse {
  reviewId: string;
  reasoning: ReasoningRow[];
}

export function ReasoningPanel({ reviewId }: { reviewId: string }) {
  const [data, setData] = useState<ReasoningResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reviews/${reviewId}/reasoning`)
      .then(res => (res.ok ? res.json() : null))
      .then(d => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reviewId]);

  const toggle = (id: string) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  if (loading) {
    return <div className="animate-pulse bg-white/5 h-32 rounded-xl border border-white/10 mt-4"></div>;
  }

  const rows = data?.reasoning ?? [];
  const hasAnyContent = rows.length > 0;
  const failedCount = rows.filter(r => r.error_message).length;

  return (
    <div className="glass-card rounded-xl p-4 max-w-4xl mx-auto mt-4 border-white/10">
      <div className="flex items-center gap-3 mb-3">
        <Brain className="h-5 w-5 text-[#c5c0ff]" />
        <h3 className="text-base font-semibold text-white">Model Reasoning</h3>
        {hasAnyContent && failedCount > 0 && (
          <span className="text-xs font-medium text-[#ffb4ab] bg-[#93000a]/20 border border-[#93000a]/30 rounded-full px-2.5 py-0.5">
            {failedCount} failed
          </span>
        )}
      </div>

      {!hasAnyContent ? (
        <p className="text-sm text-[#c0c9c0] flex items-center gap-2">
          <Loader2 className="h-4 w-4 text-[#c0c9c0]" />
          {'Reasoning unavailable — no per-file thoughts were captured for this review (either the feature is disabled or Google skipped thought generation).'}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map(row => {
            const isOpen = !!expanded[row.id];
            const isError = !!row.error_message;
            return (
              <div key={row.id} className="rounded-md border border-white/10 overflow-hidden bg-[#131313]">
                <button
                  onClick={() => toggle(row.id)}
                  className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center min-w-0">
                    <span
                      className={`h-2 w-2 rounded-full flex-shrink-0 mr-3 ${isError ? 'bg-[#ffb4ab]' : 'bg-[#c5c0ff]'}`}
                    />
                    <span className="font-mono text-xs text-white truncate">{row.file}</span>
                  </div>
                  <div className="flex items-center flex-shrink-0 ml-3">
                    <span className="text-xs text-[#c0c9c0] mr-3">
                      {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                    </span>
                    {isOpen ? <ChevronUp className="h-4 w-4 text-[#c0c9c0]" /> : <ChevronDown className="h-4 w-4 text-[#c0c9c0]" />}
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 pb-4">
                    <div className="flex items-center gap-3 mb-2">
                      {row.model && (
                        <span className="text-xs text-[#c0c9c0] font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                          {row.model}
                        </span>
                      )}
                      <span className="text-xs text-[#c0c9c0]">
                        expires {formatDistanceToNow(new Date(row.expires_at), { addSuffix: true })}
                      </span>
                    </div>

                    {isError ? (
                      <div className="flex items-start gap-2 text-sm text-[#ffb4ab] bg-[#93000a]/20 border border-[#93000a]/30 rounded-md p-3">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                        <span className="whitespace-pre-wrap break-all font-mono text-xs">{row.error_message}</span>
                      </div>
                    ) : row.thinking ? (
                      <pre className="text-xs text-[#c0c9c0] whitespace-pre-wrap break-words font-mono bg-[#000000] border border-white/10 rounded-md p-3 max-h-96 overflow-y-auto">
                        {row.thinking}
                      </pre>
                    ) : (
                      <p className="text-xs text-[#c0c9c0]">Reasoning unavailable — Google skipped thought generation for this file.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
