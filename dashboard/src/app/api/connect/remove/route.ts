import { NextResponse } from 'next/server';
import { getApprovedSession } from '@/lib/access';
import { fetchWorkerJson, WorkerError } from '@/lib/worker-proxy';

export const dynamic = 'force-dynamic';

// POST /api/connect/remove — body: { provider, owner }. Disconnects an account.
export async function POST(req: Request) {
  const session = await getApprovedSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { provider?: string; owner?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.provider || !body.owner || !/^[a-z]+$/.test(body.provider) || !/^[a-zA-Z0-9._-]+$/.test(body.owner)) {
    return NextResponse.json({ error: 'Invalid provider or owner' }, { status: 400 });
  }

  try {
    const data = await fetchWorkerJson(
      `/api/connect/${encodeURIComponent(body.provider)}/${encodeURIComponent(body.owner)}/remove?installedBy=${encodeURIComponent(session.user.login ?? '')}`,
      { method: 'POST' }
    );
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying connect remove to worker:', error);
    const status = error instanceof WorkerError ? error.status : 500;
    return NextResponse.json({ error: 'Failed to disconnect' }, { status });
  }
}
