import Link from 'next/link';

const ACTIONS = [
  { href: '/pulls', icon: 'add', label: 'New review', primary: true },
  { href: '/memory', icon: 'library_add', label: 'Repo rules', primary: false },
];

export default function DashboardActions() {
  return (
    <section className="glass-card rounded-xl p-5">
      <h2 className="font-anybody text-sm font-bold uppercase tracking-wider text-[#c5c0ff] mb-3">Quick actions</h2>
      <div className="flex flex-col gap-2">
        {ACTIONS.map((action) => (
          <Link key={action.href} href={action.href} className={action.primary
            ? 'w-full bg-[#00FF8C] text-black font-anybody font-bold py-2.5 rounded-lg hover:brightness-110 transition-all flex items-center justify-center gap-2'
            : 'w-full bg-transparent border border-[#c5c0ff] text-white font-dm-sans py-2.5 rounded-lg hover:bg-[#c5c0ff]/10 transition-colors flex items-center justify-center gap-2'}>
            <span className="material-symbols-outlined text-lg">{action.icon}</span>
            {action.label}
          </Link>
        ))}
      </div>
    </section>
  );
}
