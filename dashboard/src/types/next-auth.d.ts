import { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      login?: string | null;
    } & DefaultSession['user'];
    accessToken?: string | null;
  }
}
