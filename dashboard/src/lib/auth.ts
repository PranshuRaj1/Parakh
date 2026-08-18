import type { NextAuthOptions } from 'next-auth';
import GithubProvider from 'next-auth/providers/github';
import { getDashboardUser, upsertDashboardUser } from '@/lib/dashboard-users';

const clientId = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  throw new Error(
    'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set to enable dashboard sign-in'
  );
}

export const authOptions: NextAuthOptions = {
  providers: [
    GithubProvider({
      clientId,
      clientSecret,
      authorization: { params: {} },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const githubProfile = profile as Record<string, unknown> | undefined;
      const login = githubProfile?.login;
      const githubId = githubProfile?.id;
      const parsedGithubId = typeof githubId === 'number' ? githubId : Number(githubId);
      if (typeof login !== 'string' || !Number.isSafeInteger(parsedGithubId) || parsedGithubId <= 0) {
        return false;
      }
      try {
        await upsertDashboardUser({
          githubId: parsedGithubId,
          githubLogin: login,
          email: typeof githubProfile?.email === 'string' ? githubProfile.email : null,
        });
      } catch (error) {
        console.error('[auth] failed to register dashboard user:', error);
        return false;
      }
      return true;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).login = token.login;
        (session.user as Record<string, unknown>).githubId = token.githubId;
        const login = typeof token.login === 'string' ? token.login : null;
        const user = login ? await getDashboardUser(login) : null;
        (session.user as Record<string, unknown>).approvalStatus = user?.status ?? 'pending';
        (session.user as Record<string, unknown>).isAdmin = isAdminLogin(login);
      }
      session.accessToken = (token.accessToken as string | undefined) ?? null;
      return session;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        const githubProfile = profile as Record<string, unknown> | undefined;
        token.login = typeof githubProfile?.login === 'string' ? githubProfile.login : null;
        const githubId = githubProfile?.id;
        const parsedGithubId = typeof githubId === 'number' ? githubId : Number(githubId);
        if (Number.isSafeInteger(parsedGithubId) && parsedGithubId > 0) {
          token.githubId = parsedGithubId;
        } else {
          delete token.githubId;
        }
      }
      return token;
    },
  },
  pages: {
    signIn: '/',
  },
};

function isAdminLogin(login: string | null): boolean {
  if (!login) return false;
  return (process.env.DASHBOARD_ADMIN_LOGINS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(login.toLowerCase());
}
