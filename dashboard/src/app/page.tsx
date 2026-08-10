import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex w-full min-h-[calc(100vh-64px)]">
      
      {/* SideNavBar (Desktop Only) */}
      <aside className="hidden md:flex flex-col w-64 px-6 py-8 border-r border-white/5 space-y-2 font-anybody fixed left-0 top-16 h-[calc(100vh-64px)] bg-[#000000] z-10 overflow-y-auto">
        <div className="mb-8 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#3D3B4F] flex items-center justify-center font-bold text-white shadow-inner">
            PR
          </div>
          <div>
            <div className="text-white text-lg font-semibold leading-tight">PranshuRaj1</div>
            <div className="text-[#c0c9c0] text-xs font-dm-sans">Parakh</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          <Link href="/" className="flex items-center gap-3 px-4 py-3 bg-[#3D3B4F]/30 text-[#c5c0ff] rounded-lg scale-[1.02] transition-transform hover:bg-white/5 font-semibold text-sm">
            <span className="material-symbols-outlined text-[20px]">dashboard</span>
            Overview
          </Link>
          <Link href="#" className="flex items-center gap-3 px-4 py-3 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors font-medium text-sm">
            <span className="material-symbols-outlined text-[20px]">folder_open</span>
            Files
          </Link>
          <Link href="#" className="flex items-center gap-3 px-4 py-3 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors font-medium text-sm">
            <span className="material-symbols-outlined text-[20px]">history</span>
            Commits
          </Link>
          <Link href="/memory" className="flex items-center gap-3 px-4 py-3 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors font-medium text-sm">
            <span className="material-symbols-outlined text-[20px]">rule</span>
            Rules
          </Link>
          <Link href="/pulls" className="flex items-center gap-3 px-4 py-3 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors font-medium text-sm">
            <span className="material-symbols-outlined text-[20px]">analytics</span>
            Activity
          </Link>
        </nav>

        <div className="mt-auto pt-8 space-y-4">
          <button className="w-full bg-transparent border border-[#c5c0ff] text-white font-dm-sans text-sm px-4 py-2 rounded-lg hover:bg-[#c5c0ff]/10 transition-colors">
            Add Repository
          </button>
          <div className="space-y-1 border-t border-white/5 pt-4">
            <Link href="#" className="flex items-center gap-3 px-4 py-2 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors text-sm">
              <span className="material-symbols-outlined text-[18px]">menu_book</span>
              Docs
            </Link>
            <Link href="#" className="flex items-center gap-3 px-4 py-2 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors text-sm">
              <span className="material-symbols-outlined text-[18px]">help_outline</span>
              Support
            </Link>
          </div>
        </div>
      </aside>

      {/* Main Canvas */}
      <main className="flex-1 md:ml-64 w-full flex flex-col pt-8 pb-16 px-6">
        <div className="max-w-[1000px] mx-auto w-full flex flex-col">
          {/* Hero Section */}
        <section className="relative rounded-2xl overflow-hidden mb-8 border border-white/10 glass-card">
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 to-transparent"></div>
          <div className="relative z-10 p-12 py-16">
            <h1 className="font-anybody text-4xl font-bold text-white mb-3 tracking-tight" style={{ letterSpacing: '-0.02em' }}>Good morning, Pranshu.</h1>
            <p className="text-[#c0c9c0] font-dm-sans text-lg max-w-2xl">
              Your intelligence dashboard is ready. All repositories are synced and monitoring is active.
            </p>
          </div>
        </section>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 flex-1">
          {/* Recent Activity */}
          <div className="glass-card rounded-xl p-6 xl:col-span-8 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-anybody text-sm font-bold uppercase tracking-wider text-[#c5c0ff]">Recent Activity</h2>
              <Link href="/pulls" className="text-[#c0c9c0] hover:text-white text-sm flex items-center gap-1 transition-colors font-dm-sans">
                View All <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </Link>
            </div>
            
            <div className="space-y-4">
              {/* PR Item 1 */}
              <Link href="/pulls/PranshuRaj1/Parakh/10" className="flex items-center justify-between p-4 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group">
                <div className="flex items-center gap-4">
                  <span className="font-space-mono font-bold text-[#00FF8C]">#10</span>
                  <div>
                    <div className="font-dm-sans text-white font-medium group-hover:text-[#00FF8C] transition-colors">Refactor authentication flow</div>
                    <div className="font-dm-sans text-xs text-[#c0c9c0] mt-1">Parakh/core-api • 2 hours ago</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#00FF8C] shadow-[0_0_8px_#00FF8C]"></span>
                  <span className="font-dm-sans text-xs text-[#c0c9c0]">Completed</span>
                </div>
              </Link>

              {/* PR Item 2 */}
              <Link href="/pulls/PranshuRaj1/Parakh/11" className="flex items-center justify-between p-4 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors group">
                <div className="flex items-center gap-4">
                  <span className="font-space-mono font-bold text-[#c5c0ff]">#11</span>
                  <div>
                    <div className="font-dm-sans text-white font-medium group-hover:text-[#c5c0ff] transition-colors">Update dependency injection container</div>
                    <div className="font-dm-sans text-xs text-[#c0c9c0] mt-1">Parakh/services • 5 hours ago</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#c5c0ff] shadow-[0_0_8px_#c5c0ff] animate-pulse"></span>
                  <span className="font-dm-sans text-xs text-[#c0c9c0]">Running</span>
                </div>
              </Link>
            </div>
          </div>

          {/* Memory Stats & Quick Actions Column */}
          <div className="xl:col-span-4 flex flex-col gap-6">
            {/* Memory Stats */}
            <div className="glass-card rounded-xl p-6 flex-1 flex flex-col justify-center items-center text-center">
              <span className="material-symbols-outlined text-4xl text-[#c5c0ff] mb-4">memory</span>
              <h2 className="font-space-mono text-[#c0c9c0] mb-2 uppercase tracking-widest text-xs font-bold">Memory Stats</h2>
              <div className="font-anybody font-bold text-5xl text-white mb-1">147</div>
              <div className="font-dm-sans text-[#c0c9c0]">Rules Active</div>
              <div className="mt-6 pt-4 border-t border-white/10 w-full font-dm-sans text-xs text-[#c0c9c0]">Across 3 repositories</div>
            </div>

            {/* Quick Actions */}
            <div className="glass-card rounded-xl p-6">
              <h2 className="font-anybody text-sm font-bold uppercase tracking-wider text-[#c5c0ff] mb-4">Quick Actions</h2>
              <div className="flex flex-col gap-3">
                <Link href="/pulls" className="w-full bg-[#00FF8C] text-black font-anybody font-bold py-3 rounded-lg hover:brightness-110 transition-all flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">add</span> New Review
                </Link>
                <button className="w-full bg-transparent border border-[#c5c0ff] text-white font-dm-sans py-3 rounded-lg hover:bg-[#c5c0ff]/10 transition-colors flex items-center justify-center gap-2">
                  <span className="material-symbols-outlined text-lg">library_add</span> Add Repo
                </button>
              </div>
            </div>
          </div>
        </div>
        </div>
      </main>
    </div>
  );
}
