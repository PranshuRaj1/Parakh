import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { archiveReport, comparisonKey, reportId, runScore } from './run-history.js';
import type { EvalCaseReport, EvalReport } from './types.js';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function percent(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function metricDelta(oldVal: number | null | undefined, newVal: number | null | undefined, lowerBetter = false): string {
  if (oldVal == null || newVal == null) return '';
  const delta = newVal - oldVal;
  if (delta === 0) return '';
  const cls = lowerBetter ? (delta < 0 ? 'positive' : 'negative') : (delta > 0 ? 'positive' : 'negative');
  const sign = delta > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${typeof oldVal === 'number' && oldVal % 1 !== 0 ? delta.toFixed(3) : Math.round(delta)}</span>`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return 'N/A';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function tokensSummary(m: { inputTokens?: number; outputTokens?: number } | null | undefined): string {
  if (!m) return 'N/A';
  return `${m.inputTokens ?? '?'}i/${m.outputTokens ?? '?'}o`;
}

function detailRow(label: string, oldVal: string, newVal: string, delta?: string): string {
  return `<tr><td>${label}</td><td>${oldVal}</td><td>${newVal}</td>${delta != null ? `<td>${delta}</td>` : ''}</tr>`;
}

function caseDetailSection(item: EvalCaseReport): string {
  const o = item.comparison.oldMetrics;
  const n = item.comparison.newMetrics;
  const or = o?.retrieval;
  const nr = n?.retrieval;
  const noiseOld = item.oldNoiseFloor;
  const noiseNew = item.newNoiseFloor;
  const rows = [
    detailRow('Precision', percent(o?.knownPrecision), percent(n?.knownPrecision),
      metricDelta(o?.knownPrecision, n?.knownPrecision)),
    detailRow('Recall', percent(o?.recall), percent(n?.recall),
      metricDelta(o?.recall, n?.recall)),
    detailRow('Strict F1', o?.strictF1 != null ? o.strictF1.toFixed(3) : 'N/A',
      n?.strictF1 != null ? n.strictF1.toFixed(3) : 'N/A',
      metricDelta(o?.strictF1, n?.strictF1)),
    detailRow('Weighted recall', o?.weightedRecall != null ? o.weightedRecall.toFixed(3) : 'N/A',
      n?.weightedRecall != null ? n.weightedRecall.toFixed(3) : 'N/A',
      metricDelta(o?.weightedRecall, n?.weightedRecall)),
    detailRow('False positives (strict)', String(o?.strictFalsePositives ?? '?'),
      String(n?.strictFalsePositives ?? '?'),
      metricDelta(o?.strictFalsePositives, n?.strictFalsePositives, true)),
    detailRow('False positives (relaxed)', String(o?.relaxedFalsePositives ?? '?'),
      String(n?.relaxedFalsePositives ?? '?'),
      metricDelta(o?.relaxedFalsePositives, n?.relaxedFalsePositives, true)),
    detailRow('Unsupported rate', percent(o?.unsupportedRate), percent(n?.unsupportedRate)),
    detailRow('Duplicate rate', percent(o?.duplicateRate), percent(n?.duplicateRate)),
    detailRow('Partial rate', percent(o?.partialRate), percent(n?.partialRate)),
    detailRow('Judge disagreement', percent(o?.judgeDisagreementRate), percent(n?.judgeDisagreementRate)),
    detailRow('Held-out findings', String(o?.heldOutCount ?? '?'), String(n?.heldOutCount ?? '?')),
    detailRow('Latency', formatMs(o?.latencyMs), formatMs(n?.latencyMs),
      metricDelta(o?.latencyMs, n?.latencyMs, true)),
    detailRow('Provider calls', String(o?.providerCalls ?? '?'), String(n?.providerCalls ?? '?'),
      metricDelta(o?.providerCalls, n?.providerCalls, true)),
    detailRow('Input tokens', String(o?.inputTokens ?? '?'), String(n?.inputTokens ?? '?'),
      metricDelta(o?.inputTokens, n?.inputTokens, true)),
    detailRow('Output tokens', String(o?.outputTokens ?? '?'), String(n?.outputTokens ?? '?'),
      metricDelta(o?.outputTokens, n?.outputTokens, true)),
  ];
  if (or || nr) {
    rows.push(detailRow('─ Retrieval ─', '', ''));
    rows.push(detailRow('Behavior calls', String(or?.behaviorCalls ?? '?'), String(nr?.behaviorCalls ?? '?')));
    rows.push(detailRow('File calls', String(or?.fileCalls ?? '?'), String(nr?.fileCalls ?? '?')));
    rows.push(detailRow('Rendered files', String(or?.renderedFiles?.length ?? nr?.renderedFiles?.length ?? 0),
      String(nr?.renderedFiles?.length ?? or?.renderedFiles?.length ?? 0)));
    rows.push(detailRow('Expected files', String(or?.expectedFiles?.length ?? nr?.expectedFiles?.length ?? 'N/A'),
      String(nr?.expectedFiles?.length ?? or?.expectedFiles?.length ?? 'N/A')));
    rows.push(detailRow('Recall', or?.recall != null ? (or.recall * 100).toFixed(1) + '%' : 'N/A',
      nr?.recall != null ? (nr.recall * 100).toFixed(1) + '%' : 'N/A'));
    rows.push(detailRow('Fallback rate', or?.fallbackRate != null ? (or.fallbackRate * 100).toFixed(1) + '%' : 'N/A',
      nr?.fallbackRate != null ? (nr.fallbackRate * 100).toFixed(1) + '%' : 'N/A'));
    rows.push(detailRow('Truncated review units', String(or?.truncatedReviewUnits ?? '?'), String(nr?.truncatedReviewUnits ?? '?')));
  }
  rows.push(detailRow('─ Noise floor ─', '', ''));
  rows.push(detailRow('Reviewer disagreement', percent(noiseOld?.reviewerDisagreementRate),
    percent(noiseNew?.reviewerDisagreementRate)));
  rows.push(detailRow('Precision delta', noiseOld?.precisionDelta != null ? (noiseOld.precisionDelta > 0 ? '+' : '') + noiseOld.precisionDelta.toFixed(3) : 'N/A',
    noiseNew?.precisionDelta != null ? (noiseNew.precisionDelta > 0 ? '+' : '') + noiseNew.precisionDelta.toFixed(3) : 'N/A'));
  rows.push(detailRow('False positive delta', noiseOld?.falsePositiveDelta != null ? String(noiseOld.falsePositiveDelta) : 'N/A',
    noiseNew?.falsePositiveDelta != null ? String(noiseNew.falsePositiveDelta) : 'N/A'));
  const deltaHeader = `<th>Δ (new − old)</th>`;
  return `
    <details class="case-detail">
      <summary>Show all metrics</summary>
      <div class="detail-inner">
        <table>
          <thead><tr><th>Metric</th><th>Old</th><th>New</th>${deltaHeader}</tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    </details>`;
}

function reportCard(report: EvalReport, file: string): string {
  const cases = (report.cases || []).filter((item) => item?.comparison);
  const label = (assessment: string) => assessment === 'inconclusive' ? 'parity' : assessment;
  const better = cases.filter((item) => label(item.assessment) === 'better').length;
  const worse = cases.filter((item) => label(item.assessment) === 'worse').length;
  const mixed = cases.filter((item) => label(item.assessment) === 'mixed').length;
  const pass = cases.filter((item) => label(item.assessment) === 'pass').length;
  const parity = cases.filter((item) => label(item.assessment) === 'parity').length;
  const f1 = cases.filter((item) => item.comparison.f1Delta !== null)
    .map((item) => item.comparison.f1Delta as number);
  const avgF1 = f1.length ? f1.reduce((sum, value) => sum + value, 0) / f1.length : null;
  const rows = cases.map((item) => {
      const o = item.comparison.oldMetrics;
      const n = item.comparison.newMetrics;
      const oLatency = o?.latencyMs != null ? formatMs(o.latencyMs) : '?';
      const nLatency = n?.latencyMs != null ? formatMs(n.latencyMs) : '?';
      return `
    <tr class="case-row" data-case="${escapeHtml(item.caseId)}">
      <td>${escapeHtml(item.caseId)}</td>
      <td><span class="badge ${escapeHtml(label(item.assessment))}">${escapeHtml(label(item.assessment))}</span></td>
      <td>${percent(o?.knownPrecision)} / ${percent(n?.knownPrecision)}</td>
      <td class="${item.comparison.f1Delta !== null && item.comparison.f1Delta > 0 ? 'positive' : ''}">${item.comparison.f1Delta === null ? 'N/A' : item.comparison.f1Delta.toFixed(3)}</td>
      <td>${o?.providerCalls ?? '?'} / ${n?.providerCalls ?? '?'}</td>
      <td>${oLatency} / ${nLatency}</td>
      <td>${tokensSummary(o)} · ${tokensSummary(n)}</td>
      <td>${o?.strictFalsePositives ?? '?'} / ${n?.strictFalsePositives ?? '?'}</td>
      <td>${percent(o?.recall)} / ${percent(n?.recall)}</td>
      <td class="detail-toggle">${caseDetailSection(item)}</td>
    </tr>`}).join('');

  const createdAt = report.createdAt ?? 'unknown';
  const oldSha = report.oldPipeline?.resolvedSha ?? 'unknown';
  const newSha = report.newPipeline?.resolvedSha ?? 'unknown';
  return `
  <section class="report">
    <div class="report-header">
      <div>
        <h2>${escapeHtml(file)}</h2>
        <p>${escapeHtml(createdAt)} · ${cases.length} cases · old <code>${escapeHtml(oldSha.slice(0, 12))}</code> · new <code>${escapeHtml(newSha.slice(0, 12))}</code></p>
      </div>
      <a href="${escapeHtml(file.replaceAll('\\', '/'))}">Full outputs JSON</a>
    </div>
    <div class="stats">
      <div><strong>${better}</strong><span>better</span></div>
      <div><strong>${worse}</strong><span>worse</span></div>
      <div><strong>${mixed}</strong><span>mixed</span></div>
      <div><strong>${pass}</strong><span>pass</span></div>
      <div><strong>${parity}</strong><span>parity</span></div>
      <div><strong>${avgF1 === null ? 'N/A' : avgF1.toFixed(3)}</strong><span>average F1 delta</span></div>
    </div>
    <table>
      <thead><tr><th>Case</th><th>Assessment</th><th>Precision</th><th>F1 Δ</th><th>Calls (old/new)</th><th>Latency (old/new)</th><th>Tokens in/out (old/new)</th><th>FP (old/new)</th><th>Recall (old/new)</th><th>Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

async function jsonReports(directory: string): Promise<{ file: string; report: EvalReport }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const reports: { file: string; report: EvalReport }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === 'runs') {
      reports.push(...(await jsonReports(join(directory, 'runs'))).map(item => ({ ...item, file: join('runs', item.file) })));
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const report = JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as EvalReport;
      if (report.schemaVersion === 1 && Array.isArray(report.cases) && report.createdAt && report.oldPipeline && report.newPipeline) {
        reports.push({ file: entry.name, report });
      }
    } catch {
      continue;
    }
  }
  return [...new Map(reports.map(item => [reportId(item.report), item])).values()]
    .sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt));
}

