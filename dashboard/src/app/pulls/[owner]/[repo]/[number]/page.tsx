import { getReviewByPr } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { ReviewStepper } from '@/components/ReviewStepper';
import { FailureDetail } from '@/components/FailureDetail';
import { ReasoningPanel } from '@/components/ReasoningPanel';
import { authOptions } from '@/lib/auth';
import { requireRepoPermission } from '@/lib/repo-auth';

export default async function PullRequestPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; number: string }>
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/');

  const resolvedParams = await params;
  const { owner, repo, number } = resolvedParams;
  const fullRepo = `${owner}/${repo}`;
  const prNumber = parseInt(number, 10);

  const canManage = await requireRepoPermission(fullRepo, 'write', session);
  if (!canManage && !(await requireRepoPermission(fullRepo, 'read', session))) {
    notFound();
  }
  const review = await getReviewByPr(fullRepo, prNumber);
  
  if (!review) {
    notFound();
  }

  return (
    <div className="pt-4 pb-8 px-6 max-w-[1200px] mx-auto min-h-[calc(100vh-64px)] flex flex-col animate-in fade-in duration-500">
      
      {/* Header */}
      <header className="mb-4 flex flex-col gap-2">
        <h1 className="flex items-center gap-3 text-[#c0c9c0] font-space-mono text-sm uppercase tracking-widest">
          <a href={`https://github.com/${fullRepo}/pull/${prNumber}`} target="_blank" rel="noopener noreferrer" className="text-[#9bd3ad] font-bold hover:underline">
            PR #{prNumber}
          </a>
          <span className="w-1 h-1 bg-white/20 rounded-full"></span>
          <span>Reviewing {fullRepo}</span>
        </h1>
      </header>

      {/* Main Execution Pipeline */}
      <ReviewStepper reviewId={review.id} />
      {review.status === 'FAILED' && <FailureDetail reviewId={review.id} canManage={canManage} />}
      <ReasoningPanel reviewId={review.id} />
      
    </div>
  );
}