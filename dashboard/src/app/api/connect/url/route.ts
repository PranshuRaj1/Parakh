import { NextResponse } from 'next/server';
import { getApprovedSession } from '@/lib/access';
import { fetchWorkerJson, WorkerError } from '@/lib/worker-proxy';

export const dynamic = 'force-dynamic';

// GET /api/connect/url?provider=github — install/connect deep link.
export async function GET(req: Request) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const provider = new URL(req.url).searchParams.get('provider') ?? 'github';

  try {
    const data = await fetchWorkerJson(`/api/connect/url?provider=${encodeURIComponent(provider)}`);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying connect url to worker:', error);
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json({ error: 'Failed to build connect link' }, { status });
  }
}
