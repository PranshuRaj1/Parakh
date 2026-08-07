'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, AlertCircle } from 'lucide-react';
import type { ReviewStatus } from '@parakh/shared';

const STEPS = [
  { id: 'FETCHING_DIFF', label: 'Fetching Diff' },
  { id: 'LOADING_RULES', label: 'Loading Rules' },
  { id: 'REVIEWING_FILES', label: 'Reviewing Files' },
  { id: 'SCORING', label: 'Scoring' },
  { id: 'POSTING_COMMENT', label: 'Posting Results' },
  { id: 'REACTING', label: 'Reacting' }
];

interface EtaResult {
  totalMs: number | null;
  basis: 'repo' | 'global' | 'insufficient_data';
  sampleCount: number;
}

interface ProgressResponse {
  status: ReviewStatus;
  currentStep: string | null;
  stepDetail: Record<string, unknown> | null;
  stageReasonCode?: string | null;
  stageReasonDetail?: string | null;
  startedAt: string | null;
  eta: EtaResult | null;
  activeStepLogs?: { at: string; code: string; detail: string }[];
  error?: string;
}

export function ReviewStepper({ reviewId }: { reviewId: string }) {
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const fetchProgress = async () => {
      try {
        const res = await fetch(`/api/reviews/${reviewId}/progress`);
        if (!res.ok) {
          if (res.status !== 404) {
             console.error('Failed to fetch progress');
          }
          return;
        }
        const data = await res.json();
        setProgress(data);

        if (['QUEUED', 'RUNNING'].includes(data.status)) {
          timeoutId = setTimeout(fetchProgress, 3000);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    };

    fetchProgress();

    return () => clearTimeout(timeoutId);
  }, [reviewId]);

  if (!progress) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-500">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        <span>Loading status...</span>
      </div>
    );
  }

  const currentStepIndex = STEPS.findIndex(s => s.id === progress.currentStep);
  const isFailed = progress.status === 'FAILED';

  return (
    <div className="bg-white rounded-lg shadow p-6 max-w-2xl mx-auto border border-gray-100">
      <h3 className="text-lg font-semibold text-gray-800 mb-6">Review Progress</h3>
      
      <div className="space-y-6">
        {STEPS.map((step, index) => {
          const isCompleted = index < currentStepIndex || progress.status === 'COMPLETED';
          const isCurrent = index === currentStepIndex && progress.status !== 'COMPLETED';
          
          let icon = <Circle className="h-5 w-5 text-gray-300" />;
          let textColor = "text-gray-500";
          
          if (isCompleted) {
            icon = <CheckCircle2 className="h-5 w-5 text-green-500" />;
            textColor = "text-gray-900";
          } else if (isCurrent) {
            if (isFailed) {
              icon = <AlertCircle className="h-5 w-5 text-red-500" />;
              textColor = "text-red-600 font-medium";
            } else {
              icon = <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />;
              textColor = "text-blue-600 font-medium";
            }
          }

          let detailText = null;
          if (isCurrent && step.id === 'REVIEWING_FILES') {
            // Live per-file progress from stage_reason_detail: "file 3/8: src/foo.ts"
            const fileProgress = progress.stageReasonDetail?.match(/^file (\d+)\/(\d+): (.+)$/);
            if (fileProgress) {
              const [, index, total, file] = fileProgress;
              detailText = (
                <div className="flex flex-col mt-1">
                  <span className="ml-2 text-sm text-gray-500">({index} / {total} files)</span>
                  <span className="ml-2 text-xs font-mono text-violet-600 truncate max-w-full">
                    Now reviewing: {file}
                  </span>
                </div>
              );
            } else if (progress.stepDetail) {
              const { completedCount, totalCount } = progress.stepDetail as { completedCount?: number; totalCount?: number };
              if (completedCount !== undefined && totalCount !== undefined) {
                detailText = <span className="ml-2 text-sm text-gray-500">({completedCount} / {totalCount} files)</span>;
              }
            } else if (progress.stageReasonDetail) {
              detailText = <span className="ml-2 text-sm text-gray-500">{progress.stageReasonDetail}</span>;
            }
          }

          return (
            <div key={step.id} className="flex items-center">
              <div className="flex-shrink-0">{icon}</div>
              <div className={`ml-3 text-sm ${textColor}`}>
                {step.label}
                {detailText}
              </div>
            </div>
          );
        })}
      </div>

      {progress.status === 'RUNNING' && progress.eta && (
        <div className="mt-8 pt-4 border-t border-gray-100 text-sm">
          {progress.eta.basis === 'insufficient_data' ? (
            <p className="text-gray-500 flex items-center">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Estimating... (warming up, not enough history yet)
            </p>
          ) : (
            <p className="text-gray-600 font-medium">
              ~{Math.ceil((progress.eta.totalMs ?? 0) / 1000)}s remaining 
              <span className="text-gray-400 font-normal ml-1">
                (based on your last {progress.eta.sampleCount} {progress.eta.basis === 'repo' ? 'reviews on this repo' : 'global reviews'})
              </span>
            </p>
          )}
        </div>
      )}

      {progress.activeStepLogs && progress.activeStepLogs.length > 0 && (
        <div className="mt-8 pt-4 border-t border-gray-100">
           <div className="flex items-center justify-between mb-3">
             <h4 className="text-sm font-medium text-gray-700">Live Stage Logs</h4>
             <span className="flex h-2 w-2 relative">
               <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
               <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
             </span>
           </div>
           <div className="bg-gray-50 rounded-md border border-gray-200 p-3 max-h-48 overflow-y-auto">
             <ul className="space-y-1.5 text-xs font-mono text-gray-600">
                {progress.activeStepLogs.map((log, i) => (
                   <li key={i} className="flex">
                      <span className="text-gray-400 w-16 flex-shrink-0">
                         {new Date(log.at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className={`font-semibold mr-2 ${log.code === 'RATE_LIMITED_BACKOFF' ? 'text-yellow-600' : 'text-blue-600'}`}>
                         [{log.code}]
                      </span>
                      <span className="text-gray-700">{log.detail}</span>
                   </li>
                ))}
             </ul>
           </div>
        </div>
      )}
    </div>
  );
}
