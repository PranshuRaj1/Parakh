import type { NextAuthOptions } from 'next-auth';
import GithubProvider from 'next-auth/providers/github';

export const authOptions: NextAuthOptions = {
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
      authorization: {
        params: { scope: 'read:user user:email repo' },
      },
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      const allowlist = process.env.DASHBOARD_ALLOWED_LOGINS;
      if (!allowlist) return true;
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