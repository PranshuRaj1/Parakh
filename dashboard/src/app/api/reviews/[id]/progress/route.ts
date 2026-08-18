import { NextResponse } from 'next/server';
import { getReview, getActiveStepEvent, getLatestReviewingFilesDetail } from '@/lib/db';
import { computeEta } from '@/lib/eta';
import { getApprovedSession } from '@/lib/access';
import { requireRepoPermission } from '@/lib/repo-auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const review = await getReview(id);
  if (!review) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await requireRepoPermission(review.repo, 'read', session))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

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
    stageReasonCode: review.stage_reason_code,
    stageReasonDetail: review.stage_reason_detail,
    startedAt: review.started_at,
    eta,
    activeStepLogs,
  });
}
