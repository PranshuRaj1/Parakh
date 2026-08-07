import { getReviewByPr } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect, notFound } from 'next/navigation';
import { ReviewStepper } from '@/components/ReviewStepper';
import { FailureDetail } from '@/components/FailureDetail';
import { ReasoningPanel } from '@/components/ReasoningPanel';

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
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
          <a href={`https://github.com/${fullRepo}/pull/${prNumber}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
             PR #{prNumber}
          </a>
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Review progress for <strong className="font-semibold">{fullRepo}</strong>
        </p>
      </div>

      <ReviewStepper reviewId={review.id} />
      {review.status === 'FAILED' && <FailureDetail reviewId={review.id} />}
      <ReasoningPanel reviewId={review.id} />
    </div>
  );
}
