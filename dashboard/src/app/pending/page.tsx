import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';

export default async function PendingPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/');
  if (session.user.approvalStatus === 'approved') redirect('/');

  const declined = session.user.approvalStatus === 'declined';
  return (
    <main className="w-full px-6 pt-20 pb-16">
      <section className="glass-card max-w-xl mx-auto rounded-2xl p-8 text-center">
        <span className="material-symbols-outlined text-5xl text-[#c5c0ff] mb-4">
          {declined ? 'block' : 'hourglass_top'}
        </span>
        <h1 className="font-anybody text-3xl font-bold text-white mb-3">
          {declined ? 'Access not approved' : 'Approval pending'}
        </h1>
        <p className="font-dm-sans text-[#c0c9c0]">
          {declined
            ? 'Your request was declined. Contact the Parakh administrator if you believe this was a mistake.'
            : 'Your GitHub account is signed in, but an administrator must approve access before repositories and reviews are shown.'}
        </p>
      </section>
    </main>
  );
}
