import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRun } from '@/lib/data';

export const dynamic = 'force-dynamic';

const pct = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { run, cases } = await getRun(runId);
  if (!run) notFound();
  return <main className="shell"><Link href="/">← Eval lab</Link><div className="eyebrow" style={{ marginTop: 40 }}>Run detail</div><h1 className="display">{pct(run.score)} strict F1</h1><p className="lede">{new Date(run.createdAt).toLocaleString()} · <code>{run.commitSha}</code> · {run.reviewerModel}</p><section className="panel section"><h2>Configuration</h2><p>{run.corpusVersion} · context budget {run.contextBudget ?? '—'} · working tree {run.workingTreeHash?.slice(0, 12) ?? 'clean'}</p><a href={run.reportUrl}>Download full report JSON →</a></section><section className="panel section"><h2>Case comparison</h2><div className="table-wrap"><table><thead><tr><th>Case</th><th>Assessment</th><th>F1</th><th>Precision</th><th>Recall</th><th>Latency</th><th>Tokens</th><th>Calls</th><th>Retrieval</th></tr></thead><tbody>{cases.map(item => <tr key={item.caseId}><td><Link href={`/cases/${encodeURIComponent(item.caseId)}`}><code>{item.caseId}</code></Link></td><td>{item.assessment}</td><td>{pct(item.strictF1)}</td><td>{pct(item.precision)}</td><td>{pct(item.recall)}</td><td>{(item.latencyMs / 1000).toFixed(1)}s</td><td>{item.inputTokens.toLocaleString()}</td><td>{item.providerCalls}</td><td>{item.behaviorCalls ?? '—'} behavior / {item.fileCalls ?? '—'} file</td></tr>)}</tbody></table></div></section></main>;
}
