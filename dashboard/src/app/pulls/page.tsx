import { getDashboardReviews } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle, Clock, AlertTriangle, Eye } from 'lucide-react';
import type { Review } from '@parakh/shared';
import { authOptions } from '@/lib/auth';
import { getUserRepos } from '@/lib/repo-auth';

export default async function PullsPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string }>
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/');

  const repos = session.accessToken ? await getUserRepos(session.accessToken) : [];
  const params = await searchParams;
  const requested = params.repo;
  const selected = repos.find((r) => r.toLowerCase() === requested?.toLowerCase()) ?? repos[0] ?? null;
  if (requested && !selected) notFound();

  let reviews: Review[] = [];
  let dbError = false;

  if (selected) {
    try {
      reviews = await getDashboardReviews(selected, 50); // Get latest 50 reviews
    } catch (e) {
      console.error(e);
      dbError = true;
    }
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pt-8 max-w-[1200px] mx-auto px-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-white font-anybody">Pull Requests</h1>
          <p className="mt-2 text-sm text-[#c0c9c0] font-dm-sans">
            Recent reviews for {selected ? <strong className="font-semibold text-white">{selected}</strong> : 'your repositories'}
          </p>
        </div>
        <form className="flex gap-2" method="GET">
          <select
            name="repo"
            defaultValue={selected ?? ''}
            disabled={repos.length === 0}
            aria-label="Repository"
            className="rounded-md border border-[#2a2a2a] bg-[#131313] text-white shadow-sm focus:border-[#00FF8C] focus:ring-[#00FF8C] focus:outline-none sm:text-sm p-2 transition-all font-space-mono"
          >
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit" className="px-4 py-2 bg-[#3D3B4F] text-white rounded-md text-sm font-bold font-space-mono hover:brightness-110 transition-colors">
            Switch
          </button>
        </form>
      </div>

      {!selected ? (
        <div className="glass-card rounded-xl p-6 text-center border-white/10">
          <p className="font-dm-sans text-[#c0c9c0]">No accessible repositories found. Grant the dashboard read access to your repositories and try again.</p>
        </div>
      ) : dbError ? (
        <div className="bg-[#93000a]/20 text-[#ffb4ab] p-4 rounded-xl border border-[#93000a] font-dm-sans">
          Failed to connect to the database. Make sure DATABASE_URL is set in .env.local.
        </div>
      ) : (
        <div className="glass-card rounded-xl overflow-hidden p-6">
          <ul className="divide-y divide-white/10">
            {reviews.length === 0 ? (
              <li className="px-6 py-8 text-center text-[#c0c9c0] font-dm-sans">No reviews found for this repository.</li>
            ) : (
              reviews.map((review) => {
                const isCompleted = review.status === 'COMPLETED';
                const scoreClass = !isCompleted 
                  ? 'text-[#c0c9c0]' 
                  : (review.score ?? 0) >= 4.0 
                    ? 'text-[#00FF8C]' 
                    : (review.score ?? 0) < 2.5 
                      ? 'text-[#ffb4ab]' 
                      : 'text-[#f0e1c2]';
                
                const findingsCount = review.findings?.length || 0;
                const ruleViolations = review.findings?.filter(f => f.rule_id).length || 0;

                return (
                  <li key={review.id} className="py-5 hover:bg-white/5 transition-colors px-4 -mx-4 rounded-lg group">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-start gap-4">
                        <div className={`mt-1 rounded-full p-1.5 ${isCompleted ? 'bg-[#00FF8C]/10 text-[#00FF8C]' : 'bg-[#3D3B4F] text-[#c8c3dd]'}`}>
                          {isCompleted ? <CheckCircle className="w-5 h-5" /> : review.status === 'RUNNING' ? <Clock className="w-5 h-5 animate-pulse" /> : <Eye className="w-5 h-5" />}
                        </div>
                        <div>
                          <a 
                            href={`/pulls/${review.repo}/${review.pr_number}`} 
                            className="text-lg font-medium text-white hover:text-[#00FF8C] transition-colors font-anybody"
                          >
                            PR #{review.pr_number}
                          </a>
                          <div className="mt-1 flex items-center gap-4 text-sm text-[#c0c9c0] font-dm-sans">
                            <span className="flex items-center gap-1">
                              Status: <span className="font-medium text-white">{review.status}</span>
                            </span>
                            <span>{formatDistanceToNow(new Date(review.created_at), { addSuffix: true })}</span>
                          </div>
                        </div>
                      </div>
                      
                      {isCompleted && (
                        <div className="flex items-center gap-8 sm:text-right">
                          <div className="flex flex-col items-end">
                            <p className="text-xs uppercase tracking-widest text-[#c0c9c0] font-space-mono mb-1">Score</p>
                            <p className={`text-2xl font-bold font-anybody ${scoreClass}`}>
                              {review.score !== null ? Number(review.score).toFixed(1) : '-'} <span className="text-sm font-normal text-[#c0c9c0]">/ 5</span>
                            </p>
                          </div>
                          <div className="flex flex-col items-end">
                            <p className="text-xs uppercase tracking-widest text-[#c0c9c0] font-space-mono mb-1">Issues Found</p>
                            <p className="text-lg font-medium text-white flex items-center gap-2 justify-end font-anybody">
                              {findingsCount}
                              {ruleViolations > 0 && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-space-mono bg-[#93000a]/20 text-[#ffb4ab] border border-[#93000a]/50" title={`${ruleViolations} rule violations`}>
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  {ruleViolations} rules
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}