'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, Clock, RefreshCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ReviewStepEvent {
  id: string;
  review_id: string;
  step: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
  outcome: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  started_at: string;
}

interface FailureData {
  errorStep: string;
  errorMessage: string;
  errorStack: string | null;
  retryCount: number;
  githubDeliveryId: string | null;
  failedAt: string;
  realErrorStep: string | null;
  realErrorCode: string | null;
  realErrorMessage: string | null;
  sweptByCron: boolean;
  timeline: ReviewStepEvent[];
}

export function FailureDetail({ reviewId, canManage = true }: { reviewId: string; canManage?: boolean }) {
  const [data, setData] = useState<FailureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRetrying, setIsRetrying] = useState(false);
  const [stackExpanded, setStackExpanded] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reviews/${reviewId}/failure`)
      .then(res => res.ok ? res.json() : null)
      .then(d => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reviewId]);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      const res = await fetch(`/api/reviews/${reviewId}/retry`, { method: 'POST' });
      if (res.ok) {
        window.location.reload();
      } else {
        alert('Failed to retry review.');
      }
    } catch {
      alert('Error triggering retry.');
    } finally {
      setIsRetrying(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse bg-white/5 h-32 rounded-xl border border-white/10"></div>;
  }

  if (!data) return null;

  return (
    <div className="glass-card rounded-xl overflow-hidden max-w-4xl mx-auto mt-4">
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start">
            <AlertTriangle className="h-6 w-6 text-[#ffb4ab] mt-1" />
            <div className="ml-4">
              <h3 className="text-lg font-semibold text-white">Review Failed</h3>
              <p className="mt-1 text-sm text-[#ffb4ab] font-mono bg-[#93000a]/20 inline-block px-2 py-1 rounded border border-[#93000a]/30">
                Failed at: {data.errorStep}
              </p>
            </div>
          </div>
          {canManage && (
            <button
              onClick={handleRetry}
              disabled={isRetrying}
              className="flex items-center px-4 py-2 bg-[#93000a] hover:bg-[#93000a]/80 text-white text-sm font-medium rounded-md shadow-sm disabled:opacity-50 transition-colors"
            >
              <RefreshCcw className={`h-4 w-4 mr-2 ${isRetrying ? 'animate-spin' : ''}`} />
              {isRetrying ? 'Retrying...' : 'Retry Pipeline'}
            </button>
          )}
        </div>

        <div className="mt-6 bg-[#131313] rounded-md border border-white/10 p-4 shadow-sm">
          <h4 className="text-sm font-medium text-white mb-2">Error Message</h4>
          <pre className="text-sm text-[#ffb4ab] whitespace-pre-wrap font-mono break-all bg-[#000000] p-3 rounded">
            {data.errorMessage}
          </pre>

          {data.sweptByCron && (
            <p className="mt-3 text-xs text-[#f0e1c2] bg-[#41392c]/30 border border-[#f0e1c2]/20 rounded p-2">
              ⚠️ This review stalled and was swept by the cron watchdog — &quot;Stage
              timed out&quot; reflects the last recorded stage, not an underlying
              error. No step event captured a real failure.
            </p>
          )}

          {(data.realErrorMessage || data.realErrorCode) && (
            <div className="mt-4 bg-[#93000a]/15 border border-[#93000a]/30 rounded p-3">
              <h4 className="text-xs font-semibold text-[#ffb4ab] uppercase tracking-wide">
                Real Terminal Error
              </h4>
              <p className="mt-1 text-sm text-[#ffb4ab] font-mono break-all">
                {data.realErrorStep && <>At <span className="font-semibold">{data.realErrorStep}</span>: </>}
                {data.realErrorCode && <><span className="font-semibold">[{data.realErrorCode}]</span>{' '}</>}
                {data.realErrorMessage ?? 'No error message captured.'}
              </p>
            </div>
          )}

          {data.errorStack && (
            <div className="mt-4">
              <button
                onClick={() => setStackExpanded(!stackExpanded)}
                className="flex items-center text-sm font-medium text-[#c0c9c0] hover:text-white"
              >
                {stackExpanded ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
                {stackExpanded ? 'Hide Stack Trace' : 'View Stack Trace'}
              </button>
              {stackExpanded && (
                <pre className="mt-2 text-xs text-[#c0c9c0] overflow-x-auto bg-[#000000] p-3 rounded font-mono border border-white/10">
                  {data.errorStack}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-4 text-sm text-[#c0c9c0] border-t border-white/10 pt-4">
          <div className="flex items-center">
            <Clock className="h-4 w-4 mr-1.5" />
            Failed {formatDistanceToNow(new Date(data.failedAt), { addSuffix: true })}
          </div>
          <div>•</div>
          <div>Retry Count: <span className="font-medium text-white">{data.retryCount}</span></div>
          {data.githubDeliveryId && (
            <>
              <div>•</div>
              <div>GitHub Delivery ID: <span className="font-mono text-xs bg-white/5 px-1.5 py-0.5 rounded border border-white/10">{data.githubDeliveryId}</span></div>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-white/10 bg-white/5">
        <button
          onClick={() => setTimelineExpanded(!timelineExpanded)}
          className="w-full px-6 py-3 flex items-center justify-between text-sm font-medium text-[#c0c9c0] hover:text-white transition-colors"
        >
          <span>Execution Timeline</span>
          {timelineExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        
        {timelineExpanded && (
          <div className="px-6 pb-6 pt-2">
            <div className="space-y-3">
              {data.timeline.map((event, idx) => (
                <div key={event.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center">
                    <span className="text-[#c0c9c0] font-mono text-xs w-4">{idx + 1}.</span>
                    <span className={`ml-2 font-medium ${
                      event.status === 'COMPLETED' ? 'text-[#00FF8C]' :
                      event.status === 'FAILED' ? 'text-[#ffb4ab]' :
                      event.status === 'UNKNOWN' ? 'text-[#8a938b]' : 'text-[#c5c0ff]'
                    }`}>
                      {event.step}
                    </span>
                    <span className="ml-2 text-[#c0c9c0] font-mono text-xs">
                      [{event.status}]
                    </span>
                  </div>
                  {event.duration_ms !== null && (
                    <span className="text-[#c0c9c0] font-mono text-xs">
                      {event.duration_ms}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
