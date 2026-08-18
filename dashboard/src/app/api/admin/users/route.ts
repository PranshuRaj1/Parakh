import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { listDashboardUsers } from '@/lib/dashboard-users';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(await listDashboardUsers());
}
