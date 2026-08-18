import { NextResponse } from 'next/server';
import { getApprovedSession } from '@/lib/access';
import { requireRepoPermission } from '@/lib/repo-auth';
import { getReview } from '@/lib/db';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const review = await getReview(id);
    if (!review) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    if (!(await requireRepoPermission(review.repo, 'write', session))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } catch (error) {
    console.error('Error verifying repository access:', error);
    return NextResponse.json({ error: 'Failed to verify repository access' }, { status: 500 });
  }

  const workerUrl = process.env.WORKER_API_URL;
  const workerSecret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !workerSecret) {
    console.error('Missing WORKER_API_URL or WORKER_API_SECRET');
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  try {
    const response = await fetch(`${workerUrl}/api/reviews/${id}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerSecret}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data, { status: 202 });
  } catch (error) {
    console.error('Error proxying retry to worker:', error);
    return NextResponse.json({ error: 'Failed to trigger retry' }, { status: 500 });
  }
}
