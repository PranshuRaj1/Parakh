import type { NextAuthOptions } from 'next-auth';
import GithubProvider from 'next-auth/providers/github';

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
      authorization: {
        params: { scope: 'read:user user:email repo' },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const allowlist = process.env.DASHBOARD_ALLOWED_LOGINS;
      if (!allowlist) {
        console.error(
          '[auth] DASHBOARD_ALLOWED_LOGINS is not set — rejecting all sign-ins (fail closed)'
        );
        return false;
      }
      const login = (profile as Record<string, unknown> | undefined)?.login;
      return typeof login === 'string' && allowlist.split(',').map((s) => s.trim()).includes(login);
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).login = token.login;
      }
      session.accessToken = (token.accessToken as string | undefined) ?? null;
      return session;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        token.login = (profile as Record<string, unknown> | undefined)?.login;
      }
      return token;
    },
  },
  pages: {
    signIn: '/',
  },
};