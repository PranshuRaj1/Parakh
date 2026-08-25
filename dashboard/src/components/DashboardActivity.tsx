import Link from 'next/link';
import type { Review } from '@parakh/shared';

export default function DashboardActivity({ reviews }: { reviews: Review[] }) {
  return (
    <section className="glass-card rounded-xl p-5 xl:col-span-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-anybody text-sm font-bold uppercase tracking-wider text-[#c5c0ff]">Recent activity</h2>
        <Link href="/pulls" className="text-[#c0c9c0] hover:text-white text-sm flex items-center gap-1 transition-colors font-dm-sans">
          View all <span className="material-symbols-outlined text-sm">arrow_forward</span>
        </Link>
      </div>
      <div className="space-y-3">
        {reviews.length === 0 ? (
          <div className="p-4 rounded-lg bg-white/5 border border-white/5 text-[#c0c9c0] font-dm-sans text-sm">
            No reviews yet across your repositories.
          </div>
        ) : reviews.map((review) => (
          <Link key={review.id} href={`/pulls/${review.repo}/${review.pr_number}`} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group">
            <div className="flex items-center gap-3">
              <span className="font-space-mono font-bold text-[#00FF8C]">#{review.pr_number}</span>
              <div>
                <div className="font-dm-sans text-white font-medium group-hover:text-[#00FF8C] transition-colors">PR #{review.pr_number}</div>
                <div className="font-dm-sans text-xs text-[#c0c9c0] mt-1">{review.repo}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${review.status === 'COMPLETED' ? 'bg-[#00FF8C] shadow-[0_0_8px_#00FF8C]' : 'bg-[#c5c0ff] shadow-[0_0_8px_#c5c0ff] animate-pulse'}`} />
              <span className="font-dm-sans text-xs text-[#c0c9c0]">{review.status}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
