import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { fetchWorkerJson, WorkerError } from '@/lib/worker-proxy';

export const dynamic = 'force-dynamic';

// GET /api/connect — list connected provider accounts (proxies the worker).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await fetchWorkerJson('/api/connect');
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying connect list to worker:', error);
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json({ error: 'Failed to load connections' }, { status });
  }
}