'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, Clock, RefreshCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ReviewStepEvent {
  id: string;
  review_id: string;
  step: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED';
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  created_at: string;
}

interface FailureData {
  errorStep: string;
  errorMessage: string;
  errorStack: string | null;
  retryCount: number;
  githubDeliveryId: string | null;
  failedAt: string;
  timeline: ReviewStepEvent[];
}

export function FailureDetail({ reviewId }: { reviewId: string }) {
  const [data, setData] = useState<FailureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRetrying, setIsRetrying] = useState(false);
  const [stackExpanded, setStackExpanded] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  useEffect(() => {
    fetch(`/api/reviews/${reviewId}/failure`)
      .then(res => res.ok ? res.json() : null)
      .then(d => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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
    } catch (e) {
      alert('Error triggering retry.');
    } finally {
      setIsRetrying(false);
    }
  };

  if (loading) {
    return <div className="animate-pulse bg-gray-100 h-32 rounded-lg"></div>;
  }

  if (!data) return null;

  return (
    <div className="bg-red-50 rounded-lg shadow-sm border border-red-100 overflow-hidden max-w-3xl mx-auto mt-8">
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start">
            <AlertTriangle className="h-6 w-6 text-red-600 mt-1" />
            <div className="ml-4">
              <h3 className="text-lg font-semibold text-red-900">Review Failed</h3>
              <p className="mt-1 text-sm text-red-700 font-mono bg-red-100/50 inline-block px-2 py-1 rounded">
                Failed at: {data.errorStep}
              </p>
            </div>
          </div>
          <button
            onClick={handleRetry}
            disabled={isRetrying}
            className="flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-md shadow-sm disabled:opacity-50 transition-colors"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isRetrying ? 'animate-spin' : ''}`} />
            {isRetrying ? 'Retrying...' : 'Retry Pipeline'}
          </button>
        </div>

        <div className="mt-6 bg-white rounded-md border border-red-100 p-4 shadow-sm">
          <h4 className="text-sm font-medium text-gray-900 mb-2">Error Message</h4>
          <pre className="text-sm text-red-600 whitespace-pre-wrap font-mono break-all bg-red-50 p-3 rounded">
            {data.errorMessage}
          </pre>

          {data.errorStack && (
            <div className="mt-4">
              <button
                onClick={() => setStackExpanded(!stackExpanded)}
                className="flex items-center text-sm font-medium text-gray-600 hover:text-gray-900"
              >
                {stackExpanded ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
                {stackExpanded ? 'Hide Stack Trace' : 'View Stack Trace'}
              </button>
              {stackExpanded && (
                <pre className="mt-2 text-xs text-gray-500 overflow-x-auto bg-gray-50 p-3 rounded font-mono border border-gray-100">
                  {data.errorStack}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-4 text-sm text-gray-500 border-t border-red-100 pt-4">
          <div className="flex items-center">
            <Clock className="h-4 w-4 mr-1.5" />
            Failed {formatDistanceToNow(new Date(data.failedAt), { addSuffix: true })}
          </div>
          <div>•</div>
          <div>Retry Count: <span className="font-medium text-gray-900">{data.retryCount}</span></div>
          {data.githubDeliveryId && (
            <>
              <div>•</div>
              <div>GitHub Delivery ID: <span className="font-mono text-xs bg-white px-1.5 py-0.5 rounded border border-gray-200">{data.githubDeliveryId}</span></div>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-red-100 bg-gray-50">
        <button
          onClick={() => setTimelineExpanded(!timelineExpanded)}
          className="w-full px-6 py-3 flex items-center justify-between text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors"
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
                    <span className="text-gray-400 font-mono text-xs w-4">{idx + 1}.</span>
                    <span className={`ml-2 font-medium ${
                      event.status === 'COMPLETED' ? 'text-green-700' :
                      event.status === 'FAILED' ? 'text-red-700' : 'text-blue-700'
                    }`}>
                      {event.step}
                    </span>
                    <span className="ml-2 text-gray-500 font-mono text-xs">
                      [{event.status}]
                    </span>
                  </div>
                  {event.duration_ms !== null && (
                    <span className="text-gray-500 font-mono text-xs">
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
