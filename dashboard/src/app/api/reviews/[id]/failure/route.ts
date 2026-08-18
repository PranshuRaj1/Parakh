import { NextResponse } from 'next/server';
import { getReview, getStepEventsForReview } from '@/lib/db';
import { getApprovedSession } from '@/lib/access';
import { requireRepoPermission } from '@/lib/repo-auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  let review;
  let stepRows;
  try {
    review = await getReview(id);
    if (!review || review.status !== 'FAILED') {
      return NextResponse.json({ error: 'not failed' }, { status: 404 });
    }
    if (!(await requireRepoPermission(review.repo, 'read', session))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    stepRows = await getStepEventsForReview(id);
  } catch (err) {
    console.error(`[dashboard] Failed to load failure detail for review ${id}:`, err);
    return NextResponse.json({ error: 'failed to load review' }, { status: 500 });
  }

  // The reviews row's error_step/error_message is usually the cron watchdog's
  // repaint of a stale row ("Stage timed out" at the last-seen stage). The real
  // terminal cause typically lives on a FAILED/TIMED_OUT step event.
  const events = (stepRows || []).map((r) => ({
    id: r.id,
    step: r.stage,
    status:
      r.outcome === 'COMPLETED' ? 'COMPLETED' :
      r.outcome === 'FAILED' || r.outcome === 'TIMED_OUT' ? 'FAILED' :
      r.outcome === null ? 'STARTED' : 'UNKNOWN',
    outcome: r.outcome,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    detail: r.detail,
    duration_ms: r.duration_ms,
    started_at: r.started_at,
  }));

  // Most recent step event that actually failed with a real error message.
  const terminalEvents = events
    .filter((event) => event.status === 'FAILED' && (event.errorMessage || event.errorCode))
    .toSorted((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  const realFailure = terminalEvents.at(-1) ?? null;

  // Swept-by-cron: no step event captured a real error, so the row was simply
  // marked "Stage timed out" by the watchdog without an underlying cause.
  const sweptByCron = !realFailure;

  return NextResponse.json({
    errorStep: review.error_step,
    errorMessage: review.error_message,
    errorStack: review.error_stack,
    retryCount: review.retry_count,
    githubDeliveryId: review.github_delivery_id,
    failedAt: review.failed_at,
    realErrorStep: realFailure?.step ?? null,
    realErrorCode: realFailure?.errorCode ?? null,
    realErrorMessage: realFailure?.errorMessage ?? null,
    sweptByCron,
    timeline: events,
  });
}
