import { NextResponse } from 'next/server';
import { getApprovedSession } from '@/lib/access';
import { fetchWorkerJson, WorkerError } from '@/lib/worker-proxy';

export const dynamic = 'force-dynamic';

// GET /api/keys — masked hints for the signed-in user's stored LLM keys.
export async function GET() {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await fetchWorkerJson(`/api/keys?installedBy=${encodeURIComponent(session.user.login ?? '')}`);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying keys load to worker:', error);
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json({ error: 'Failed to load key settings' }, { status });
  }
}

// POST /api/keys — full-replace the signed-in user's stored keys (encrypted in the worker).
export async function POST(request: Request) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const data = await fetchWorkerJson('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, installedBy: session.user.login ?? '' }),
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying keys save to worker:', error);
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json({ error: 'Failed to save key settings' }, { status });
  }
}