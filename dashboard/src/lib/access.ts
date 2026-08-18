import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';

export async function requireApprovedSession() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/');
  if (session.user.approvalStatus !== 'approved') redirect('/pending');
  return session;
}

export async function getApprovedSession() {
  const session = await getServerSession(authOptions);
  return session?.user.approvalStatus === 'approved' ? session : null;
}

export async function requireAdminSession() {
  const session = await getServerSession(authOptions);
  if (!session?.user.isAdmin) redirect('/');
  return session;
}

export function isApprovedSession(session: { user?: { approvalStatus?: string | null } } | null) {
  return session?.user?.approvalStatus === 'approved';
}
