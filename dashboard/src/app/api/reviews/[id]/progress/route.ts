import { NextResponse } from 'next/server';
import { getReview } from '@/lib/db';
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

  return NextResponse.json({
    status: review.status,
    currentStep: review.current_step,
    stepDetail: review.step_detail,
    startedAt: review.started_at,
    eta,
  });
}
