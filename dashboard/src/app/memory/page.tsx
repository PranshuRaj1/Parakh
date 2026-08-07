import { getDashboardRules, getDashboardRuleRelationships } from '@/lib/db';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import CreateRuleForm from '@/components/CreateRuleForm';
import { formatDistanceToNow } from 'date-fns';

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
  let rules = [];
  let relationships = [];
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
  const inactiveRules = rules.filter(r => r.status === 'INACTIVE');

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Repository Memory</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Rules learned and enforced for <strong className="font-semibold">{repo}</strong>
          </p>
        </div>
        <form className="flex gap-2" method="GET">
          <input
            type="text"
            name="repo"
            defaultValue={repo}
            placeholder="owner/repo"
            className="rounded-md border-gray-300 dark:border-zinc-700 dark:bg-zinc-900 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
          />
          <button type="submit" className="px-4 py-2 bg-gray-100 dark:bg-zinc-800 rounded-md text-sm font-medium hover:bg-gray-200 dark:hover:bg-zinc-700 transition-colors">
            Switch
          </button>
        </form>
      </div>

      {dbError ? (
        <div className="bg-red-50 text-red-700 p-4 rounded-xl border border-red-200">
          Failed to connect to the database. Make sure DATABASE_URL is set in .env.local.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white dark:bg-zinc-950 rounded-xl shadow-sm border border-gray-200 dark:border-zinc-800 overflow-hidden">
              <div className="px-6 py-5 border-b border-gray-200 dark:border-zinc-800">
                <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-white flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500"></span>
                  Active Rules ({activeRules.length})
                </h3>
              </div>
              <ul className="divide-y divide-gray-200 dark:divide-zinc-800">
                {activeRules.length === 0 ? (
                  <li className="px-6 py-8 text-center text-gray-500">No active rules for this repository.</li>
                ) : (
                  activeRules.map((rule) => (
                    <li key={rule.id} className="px-6 py-5 hover:bg-gray-50 dark:hover:bg-zinc-900/50 transition-colors">
                      <div className="flex items-start justify-between">
                        <div className="max-w-2xl">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{rule.body}</p>
                          <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                            <span className={`px-2 py-0.5 rounded-full font-medium ${rule.priority === 'high' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' : 'bg-gray-100 text-gray-800 dark:bg-zinc-800 dark:text-gray-300'}`}>
                              {rule.priority} priority
                            </span>
                            <span>{rule.evidence_count} violations caught</span>
                            <span>{rule.reinforcement_count > 0 && `${rule.reinforcement_count} duplicate teachings`}</span>
                          </div>
                        </div>
                        <div className="text-xs text-gray-400">
                          {formatDistanceToNow(new Date(rule.created_at), { addSuffix: true })}
                        </div>
                      </div>
                      
                      {/* Show relationships if any */}
                      {relationships.filter(r => r.from_rule_id === rule.id || r.to_rule_id === rule.id).length > 0 && (
                        <div className="mt-4 pl-4 border-l-2 border-indigo-100 dark:border-indigo-900/50">
                          <p className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 mb-2">Relationships</p>
                          <ul className="space-y-2">
                            {relationships.filter(r => r.from_rule_id === rule.id || r.to_rule_id === rule.id).map(rel => {
                              const isFrom = rel.from_rule_id === rule.id;
                              const otherId = isFrom ? rel.to_rule_id : rel.from_rule_id;
                              const otherRule = rules.find(r => r.id === otherId);
                              if (!otherRule) return null;
                              return (
                                <li key={rel.id} className="text-xs text-gray-600 dark:text-gray-400 flex items-start gap-2">
                                  <span className="px-1.5 py-0.5 bg-gray-100 dark:bg-zinc-800 rounded font-medium text-[10px] tracking-wider uppercase">
                                    {rel.relationship}
                                  </span>
                                  <span className="truncate">{isFrom ? 'refines' : 'refined by'} "{otherRule.body}"</span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))
                )}
              </ul>
            </div>

            {supersededRules.length > 0 && (
              <div className="bg-white dark:bg-zinc-950 rounded-xl shadow-sm border border-gray-200 dark:border-zinc-800 overflow-hidden opacity-75">
                <div className="px-6 py-5 border-b border-gray-200 dark:border-zinc-800">
                  <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-white flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-500"></span>
                    Superseded Rules ({supersededRules.length})
                  </h3>
                </div>
                <ul className="divide-y divide-gray-200 dark:divide-zinc-800">
                  {supersededRules.map((rule) => {
                    const replacingRule = rules.find(r => r.id === rule.superseded_by);
                    return (
                      <li key={rule.id} className="px-6 py-5">
                        <p className="text-sm text-gray-600 dark:text-gray-400 line-through">{rule.body}</p>
                        {replacingRule && (
                          <div className="mt-3 text-xs flex items-start gap-2 text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/10 p-2 rounded-md">
                            <span className="font-semibold whitespace-nowrap">Replaced by:</span>
                            <span>{replacingRule.body}</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <CreateRuleForm repo={repo} />
            
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 p-6 rounded-xl border border-indigo-100 dark:border-indigo-900/50">
              <h4 className="font-semibold text-indigo-900 dark:text-indigo-200 mb-2">How it works</h4>
              <p className="text-sm text-indigo-700/80 dark:text-indigo-300/80 leading-relaxed mb-4">
                When you add a rule here, it's immediately embedded and checked against existing rules using the <strong>Contradiction Engine</strong>.
              </p>
              <ul className="text-xs space-y-2 text-indigo-800 dark:text-indigo-200">
                <li className="flex gap-2"><span>🔄</span> If it contradicts an older rule, it supersedes it.</li>
                <li className="flex gap-2"><span>✨</span> If it's a refinement, both are kept and linked.</li>
                <li className="flex gap-2"><span>🛡️</span> Priority determines the severity of violations caught in PRs.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
