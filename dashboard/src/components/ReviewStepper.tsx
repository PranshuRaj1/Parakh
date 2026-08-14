'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ReviewStatus } from '@parakh/shared';

const STEPS = [
  { id: 'FETCHING_DIFF', label: 'Fetching Diff' },
  { id: 'LOADING_RULES', label: 'Loading Repository Memory' },
  { id: 'REVIEWING_FILES', label: 'Assessing Logical Integrity' },
  { id: 'SCORING', label: 'Scoring & Evaluation' },
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
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const schedule = (delay: number) => {
      if (!mountedRef.current) return;
      timeoutIdRef.current = setTimeout(fetchProgress, delay);
    };

    const fetchProgress = async () => {
      if (!mountedRef.current) return;
      try {
        const res = await fetch(`/api/reviews/${reviewId}/progress`);
        if (!mountedRef.current) return;
        if (!res.ok) {
          // Transient failure (e.g. 5xx / rate-limit): keep polling with a
          // short backoff instead of silently stopping progress updates.
          schedule(5000);
          return;
        }
        const data = await res.json();
        setProgress(data);

        if (['QUEUED', 'RUNNING'].includes(data.status)) {
          schedule(3000);
        }
      } catch (err) {
        console.error('Polling error:', err);
        if (mountedRef.current) schedule(5000);
      }
    };

    fetchProgress();
    return () => {
      mountedRef.current = false;
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    };
  }, [reviewId]);

  if (!progress) {
    return (
      <div className="flex items-center justify-center p-16 text-[#c0c9c0]">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const currentStepIndex = STEPS.findIndex(s => s.id === progress.currentStep);
  const isFailed = progress.status === 'FAILED';
  const isCompletedOverall = progress.status === 'COMPLETED';

  // Overall status styling
  let statusText = 'IN PROGRESS';
  let statusColor = 'text-[#9bd3ad]';
  let statusGlow = 'rgba(197,255,214,0.15)';
  let glowColor = 'bg-[#9bd3ad]/5';
  let spinnerColor = 'border-[#9bd3ad]/40';
  
  if (isCompletedOverall) {
    statusText = 'COMPLETED';
    statusColor = 'text-[#00FF8C]';
    statusGlow = 'rgba(0,255,140,0.2)';
    glowColor = 'bg-[#00FF8C]/10';
    spinnerColor = 'border-[#00FF8C]/50';
  } else if (isFailed) {
    statusText = 'FAILED';
    statusColor = 'text-[#ffb4ab]';
    statusGlow = 'rgba(255,180,171,0.2)';
    glowColor = 'bg-[#ffb4ab]/10';
    spinnerColor = 'border-[#ffb4ab]/50';
  }

  return (
    <div className="w-full flex flex-col">
      {/* Central Area: Status + Timeline */}
      <div className="flex-1 flex flex-col lg:flex-row gap-20 items-center lg:items-start justify-center w-full">
        
        {/* Central Status Indicator */}
        <div className="relative flex-1 flex flex-col items-center justify-center min-h-[400px]">
          {/* Outer Pulse Glow */}
          <div className={`absolute inset-0 ${glowColor} rounded-full blur-[100px] -z-10 animate-pulse-ring`}></div>
          
          <div className="relative w-64 h-64 rounded-full border border-white/5 flex items-center justify-center bg-[#1c1b1b]/40 backdrop-blur-md"
               style={{ boxShadow: `0 0 60px 20px ${statusGlow}` }}>
            
            {/* Rotating rings (only if running) */}
            {!isCompletedOverall && !isFailed && (
              <>
                <div className={`absolute inset-[-1px] rounded-full border border-dashed ${spinnerColor} animate-spin-slow`}></div>
                <div className="absolute inset-4 rounded-full border border-white/5 animate-spin-slow" style={{ animationDirection: 'reverse', animationDuration: '12s' }}></div>
              </>
            )}

            <div className="text-center z-10 flex flex-col items-center gap-4">
              <span className={`material-symbols-outlined text-[48px] ${statusColor}`} style={{ fontVariationSettings: "'FILL' 1" }}>
                {isCompletedOverall ? 'check_circle' : isFailed ? 'error' : 'memory'}
              </span>
              <h1 className={`font-anybody ${statusColor} tracking-[0.2em] font-bold text-center leading-tight uppercase`}>
                PARAKH<br/>{statusText}
              </h1>
            </div>
          </div>
        </div>

        {/* Vertical Timeline Panel */}
        <div className="w-full lg:w-[450px] flex flex-col gap-8">
          <div className="glass-card rounded-xl p-8 relative">
            <h3 className="font-anybody text-2xl text-white mb-8 font-semibold">Execution Pipeline</h3>
            
            <div className="flex flex-col gap-6 relative z-10">
              {STEPS.map((step, index) => {
                const isCompleted = index < currentStepIndex || isCompletedOverall;
                const isCurrent = index === currentStepIndex && !isCompletedOverall;
                const isPending = index > currentStepIndex && !isCompletedOverall;
                const stepFailed = isCurrent && isFailed;

                // detail parsing for Current Step
                let detailText = isPending ? 'Pending' : (isCompleted ? 'Completed' : 'Running...');
                if (isCurrent && !isFailed) {
                   if (step.id === 'REVIEWING_FILES' && progress.stageReasonDetail) {
                      detailText = progress.stageReasonDetail;
                   } else if (progress.stepDetail) {
                      const { completedCount, totalCount } = progress.stepDetail as { completedCount?: number; totalCount?: number };
                      if (completedCount !== undefined && totalCount !== undefined) {
                         detailText = `${completedCount} / ${totalCount} files`;
                      }
                   }
                }
                if (stepFailed) detailText = progress.error || 'Failed';

                return (
                  <div key={step.id} className="flex items-start gap-4 relative group">
                    {/* Timeline connector (not on last item) */}
                    {index < STEPS.length - 1 && (
                      <div className="absolute left-[11px] top-[24px] bottom-[-24px] w-[2px] z-0" 
                           style={{
                             background: isCompleted 
                               ? 'linear-gradient(to bottom, #b6f0c8, rgba(255, 255, 255, 0.1))' 
                               : 'rgba(255, 255, 255, 0.1)'
                           }}>
                      </div>
                    )}

                    {/* Step Icon */}
                    {isCompleted ? (
                      <div className="w-6 h-6 rounded-full bg-[#b6f0c8] flex items-center justify-center z-10 shrink-0 border border-transparent shadow-[0_0_10px_rgba(182,240,200,0.3)]">
                        <span className="material-symbols-outlined text-[14px] text-[#00391f] font-bold">check</span>
                      </div>
                    ) : isCurrent ? (
                      <div className={`w-6 h-6 rounded-full bg-transparent border-2 flex items-center justify-center z-10 shrink-0 ${stepFailed ? 'border-[#ffb4ab] shadow-[0_0_15px_rgba(255,180,171,0.4)]' : 'border-[#9bd3ad] shadow-[0_0_15px_rgba(155,211,173,0.4)]'}`}>
                        {stepFailed ? (
                           <div className="w-2 h-2 rounded-full bg-[#ffb4ab]"></div>
                        ) : (
                           <div className="w-2 h-2 rounded-full bg-[#9bd3ad] animate-pulse"></div>
                        )}
                      </div>
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-[#353534] border border-white/20 flex items-center justify-center z-10 shrink-0"></div>
                    )}

                    {/* Step Content */}
                    <div className={`flex flex-col pt-0.5 ${isPending ? 'opacity-50' : ''}`}>
                      <span className={`font-dm-sans font-medium text-sm ${stepFailed ? 'text-[#ffb4ab]' : (isCurrent ? 'text-[#9bd3ad]' : 'text-white')}`}>
                        {step.label}
                      </span>
                      <span className={`font-space-mono text-[11px] mt-0.5 ${isCurrent ? 'text-[#9bd3ad]/70' : 'text-[#c0c9c0]'}`}>
                        {detailText}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Section: Model Reasoning */}
      {(!isCompletedOverall && !isFailed) && (
        <div className="mt-4 max-w-4xl mx-auto w-full">
          <div className="glass-card rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center gap-4">
            <div className="relative w-12 h-12 rounded-lg bg-[#0A0A0A] border border-white/10 flex items-center justify-center overflow-hidden shrink-0">
              <span className="material-symbols-outlined text-[#9bd3ad] text-2xl z-10">memory_alt</span>
              <div className="absolute inset-0 border-2 border-transparent border-t-[#9bd3ad] border-r-[#9bd3ad] rounded-lg animate-spin" style={{ animationDuration: '2s' }}></div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-1">
                <h4 className="font-space-mono text-[13px] text-white tracking-wider font-bold">MODEL REASONING</h4>
                <div className="px-2 py-0.5 rounded-full bg-[#9bd3ad]/10 border border-[#9bd3ad]/20">
                  <span className="font-space-mono text-[10px] text-[#9bd3ad] uppercase font-bold">Live</span>
                </div>
                {progress.eta && progress.eta.totalMs && (
                   <span className="font-space-mono text-xs text-[#c0c9c0] ml-auto">
                     ETA: ~{Math.ceil(progress.eta.totalMs / 1000)}s
                   </span>
                )}
              </div>
              <div className="font-dm-sans text-sm text-[#c0c9c0] leading-relaxed">
                {progress.activeStepLogs && progress.activeStepLogs.length > 0 ? (
                  <div className="flex flex-col gap-1 h-10 overflow-hidden justify-end">
                    {progress.activeStepLogs.slice(-2).map((log, i) => (
                      <div key={i} className="flex gap-2 text-sm">
                        <span className="text-[#9bd3ad]/70 font-space-mono shrink-0">[{log.code}]</span>
                        <span className="truncate">{log.detail}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="opacity-70 animate-pulse">Initializing inference engine...</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
