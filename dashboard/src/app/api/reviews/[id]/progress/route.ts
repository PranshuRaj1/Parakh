import { NextResponse } from 'next/server';
import { getReview, getActiveStepEvent, getLatestReviewingFilesDetail } from '@/lib/db';
import { computeEta } from '@/lib/eta';
import { getServerSession } from 'next-auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const review = await getReview(id);
  if (!review) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const eta = review.status === 'RUNNING' ? await computeEta(id, review.repo) : null;

  let activeStepLogs = null;
  if (review.status === 'RUNNING') {
    const activeStep = await getActiveStepEvent(id);
    if (activeStep && activeStep.reason_transitions) {
      activeStepLogs = activeStep.reason_transitions;
    }
  }

  let stepDetail = null;
  if (review.current_stage === 'REVIEWING_FILES') {
    stepDetail = await getLatestReviewingFilesDetail(id);
  }

  return NextResponse.json({
    status: review.status,
    currentStep: review.current_stage,
    stepDetail,
    startedAt: review.started_at,
    eta,
    activeStepLogs,
  });
}
