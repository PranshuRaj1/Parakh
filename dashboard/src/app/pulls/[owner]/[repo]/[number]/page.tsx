import { getReviewByPr } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { ReviewStepper } from '@/components/ReviewStepper';

export default async function PullRequestPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; number: string }>
}) {
  const session = await getServerSession();
  if (!session) redirect('/');

  const resolvedParams = await params;
  const { owner, repo, number } = resolvedParams;
  const fullRepo = `${owner}/${repo}`;
  const prNumber = parseInt(number, 10);

  const review = await getReviewByPr(fullRepo, prNumber);
  
  if (!review) {
    notFound();
  }

  return (
    <div className="pt-8 pb-16 px-6 max-w-[1200px] mx-auto min-h-[calc(100vh-64px)] flex flex-col animate-in fade-in duration-500">
      
      {/* Header */}
      <header className="mb-12 flex flex-col gap-2">
        <div className="flex items-center gap-3 text-[#c0c9c0] font-space-mono text-sm uppercase tracking-widest">
          <a href={`https://github.com/${fullRepo}/pull/${prNumber}`} target="_blank" rel="noopener noreferrer" className="text-[#9bd3ad] font-bold hover:underline">
            PR #{prNumber}
          </a>
          <span className="w-1 h-1 bg-white/20 rounded-full"></span>
          <span>Reviewing {fullRepo}</span>
        </div>
      </header>

      {/* Main Execution Pipeline */}
      <ReviewStepper reviewId={review.id} />
      
    </div>
  );
}
