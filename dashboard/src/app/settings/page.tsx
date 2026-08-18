import KeyManager, { type KeysState } from '@/components/KeyManager';
import { requireApprovedSession } from '@/lib/access';
import { fetchWorkerJson } from '@/lib/worker-proxy';
import { getRecentFileReviewUsage } from '@/lib/db';

export const metadata = {
  title: 'Settings — Parakh',
};

export default async function SettingsPage() {
  const session = await requireApprovedSession();
  const login = session.user.login ?? '';

  let keys: KeysState = { stored: false, keys: null };
  try {
    const data = (await fetchWorkerJson(`/api/keys?installedBy=${encodeURIComponent(login)}`)) as KeysState;
    keys = data;
  } catch (err) {
    console.error('Failed to load key settings:', err);
  }

  let usage = { totalCalls: 0, completedCalls: 0 };
  try {
    usage = await getRecentFileReviewUsage(login, 24);
  } catch (err) {
    console.error('Failed to load key usage:', err);
  }

  return (
    <main className="w-full flex flex-col pt-8 pb-16 px-6">
      <div className="max-w-[1000px] mx-auto w-full flex flex-col">
        <section className="rounded-2xl overflow-hidden mb-8 border border-white/10 glass-card">
          <div className="p-8 md:p-12">
            <h1 className="font-anybody text-4xl font-bold text-white mb-3 tracking-tight">
              Settings
            </h1>
            <p className="text-[#c0c9c0] font-dm-sans text-lg max-w-2xl">
              Bring your own LLM API keys. Reviews on your repositories run on{' '}
              <strong className="text-white">your keys</strong>, your quota, and your budget — never
              on shared infrastructure spare capacity.
            </p>
          </div>
        </section>

        <KeyManager login={login} initialKeys={keys} usage={usage} />
      </div>
    </main>
  );
}