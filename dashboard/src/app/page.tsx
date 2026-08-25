import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUserRepos } from '@/lib/repo-auth';
import { getRecentReviews } from '@/lib/db';
import type { Review } from '@parakh/shared';
import DashboardActivity from '@/components/DashboardActivity';
import DashboardActions from '@/components/DashboardActions';
import RepositoryStats from '@/components/RepositoryStats';

export default async function Home() {
  const session = await getServerSession(authOptions);
  if (session && session.user.approvalStatus !== 'approved') {
    return (
      <main className="w-full px-6 pt-20 pb-16">
        <section className="glass-card max-w-xl mx-auto rounded-2xl p-8 text-center">
          <h1 className="font-anybody text-3xl font-bold text-white mb-3">
            {session.user.approvalStatus === 'declined' ? 'Access not approved' : 'Approval pending'}
          </h1>
          <p className="font-dm-sans text-[#c0c9c0]">
            {session.user.approvalStatus === 'declined'
              ? 'Contact the Parakh administrator if you believe this was a mistake.'
              : 'An administrator must approve your account before dashboard data is shown.'}
          </p>
        </section>
      </main>
    );
  }
  const userName = session?.user?.name || session?.user?.email || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  let repos: string[] = [];
  let reviews: Review[] = [];
  let loadFailed = false;
  if (session?.accessToken) {
    try {
      repos = await getUserRepos(session.accessToken);
      if (repos.length > 0) {
        reviews = await getRecentReviews(repos, 5);
      }
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
      loadFailed = true;
    }
  }

  return (
    <main className="w-full flex flex-col pt-8 pb-16 px-6">
      <div className="max-w-[1000px] mx-auto w-full flex flex-col">
          {/* Hero Section */}
        <section className="relative rounded-2xl overflow-hidden mb-8 border border-white/10 glass-card">
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 to-transparent"></div>
          <div className="relative z-10 p-12 py-16">
            <h1 className="font-anybody text-4xl font-bold text-white mb-3 tracking-tight">{greeting}, {userName}.</h1>
            <p className="text-[#c0c9c0] font-dm-sans text-lg max-w-2xl">
              {session
                ? `Your intelligence dashboard is ready. ${repos.length} repositories are synced and monitoring is active.`
                : 'Sign in with GitHub to see review activity across your repositories.'}
            </p>
          </div>
        </section>

        {loadFailed && (
          <div className="mb-6 rounded-xl border border-[#93000a]/30 bg-[#93000a]/20 p-4 text-[#ffdad6] font-dm-sans text-sm">
            Unable to load your dashboard data. Refresh the page to try again.
          </div>
        )}

        {session ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 flex-1">
          <DashboardActivity reviews={reviews} />
          <div className="xl:col-span-4 flex flex-col gap-6">
            <RepositoryStats count={repos.length} />
            <DashboardActions />
          </div>
        </div>
        ) : (
          <div className="glass-card rounded-xl p-10 text-center border-white/10">
            <p className="font-dm-sans text-[#c0c9c0] text-lg">Sign in to see your repositories, review activity, and rules.</p>
          </div>
        )}
      </div>
    </main>
  );
}
