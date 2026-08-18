import { NextResponse } from 'next/server';
import { getApprovedSession } from '@/lib/access';
import { requireRepoPermission } from '@/lib/repo-auth';

export async function POST(request: Request) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { repo?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.repo || !(await requireRepoPermission(body.repo, 'write', session))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const workerUrl = process.env.WORKER_API_URL;
  const workerSecret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !workerSecret) {
    console.error('Missing WORKER_API_URL or WORKER_API_SECRET');
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  try {
    // Proxy the request to the worker's /api/rules endpoint
    const response = await fetch(`${workerUrl}/api/rules`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(data, { status: 201 });
  } catch (error) {
    console.error('Error proxying to worker:', error);
    return NextResponse.json({ error: 'Failed to create rule' }, { status: 500 });
  }
}
