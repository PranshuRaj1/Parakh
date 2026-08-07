import { NextResponse } from 'next/server';
import { getReview, getStepEventsForReview } from '@/lib/db';
import { getServerSession } from 'next-auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const review = await getReview(id);
  if (!review || review.status !== 'FAILED') {
    return NextResponse.json({ error: 'not failed' }, { status: 404 });
  }

  const timeline = await getStepEventsForReview(id);

  return NextResponse.json({
    errorStep: review.error_step,
    errorMessage: review.error_message,
    errorStack: review.error_stack,
    retryCount: review.retry_count,
    githubDeliveryId: review.github_delivery_id,
    failedAt: review.failed_at,
    timeline,
  });
}
