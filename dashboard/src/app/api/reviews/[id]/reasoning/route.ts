import { NextResponse } from 'next/server';
import { getReview, getReviewReasoning } from '@/lib/db';
import { getServerSession } from 'next-auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const review = await getReview(id);
  if (!review) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const reasoning = await getReviewReasoning(id);

  return NextResponse.json({
    reviewId: id,
    reasoning,
  });
}
