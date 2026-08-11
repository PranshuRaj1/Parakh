import { getDashboardRules, getDashboardRuleRelationships } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import CreateRuleForm from '@/components/CreateRuleForm';
import type { Rule, RuleRelationshipRecord } from '@parakh/shared';
import Link from 'next/link';

export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string }>
}) {
  const session = await getServerSession();
  if (!session) redirect('/');

  const params = await searchParams;
  const repo = params.repo || 'PranshuRaj1/Parakh'; // Default for demo

  // Ensure env var exists for DB connection before trying to fetch
  let rules: Rule[] = [];
  let relationships: RuleRelationshipRecord[] = [];
  let dbError = false;

  try {
    rules = await getDashboardRules(repo);
    relationships = await getDashboardRuleRelationships(repo);
  } catch (e) {
    console.error(e);
    dbError = true;
  }

  const activeRules = rules.filter(r => r.status === 'ACTIVE');
  const supersededRules = rules.filter(r => r.status === 'SUPERSEDED');
  const userName = session.user?.name || session.user?.email || 'PranshuRaj1';
  const shortId = (id: string) => id.substring(0, 8);

  return (
    <div className="flex w-full min-h-[calc(100vh-64px)]">
      
      {/* SideNavBar (Desktop Only) */}
      <aside className="hidden md:flex flex-col w-64 px-6 py-8 border-r border-white/5 space-y-2 font-anybody fixed left-0 top-16 h-[calc(100vh-64px)] bg-[#000000] z-10 overflow-y-auto">
        <div className="mb-8 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#3D3B4F] flex items-center justify-center font-bold text-white shadow-inner">
            PR
          </div>
          <div>
            <div className="text-white text-lg font-semibold leading-tight">{userName}</div>
            <div className="text-[#c0c9c0] text-xs font-dm-sans">Parakh</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          <Link href="/" className="flex items-center gap-3 px-4 py-3 text-[#c0c9c0] hover:text-white rounded-lg hover:bg-white/5 transition-colors font-medium text-sm">
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
          <Link href="/memory" className="flex items-center gap-3 px-4 py-3 bg-[#3D3B4F]/30 text-[#c5c0ff] rounded-lg scale-[1.02] transition-transform hover:bg-white/5 font-semibold text-sm">
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 1" }}>rule</span>
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
          {dbError ? (
            <div className="bg-[#93000a]/20 text-[#ffdad6] p-4 rounded-xl border border-[#93000a]">
              Failed to connect to the database. Make sure DATABASE_URL is set in .env.local.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1">
            {/* Left Column: Active Rules & History */}
            <div className="lg:col-span-8 space-y-8">
              {/* Section Header */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h1 className="font-anybody text-3xl font-bold text-white mb-2 tracking-tight">Repository Memory</h1>
                  <p className="font-dm-sans text-[#c0c9c0] text-lg">Rules learned and enforced for <strong className="font-semibold text-white">{repo}</strong></p>
                </div>
                <form className="flex gap-2" method="GET">
                  <input
                    type="text"
                    name="repo"
                    defaultValue={repo}
                    placeholder="owner/repo"
                    aria-label="Repository"
                    className="rounded-md border border-[#2a2a2a] bg-[#131313] text-white shadow-sm focus:border-[#00FF8C] focus:ring-[#00FF8C] focus:outline-none sm:text-sm p-2 transition-all font-space-mono"
                  />
                  <button type="submit" className="px-4 py-2 bg-[#3D3B4F] text-white rounded-md text-sm font-bold font-space-mono hover:brightness-110 transition-colors">
                    Switch
                  </button>
                </form>
              </div>

              {/* Active Rules */}
              <section>
                <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
                  <h2 className="font-anybody text-xl font-semibold text-white flex items-center gap-2">
                    <span className="material-symbols-outlined text-[#c5c0ff]" style={{ fontVariationSettings: "'FILL' 1" }}>bolt</span>
                    Active Rules
                  </h2>
                  <span className="font-space-mono text-sm text-[#c0c9c0] bg-[#1f1f21] px-2 py-1 rounded">{activeRules.length} Enforced</span>
                </div>

                <div className="space-y-4">
                  {activeRules.length === 0 ? (
                    <div className="text-center py-8 text-[#c0c9c0] font-dm-sans">No active rules for this repository.</div>
                  ) : (
                    activeRules.map((rule) => {
                      const related = relationships.filter(r => r.from_rule_id === rule.id || r.to_rule_id === rule.id);
                      
                      return (
                        <div key={rule.id} className="glass-card rounded-lg p-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center space-x-3 mb-2">
                              <span className="font-space-mono font-bold text-[#b6f0c8] bg-[#b6f0c8]/10 px-2 py-0.5 rounded border border-[#b6f0c8]/20" title={rule.id}>#{shortId(rule.id)}</span>
                              <h3 className="font-dm-sans text-lg text-white font-semibold">{rule.body.length > 50 ? `${rule.body.substring(0, 50)}...` : rule.body}</h3>
                            </div>
                            <p className="font-dm-sans text-[#c0c9c0] mb-3">{rule.body}</p>
                            
                            {/* Relationships Tags */}
                            {related.length > 0 && (
                              <div className="mb-3 space-y-2">
                                {related.map(rel => {
                                  const isFrom = rel.from_rule_id === rule.id;
                                  const otherId = isFrom ? rel.to_rule_id : rel.from_rule_id;
                                  
                                  return (
                                    <span key={rel.id} className="inline-flex items-center gap-1 font-dm-sans text-xs font-medium text-[#c5c0ff] bg-[#413996]/20 px-2 py-1 rounded border border-[#413996]/30 mr-2">
                                      <span className="material-symbols-outlined text-[14px]">account_tree</span>
                                      <span>{isFrom ? 'Refines' : 'Refined by'} Rule #{shortId(otherId)}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            )}

                            <div className="flex flex-wrap items-center gap-3">
                              {rule.priority === 'high' ? (
                                <span className="inline-flex items-center gap-1 font-dm-sans text-xs font-medium text-[#ffb4ab] bg-[#93000a]/20 px-2 py-1 rounded border border-[#93000a]/30">
                                  <span className="material-symbols-outlined text-[14px]">priority_high</span>
                                  <span>High Priority</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-dm-sans text-xs font-medium text-[#d3c5a7] bg-[#f0e1c2]/10 px-2 py-1 rounded border border-[#f0e1c2]/20">
                                  <span className="material-symbols-outlined text-[14px]">remove</span>
                                  <span>Normal Priority</span>
                                </span>
                              )}
                              <span className="inline-flex items-center gap-1 font-dm-sans text-xs text-[#c0c9c0]">
                                <span className="material-symbols-outlined text-[14px]">visibility</span>
                                <span>Caught: {rule.evidence_count} times</span>
                              </span>
                            </div>
                          </div>
                          
                          <div className="flex-shrink-0 flex space-x-2">
                            <button className="text-[#c0c9c0] hover:text-white p-1 hover:bg-white/5 rounded transition-colors"><span className="material-symbols-outlined">edit</span></button>
                            <button className="text-[#c0c9c0] hover:text-[#ffb4ab] p-1 hover:bg-[#93000a]/20 rounded transition-colors"><span className="material-symbols-outlined">delete</span></button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              {/* Superseded Rules */}
              {supersededRules.length > 0 && (
                <section className="opacity-60 hover:opacity-100 transition-opacity duration-300">
                  <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
                    <h2 className="font-anybody text-xl font-semibold text-[#c0c9c0] flex items-center gap-2">
                      <span className="material-symbols-outlined text-[#c0c9c0]">history</span>
                      Superseded Rules
                    </h2>
                  </div>
                  
                  <div className="space-y-2">
                    {supersededRules.map((rule) => {
                      const replacingRule = rules.find(r => r.id === rule.superseded_by);
                      return (
                        <div key={rule.id} className="flex items-center justify-between py-2 border-b border-white/5 gap-4">
                          <div className="flex items-center gap-3 overflow-hidden">
                            <span className="font-space-mono text-[#c0c9c0] line-through flex-shrink-0" title={rule.id}>#{shortId(rule.id)}</span>
                            <span className="font-dm-sans text-[#c0c9c0] line-through truncate">{rule.body}</span>
                          </div>
                          {replacingRule && (
                            <span className="font-dm-sans text-xs text-[#8a938b] italic whitespace-nowrap flex-shrink-0">
                              Replaced by Rule #{shortId(replacingRule.id)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>

            {/* Right Column: Sidebar Actions */}
            <div className="lg:col-span-4 space-y-6">
              <div className="sticky top-24 space-y-6">
                {/* Create Rule Form */}
                <div className="glass-card rounded-xl p-6">
                  <h3 className="font-anybody text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>add_circle</span>
                    Create a Rule
                  </h3>
                  <CreateRuleForm repo={repo} />
                </div>

                {/* How it Works Explainer */}
                <div className="bg-[#353437]/30 rounded-xl p-6 border border-white/5">
                  <h4 className="font-dm-sans text-lg text-[#c5c0ff] font-semibold mb-2 flex items-center gap-2">
                    <span className="material-symbols-outlined">lightbulb</span>
                    How it Works
                  </h4>
                  <p className="font-dm-sans text-[#c0c9c0] leading-relaxed text-sm">
                    The <strong>Contradiction Engine</strong> analyzes incoming PRs against this memory bank. If new code violates an active rule, or if rules contradict each other semantically, Parakh flags it instantly, ensuring architectural integrity without manual nagging.
                  </p>
                </div>
              </div>
            </div>
            
          </div>
        )}
        </div>
      </main>
    </div>
  );
}
