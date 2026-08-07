import { getDashboardReviews } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { CheckCircle, Clock, AlertTriangle, Eye } from 'lucide-react';
import type { Finding, Review } from '@parakh/shared';

export default async function PullsPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string }>
}) {
  const session = await getServerSession();
  if (!session) redirect('/');

  const params = await searchParams;
  const repo = params.repo || 'PranshuRaj1/Parakh'; // Default for demo

  let reviews: Review[] = [];
  let dbError = false;

  try {
    reviews = await getDashboardReviews(repo, 50); // Get latest 50 reviews
  } catch (e) {
    console.error(e);
    dbError = true;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Pull Requests</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Recent reviews for <strong className="font-semibold">{repo}</strong>
          </p>
        </div>
        <form className="flex gap-2" method="GET">
          <input
            type="text"
            name="repo"
            defaultValue={repo}
            placeholder="owner/repo"
            className="rounded-md border-gray-300 dark:border-zinc-700 dark:bg-zinc-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
          />
          <button type="submit" className="px-4 py-2 bg-gray-100 dark:bg-zinc-800 rounded-md text-sm font-medium hover:bg-gray-200 dark:hover:bg-zinc-700 transition-colors">
            Switch
          </button>
        </form>
      </div>

      {dbError ? (
        <div className="bg-red-50 text-red-700 p-4 rounded-xl border border-red-200">
          Failed to connect to the database. Make sure DATABASE_URL is set in .env.local.
        </div>
      ) : (
        <div className="bg-white dark:bg-zinc-950 rounded-xl shadow-sm border border-gray-200 dark:border-zinc-800 overflow-hidden">
          <ul className="divide-y divide-gray-200 dark:divide-zinc-800">
            {reviews.length === 0 ? (
              <li className="px-6 py-8 text-center text-gray-500">No reviews found for this repository.</li>
            ) : (
              reviews.map((review) => {
                const isCompleted = review.status === 'COMPLETED';
                const scoreClass = !isCompleted 
                  ? 'text-gray-400' 
                  : (review.score ?? 0) >= 4.0 
                    ? 'text-green-600 dark:text-green-500' 
                    : (review.score ?? 0) < 2.5 
                      ? 'text-red-600 dark:text-red-500' 
                      : 'text-orange-500 dark:text-orange-400';
                
                const findingsCount = (review.findings as unknown as Finding[])?.length || 0;
                const ruleViolations = (review.findings as unknown as Finding[])?.filter(f => f.rule_id).length || 0;

                return (
                  <li key={review.id} className="px-6 py-5 hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-start gap-4">
                        <div className={`mt-1 rounded-full p-1.5 ${isCompleted ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-500' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-500'}`}>
                          {isCompleted ? <CheckCircle className="w-5 h-5" /> : review.status === 'RUNNING' ? <Clock className="w-5 h-5 animate-pulse" /> : <Eye className="w-5 h-5" />}
                        </div>
                        <div>
                          <a 
                            href={`/pulls/${repo}/${review.pr_number}`} 
                            className="text-lg font-medium text-gray-900 dark:text-white hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
                          >
                            PR #{review.pr_number}
                          </a>
                          <div className="mt-1 flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
                            <span className="flex items-center gap-1">
                              Status: <span className="font-medium">{review.status}</span>
                            </span>
                            <span>{formatDistanceToNow(new Date(review.created_at), { addSuffix: true })}</span>
                          </div>
                        </div>
                      </div>
                      
                      {isCompleted && (
                        <div className="flex items-center gap-6 sm:text-right">
                          <div>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Score</p>
                            <p className={`text-2xl font-bold ${scoreClass}`}>
                              {review.score !== null ? Number(review.score).toFixed(1) : '-'} <span className="text-sm font-normal text-gray-400">/ 5</span>
                            </p>
                          </div>
                          <div>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Issues Found</p>
                            <p className="text-lg font-medium text-gray-900 dark:text-white flex items-center gap-2 justify-end">
                              {findingsCount}
                              {ruleViolations > 0 && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" title={`${ruleViolations} rule violations`}>
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
