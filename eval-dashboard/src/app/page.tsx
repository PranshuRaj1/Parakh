import Link from 'next/link';
import { LineChart } from '@/components/LineChart';
import { getCasesForRuns, getRuns } from '@/lib/data';

export const dynamic = 'force-dynamic';

const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const number = (value: number | null) => value === null ? '—' : value.toLocaleString();

export default async function EvalsPage() {
  const runs = await getRuns();
  const cases = await getCasesForRuns(runs.map(run => run.runId));
  const latest = runs[0];
  const latestCases = cases.filter(item => item.runId === latest?.runId);
  const avgTokens = latestCases.length ? latestCases.reduce((sum, item) => sum + item.inputTokens, 0) / latestCases.length : null;
  const avgLatency = latestCases.length ? latestCases.reduce((sum, item) => sum + item.latencyMs, 0) / latestCases.length : null;
  const avgFallback = latestCases.filter(item => item.fallbackRate !== null).reduce((sum, item) => sum + (item.fallbackRate ?? 0), 0) / (latestCases.filter(item => item.fallbackRate !== null).length || 1);

  return (
    <main className="shell">
      <div className="eyebrow">Parakh / Eval lab</div>
      <h1 className="display">A review system you can measure.</h1>
      <p className="lede">Every point below comes from a pinned repository case, a gold set, and an adjudicated review. This is the trail from file-by-file review to semantic retrieval.</p>

      {!latest ? <div className="panel empty section">No published eval runs yet.</div> : <>
        <section className="grid stats">
          <div className="panel metric"><strong className="accent">{percent(latest.score)}</strong><span>Latest strict F1</span></div>
          <div className="panel metric"><strong>{number(avgTokens)}</strong><span>Avg input tokens</span></div>
          <div className="panel metric"><strong>{avgLatency === null ? '—' : `${(avgLatency / 1000).toFixed(1)}s`}</strong><span>Avg latency</span></div>
          <div className="panel metric"><strong className={avgFallback > 0 ? 'yellow' : 'accent'}>{percent(avgFallback)}</strong><span>Retrieval fallback</span></div>
        </section>

        <section className="grid two">
          <div className="panel"><h2>Quality over time</h2><p>Mean strict F1 for the evolving pipeline. Comparable runs share the same corpus and configuration.</p><LineChart label="strict F1" suffix="%" values={runs.slice().reverse().map(run => ({ label: run.createdAt, value: run.score === null ? null : run.score * 100 }))} /></div>
          <div className="panel"><h2>The useful signal</h2><p className="note">Semantic retrieval is working when input tokens and fallback rate fall without sacrificing strict F1. Open a case to follow that tradeoff across commits.</p><p>{latestCases.length} cases in the latest run · <code>{latest.commitSha.slice(0, 12)}</code></p></div>
        </section>

        <section className="panel section">
          <h2>Run history</h2>
          <p>Newest published comparisons first.</p>
          <div className="table-wrap"><table><thead><tr><th>Date</th><th>Commit</th><th>Score</th><th>Cases</th><th>Details</th></tr></thead><tbody>
            {runs.map(run => <tr key={run.runId}><td>{new Date(run.createdAt).toLocaleString()}</td><td><code>{run.commitSha.slice(0, 12)}</code></td><td>{percent(run.score)}</td><td>{cases.filter(item => item.runId === run.runId).length}</td><td><Link href={`/runs/${run.runId}`}>Open run →</Link></td></tr>)}
          </tbody></table></div>
        </section>

        <section className="panel section"><h2>Cases in the latest run</h2><p>Choose a case to see quality, cost, speed, and retrieval over time.</p><div className="table-wrap"><table><thead><tr><th>Case</th><th>Assessment</th><th>F1</th><th>Tokens</th><th>Fallback</th><th></th></tr></thead><tbody>
          {latestCases.map(item => <tr key={item.caseId}><td><code>{item.caseId}</code></td><td>{item.assessment}</td><td>{percent(item.strictF1)}</td><td>{number(item.inputTokens)}</td><td>{percent(item.fallbackRate)}</td><td><Link href={`/cases/${encodeURIComponent(item.caseId)}`}>Trend →</Link></td></tr>)}
        </tbody></table></div></section>
      </>}
    </main>
  );
}
