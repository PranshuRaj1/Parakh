import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/connect/url?provider=github — install/connect deep link.
export async function GET(req: Request) {
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

  const provider = new URL(req.url).searchParams.get('provider') ?? 'github';

  try {
    const response = await fetch(`${workerUrl}/api/connect/url?provider=${provider}`, {
      headers: { Authorization: `Bearer ${workerSecret}` },
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(data, { status: response.status });
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error proxying connect url to worker:', error);
    return NextResponse.json({ error: 'Failed to build connect link' }, { status: 500 });
  }
}