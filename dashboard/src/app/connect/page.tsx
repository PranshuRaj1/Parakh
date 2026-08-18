import Link from 'next/link';
import ConnectCard from '@/components/ConnectCard';
import { requireApprovedSession } from '@/lib/access';

export const metadata = {
  title: 'Connect — Parakh',
};

const STEPS = [
  {
    icon: 'install_mobile',
    title: '1. Install the app',
    body: 'Click “Connect GitHub” and pick the account or organization where you want Parakh to review pull requests.',
  },
  {
    icon: 'select_all',
    title: '2. Choose your repos',
    body: 'Select all repositories or just a few. Parakh only ever sees the repos you grant it access to.',
  },
  {
    icon: 'rate_review',
    title: '3. Open a pull request',
    body: 'Parakh reviews your PRs automatically — rules you approve get remembered and enforced on every future PR.',
  },
];

export default async function ConnectPage() {
  await requireApprovedSession();
  return (
    <main className="w-full flex flex-col pt-8 pb-16 px-6">
      <div className="max-w-[1000px] mx-auto w-full flex flex-col">
        <section className="rounded-2xl overflow-hidden mb-8 border border-white/10 glass-card">
          <div className="p-8 md:p-12">
            <h1 className="font-anybody text-4xl font-bold text-white mb-3 tracking-tight">
              Connect your repositories
            </h1>
            <p className="text-[#c0c9c0] font-dm-sans text-lg max-w-2xl">
              Parakh reviews your pull requests with a GitHub App. Install it once,
              then pick which repositories you want reviewed.
            </p>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1">
          {/* How it works */}
          <div className="lg:col-span-5 space-y-4">
            {STEPS.map((step) => (
              <div key={step.title} className="glass-card rounded-xl p-5 flex gap-4">
                <span className="material-symbols-outlined text-[#c5c0ff] text-2xl flex-shrink-0">
                  {step.icon}
                </span>
                <div>
                  <h3 className="font-anybody text-sm font-bold text-white uppercase tracking-wider mb-1">
                    {step.title}
                  </h3>
                  <p className="font-dm-sans text-sm text-[#c0c9c0]">{step.body}</p>
                </div>
              </div>
            ))}
            <div className="glass-card rounded-xl p-5">
              <h3 className="font-anybody text-sm font-bold text-[#c5c0ff] uppercase tracking-wider mb-2">
                Already connected?
              </h3>
              <p className="font-dm-sans text-sm text-[#c0c9c0]">
                Head to{' '}
                <Link href="/pulls" className="text-[#00FF8C] hover:underline">
                  Pulls
                </Link>{' '}
                to see the reviews Parakh is running on your repositories.
              </p>
            </div>
          </div>

          {/* Connections */}
          <div className="lg:col-span-7">
            <ConnectCard />
          </div>
        </div>
      </div>
    </main>
  );
}
