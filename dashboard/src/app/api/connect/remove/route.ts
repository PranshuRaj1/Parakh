import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// POST /api/connect/remove — body: { provider, owner }. Disconnects an account.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const workerUrl = process.env.WORKER_API_URL;
  const workerSecret = process.env.WORKER_API_SECRET;

  if (!workerUrl || !workerSecret) {
    console.error('Missing WORKER_API_URL or WORKER_API_SECRET');
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
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
    const response = await fetch(
      `${workerUrl}/api/connect/${encodeURIComponent(body.provider)}/${encodeURIComponent(body.owner)}/remove`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${workerSecret}` },
      }
    );
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying connect remove to worker:', error);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}