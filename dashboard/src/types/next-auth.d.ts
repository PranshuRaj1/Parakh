import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      login?: string | null;
      githubId?: number | null;
      approvalStatus?: 'pending' | 'approved' | 'declined' | null;
      isAdmin?: boolean;
    } & DefaultSession['user'];
    accessToken?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    login?: string | null;
    githubId?: number | null;
    accessToken?: string | null;
  }
}
