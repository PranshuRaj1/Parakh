import { neon } from '@neondatabase/serverless';

export type DashboardUserStatus = 'pending' | 'approved' | 'declined';

export interface DashboardUser {
  githubId: number;
  githubLogin: string;
  email: string | null;
  status: DashboardUserStatus;
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return neon(process.env.DATABASE_URL);
}

function toDashboardUser(row: Record<string, unknown>): DashboardUser {
  return {
    githubId: Number(row.github_id),
    githubLogin: String(row.github_login),
    email: (row.email as string | null) ?? null,
    status: row.status as DashboardUserStatus,
    requestedAt: String(row.requested_at),
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
  };
}

export async function upsertDashboardUser(input: {
  githubId: number;
  githubLogin: string;
  email?: string | null;
}): Promise<DashboardUser> {
  const sql = getSql();
  const rows = await sql`
    INSERT INTO dashboard_users (github_id, github_login, email)
    VALUES (${input.githubId}, ${input.githubLogin}, ${input.email ?? null})
    ON CONFLICT (github_id) DO UPDATE SET
      github_login = EXCLUDED.github_login,
      email = EXCLUDED.email
    RETURNING *
  `;
  return toDashboardUser(rows[0] as Record<string, unknown>);
}

export async function getDashboardUser(login: string): Promise<DashboardUser | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM dashboard_users WHERE github_login = ${login} LIMIT 1
  `;
  return rows[0] ? toDashboardUser(rows[0] as Record<string, unknown>) : null;
}

export async function listDashboardUsers(status?: DashboardUserStatus): Promise<DashboardUser[]> {
  const sql = getSql();
  const rows = status
    ? await sql`
        SELECT * FROM dashboard_users
        WHERE status = ${status}
        ORDER BY requested_at DESC
      `
    : await sql`
        SELECT * FROM dashboard_users ORDER BY requested_at DESC
      `;
  return rows.map((row) => toDashboardUser(row as Record<string, unknown>));
}

export async function setDashboardUserStatus(
  login: string,
  status: DashboardUserStatus,
  reviewedBy: string
): Promise<DashboardUser | null> {
  const sql = getSql();
  const rows = await sql`
    UPDATE dashboard_users
    SET status = ${status}, reviewed_at = now(), reviewed_by = ${reviewedBy}
    WHERE github_login = ${login}
    RETURNING *
  `;
  return rows[0] ? toDashboardUser(rows[0] as Record<string, unknown>) : null;
}
