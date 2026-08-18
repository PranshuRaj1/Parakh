import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getUserRepos } from '@/lib/repo-auth';
import { getRecentReviews } from '@/lib/db';
import type { Review } from '@parakh/shared';

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
          {/* Recent Activity */}
          <div className="glass-card rounded-xl p-6 xl:col-span-8 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-anybody text-sm font-bold uppercase tracking-wider text-[#c5c0ff]">Recent Activity</h2>
              <Link href="/pulls" className="text-[#c0c9c0] hover:text-white text-sm flex items-center gap-1 transition-colors font-dm-sans">
                View All <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </Link>
            </div>
            
            <div className="space-y-4">
              {reviews.length === 0 ? (
                <div className="p-4 rounded-lg bg-white/5 border border-white/5 text-[#c0c9c0] font-dm-sans text-sm">
                  No reviews yet across your repositories.
                </div>
              ) : (
                reviews.map((review) => (
                  <Link key={review.id} href={`/pulls/${review.repo}/${review.pr_number}`} className="flex items-center justify-between p-4 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group">
                    <div className="flex items-center gap-4">
                      <span className="font-space-mono font-bold text-[#00FF8C]">#{review.pr_number}</span>
                      <div>
                        <div className="font-dm-sans text-white font-medium group-hover:text-[#00FF8C] transition-colors">PR #{review.pr_number}</div>
                        <div className="font-dm-sans text-xs text-[#c0c9c0] mt-1">{review.repo}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${review.status === 'COMPLETED' ? 'bg-[#00FF8C] shadow-[0_0_8px_#00FF8C]' : 'bg-[#c5c0ff] shadow-[0_0_8px_#c5c0ff] animate-pulse'}`}></span>
                      <span className="font-dm-sans text-xs text-[#c0c9c0]">{review.status}</span>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>

          {/* Memory Stats & Quick Actions Column */}
          <div className="xl:col-span-4 flex flex-col gap-6">
            {/* Memory Stats */}
            <div className="glass-card rounded-xl p-6 flex-1 flex flex-col justify-center items-center text-center">
              <span className="material-symbols-outlined text-4xl text-[#c5c0ff] mb-4">memory</span>
              <h2 className="font-space-mono text-[#c0c9c0] mb-2 uppercase tracking-widest text-xs font-bold">Repositories</h2>
              <div className="font-anybody font-bold text-5xl text-white mb-1">{repos.length}</div>
              <div className="font-dm-sans text-[#c0c9c0]">Across all accessible</div>
              <div className="mt-6 pt-4 border-t border-white/10 w-full font-dm-sans text-xs text-[#c0c9c0]">Monitoring only repos you have access to</div>
            </div>

            {/* Quick Actions */}
            <div className="glass-card rounded-xl p-6">
              <h2 className="font-anybody text-sm font-bold uppercase tracking-wider text-[#c5c0ff] mb-4">Quick Actions</h2>
              <div className="flex flex-col gap-3">
                <Link href="/pulls" className="w-full bg-[#00FF8C] text-black font-anybody font-bold py-3 rounded-lg hover:brightness-110 transition-all flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">add</span> New Review
                </Link>
                <Link href="/memory" className="w-full bg-transparent border border-[#c5c0ff] text-white font-dm-sans py-3 rounded-lg hover:bg-[#c5c0ff]/10 transition-colors flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">library_add</span> Repo Rules
                </Link>
              </div>
            </div>
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
