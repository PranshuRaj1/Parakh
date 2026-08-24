export default function RepositoryStats({ count }: { count: number }) {
  return (
    <section className="glass-card rounded-xl p-5 flex flex-col justify-center items-center text-center">
      <span className="material-symbols-outlined text-3xl text-[#c5c0ff] mb-3">memory</span>
      <h2 className="font-space-mono text-[#c0c9c0] mb-1 uppercase tracking-widest text-xs font-bold">Repositories</h2>
      <div className="font-anybody font-bold text-4xl text-white">{count}</div>
      <div className="font-dm-sans text-sm text-[#c0c9c0]">Across all accessible</div>
      <div className="mt-4 pt-3 border-t border-white/10 w-full font-dm-sans text-xs text-[#c0c9c0]">Monitoring only repos you have access to</div>
    </section>
  );
}
