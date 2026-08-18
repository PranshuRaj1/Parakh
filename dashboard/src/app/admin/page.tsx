import { requireAdminSession } from '@/lib/access';
import { listDashboardUsers } from '@/lib/dashboard-users';
import AdminUsers from '@/components/AdminUsers';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  await requireAdminSession();
  const users = await listDashboardUsers();
  return <AdminUsers initialUsers={users} />;
}
