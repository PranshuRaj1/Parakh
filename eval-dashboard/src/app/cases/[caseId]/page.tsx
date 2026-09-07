import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LineChart } from '@/components/LineChart';
import { getCase, getRuns } from '@/lib/data';

export const dynamic = 'force-dynamic';

const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

export default async function CasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const [runs, points] = await Promise.all([getRuns(), getCase(caseId)]);
  if (!points.length) notFound();
  const byId = new Map(runs.map(run => [run.runId, run]));
  const dates = points.map(point => ({ point, run: byId.get(point.runId) })).filter(item => item.run);
  return <main className="shell"><Link href="/">← Eval lab</Link><div className="eyebrow" style={{ marginTop: 40 }}>Case trend</div><h1 className="display">{caseId}</h1><p className="lede">One pinned case across every published run. The charts show whether semantic grouping changed the cost of review without hiding quality.</p><section className="grid two section"><div className="panel"><h2>Strict F1</h2><LineChart label="strict F1" suffix="%" values={dates.map(({ point, run }) => ({ label: run!.createdAt, value: point.strictF1 === null ? null : point.strictF1 * 100 }))} /></div><div className="panel"><h2>Input tokens</h2><LineChart label="input tokens" values={dates.map(({ point, run }) => ({ label: run!.createdAt, value: point.inputTokens }))} /></div></section><section className="grid two section"><div className="panel"><h2>Latency</h2><LineChart label="latency" values={dates.map(({ point, run }) => ({ label: run!.createdAt, value: point.latencyMs / 1000 }))} /></div><div className="panel"><h2>Fallback rate</h2><LineChart label="fallback rate" suffix="%" values={dates.map(({ point, run }) => ({ label: run!.createdAt, value: point.fallbackRate === null ? null : point.fallbackRate * 100 }))} /></div></section><section className="panel section"><h2>Run-by-run detail</h2><div className="table-wrap"><table><thead><tr><th>Date</th><th>Commit</th><th>F1</th><th>Tokens</th><th>Calls</th><th>Behavior / file</th><th>Planning groups</th></tr></thead><tbody>{dates.map(({ point, run }) => <tr key={point.runId}><td>{new Date(run!.createdAt).toLocaleDateString()}</td><td><code>{run!.commitSha.slice(0, 12)}</code></td><td>{pct(point.strictF1)}</td><td>{point.inputTokens.toLocaleString()}</td><td>{point.providerCalls}</td><td>{point.behaviorCalls ?? '—'} / {point.fileCalls ?? '—'}</td><td>{point.planningGroups ?? '—'}</td></tr>)}</tbody></table></div></section></main>;
}
