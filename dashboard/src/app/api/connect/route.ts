import { NextResponse } from 'next/server';
import { getApprovedSession } from '@/lib/access';
import { fetchWorkerJson, WorkerError } from '@/lib/worker-proxy';

export const dynamic = 'force-dynamic';

// GET /api/connect — list connected provider accounts (proxies the worker).
export async function GET() {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await fetchWorkerJson(`/api/connect?installedBy=${encodeURIComponent(session.user.login ?? '')}`);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying connect list to worker:', error);
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json({ error: 'Failed to load connections' }, { status });
  }
}
