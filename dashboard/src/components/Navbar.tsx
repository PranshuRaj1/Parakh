'use client';

import Link from 'next/link';
import { useSession, signIn, signOut } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { BrainCircuit, GitPullRequest, LogOut, Plug } from 'lucide-react';
import type { ReactNode } from 'react';
import Logo from './Logo';

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center px-1 text-sm font-medium transition-colors ${
        active ? 'text-[var(--primary-color)]' : 'text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </Link>
  );
}

export default function Navbar() {
  const { data: session, status } = useSession();
  const pathname = usePathname();

  return (
    <nav className="glass-card mb-8 rounded-t-none border-t-0 px-6 py-4">
      <div className="flex justify-between items-center h-12">
        <div className="flex items-center">
          <div className="flex-shrink-0 flex items-center">
            <Link href="/" className="flex items-center">
              <Logo className="h-8 w-auto text-white" />
            </Link>
          </div>
          {session?.user.approvalStatus === 'approved' && (
            <div className="hidden sm:ml-8 sm:flex sm:space-x-8">
              <NavLink href="/memory" active={pathname === '/memory'}>
                <BrainCircuit className="w-4 h-4 mr-2" />
                Memory
              </NavLink>
              <NavLink href="/pulls" active={pathname === '/pulls'}>
                <GitPullRequest className="w-4 h-4 mr-2" />
                Pulls
              </NavLink>
              <NavLink href="/connect" active={pathname === '/connect'}>
                <Plug className="w-4 h-4 mr-2" />
                Connect
              </NavLink>
            </div>
          )}
        </div>
        <div className="flex items-center">
          {status === 'loading' ? null : session ? (
            <div className="flex items-center gap-4">
              {session.user.isAdmin && <Link href="/admin" className="text-sm text-[#c5c0ff] hover:text-white">Admin</Link>}
              <span className="text-sm technical-data text-gray-400">
                {session.user.login || session.user.name}
              </span>
              <button
                onClick={() => signOut()}
                className="btn btn-ghost"
                title="Sign out"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => signIn('github')}
              className="btn btn-primary text-sm flex items-center gap-2"
            >
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              Sign in with GitHub
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