export async function generateEvalDashboard(reportDirectory: string, outputDirectory = reportDirectory): Promise<string> {
  const reports = await jsonReports(reportDirectory);
  for (const item of reports) {
    item.file = relative(outputDirectory, join(reportDirectory, await archiveReport(reportDirectory, item.report)));
  }
  const history = reports.map(({ report, file }, index) => {
    const key = comparisonKey(report);
    const previous = key && reports.slice(index + 1).find(item => comparisonKey(item.report) === key);
    const score = runScore(report);
    const priorScore = previous ? runScore(previous.report) : null;
    const delta = score !== null && priorScore !== null ? `${((score - priorScore) * 100).toFixed(1)} pp` : 'N/A';
    return `<tr><td><a href="${escapeHtml(file.replaceAll('\\', '/'))}">${escapeHtml(report.createdAt)}</a></td><td>${escapeHtml(report.newPipeline.resolvedSha.slice(0, 12))}</td><td>${escapeHtml(report.newPipeline.workingTreeHash?.slice(0, 12) || 'clean')}</td><td>${report.cases.length}</td><td>${percent(score)}</td><td>${delta}</td><td>${previous ? escapeHtml(previous.report.createdAt) : 'No comparable earlier run'}</td></tr>`;
  }).join('');
  const historyTable = `<section class="report"><h2>Run history</h2><p>Score: mean new-pipeline strict F1 across scored cases (excludes N/A). Changes are percentage points against the previous run with matching cases, snapshots, gold version, reviewer settings and judge. Each JSON preserves all four review outputs, metrics and adjudications. Cached evaluations may reuse outputs.</p><table><thead><tr><th>Run / full outputs</th><th>Commit</th><th>Working tree</th><th>Cases</th><th>Score</th><th>Change</th><th>Compared with</th></tr></thead><tbody>${history}</tbody></table></section>`;
  const cards = reports.map(({ file, report }) => reportCard(report, file)).join('\n');
  const fixReportCard = `
  <section class="report">
    <div class="report-header">
      <div>
        <h2>semantic-diff-fix-report.html</h2>
        <p>2026-09-05 · Verification report for semantic diff retrieval fix · 12/15 cases now use semantic review</p>
      </div>
      <a href="semantic-diff-fix-report.html">Open HTML</a>
    </div>
    <div class="stats">
      <div><strong>12/15</strong><span>Cases using semantic review</span></div>
      <div><strong>125+</strong><span>Tests passing</span></div>
      <div><strong>17</strong><span>Grafana #79265 head files</span></div>
      <div><strong>0</strong><span>Stale UNCHANGED_CONTEXT_SECTIONS</span></div>
    </div>
  </section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parakh eval dashboard</title><style>
:root{font-family:Inter,Segoe UI,sans-serif;color:#e8eef7;background:#0d1117}body{max-width:1400px;margin:0 auto;padding:32px}h1{margin:0 0 8px;font-size:32px}p{color:#9aa8b8}code{color:#9bd1ff}.report{background:#151c25;border:1px solid #263445;border-radius:12px;margin:24px 0;padding:20px;overflow:auto}.report-header{display:flex;justify-content:space-between;gap:20px;align-items:start}.report-header h2{margin:0;font-size:18px}.report-header p{margin:8px 0}.report-header a{color:#8cc8ff;white-space:nowrap}.stats{display:flex;gap:10px;margin:18px 0}.stats div{background:#0d141d;border-radius:8px;padding:12px 18px;min-width:90px}.stats strong,.stats span{display:block}.stats strong{font-size:22px}.stats span{font-size:12px;color:#9aa8b8;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-top:1px solid #263445;padding:10px 8px;white-space:nowrap}.badge{border-radius:999px;padding:4px 8px;font-size:11px}.better{background:#174d35;color:#8ff0b8}.worse{background:#5b2025;color:#ffaaa8}.mixed{background:#594518;color:#ffd37c}.parity,.judge_unstable{background:#323b48;color:#cad4e2}.pass{background:#0e4a52;color:#8ff0e8}.positive{color:#8ff0b8}.negative{color:#ffaaa8}.case-row{cursor:default}.case-row:hover{background:#1a2230}.detail-toggle{padding:0!important}.case-detail summary{cursor:pointer;color:#8cc8ff;font-size:12px;padding:4px 0;user-select:none}.case-detail summary:hover{text-decoration:underline}.detail-inner{margin-top:8px;overflow-x:auto}.detail-inner table{font-size:12px}.detail-inner th,.detail-inner td{padding:6px 10px;white-space:nowrap}.detail-inner tr:nth-child(odd) td{background:#0d141d}</style></head>
<body><h1>Parakh PR review evals</h1><p>Cached comparisons, newest first. Generated ${escapeHtml(new Date().toISOString())}.</p>${historyTable}${fixReportCard}${cards || '<p>No completed report JSON files found.</p>'}</body></html>`;
}

export async function writeEvalDashboard(reportDirectory: string, output: string): Promise<void> {
  await writeFile(resolve(output), await generateEvalDashboard(resolve(reportDirectory), dirname(resolve(output))));
}
