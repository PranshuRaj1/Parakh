import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { setDashboardUserStatus } from '@/lib/dashboard-users';

export async function POST(req: Request, { params }: { params: Promise<{ login: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user.isAdmin || !session.user.login) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => null) as { status?: string } | null;
  if (body?.status !== 'approved' && body?.status !== 'declined') {
    return NextResponse.json({ error: 'Status must be approved or declined' }, { status: 400 });
  }

  const { login } = await params;
  const user = await setDashboardUserStatus(login, body.status, session.user.login);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  return NextResponse.json(user);
}
