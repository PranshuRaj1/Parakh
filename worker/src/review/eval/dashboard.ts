import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvalReport } from './types.js';

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

function reportCard(report: EvalReport, file: string): string {
  const cases = report.cases;
  const better = cases.filter((item) => item.assessment === 'better').length;
  const worse = cases.filter((item) => item.assessment === 'worse').length;
  const mixed = cases.filter((item) => item.assessment === 'mixed').length;
  const inconclusive = cases.filter((item) => item.assessment === 'inconclusive').length;
  const f1 = cases.filter((item) => item.comparison.f1Delta !== null)
    .map((item) => item.comparison.f1Delta as number);
  const avgF1 = f1.length ? f1.reduce((sum, value) => sum + value, 0) / f1.length : null;
  const rows = cases.map((item) => `
    <tr>
      <td>${escapeHtml(item.caseId)}</td>
      <td><span class="badge ${escapeHtml(item.assessment)}">${escapeHtml(item.assessment)}</span></td>
      <td>${percent(item.comparison.oldMetrics.knownPrecision)}</td>
      <td>${percent(item.comparison.newMetrics.knownPrecision)}</td>
      <td class="${item.comparison.f1Delta !== null && item.comparison.f1Delta > 0 ? 'positive' : ''}">${item.comparison.f1Delta === null ? 'N/A' : item.comparison.f1Delta.toFixed(3)}</td>
      <td>${item.comparison.oldMetrics.providerCalls} / ${item.comparison.newMetrics.providerCalls}</td>
    </tr>`).join('');

  return `
  <section class="report">
    <div class="report-header">
      <div>
        <h2>${escapeHtml(file)}</h2>
        <p>${escapeHtml(report.createdAt)} · ${cases.length} cases · old <code>${escapeHtml(report.oldPipeline.resolvedSha.slice(0, 12))}</code> · new <code>${escapeHtml(report.newPipeline.resolvedSha.slice(0, 12))}</code></p>
      </div>
      <a href="${escapeHtml(file.replaceAll('\\', '/').replace(/\.json$/, '.md'))}">Open Markdown</a>
    </div>
    <div class="stats">
      <div><strong>${better}</strong><span>better</span></div>
      <div><strong>${worse}</strong><span>worse</span></div>
      <div><strong>${mixed}</strong><span>mixed</span></div>
      <div><strong>${inconclusive}</strong><span>inconclusive</span></div>
      <div><strong>${avgF1 === null ? 'N/A' : avgF1.toFixed(3)}</strong><span>average F1 delta</span></div>
    </div>
    <table>
      <thead><tr><th>Case</th><th>Assessment</th><th>Old precision</th><th>New precision</th><th>F1 delta</th><th>Calls old / new</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

async function jsonReports(directory: string): Promise<{ file: string; report: EvalReport }[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const reports: { file: string; report: EvalReport }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const report = JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as EvalReport;
      if (report.schemaVersion === 1 && Array.isArray(report.cases)) {
        reports.push({ file: entry.name, report });
      }
    } catch {
      continue;
    }
  }
  return reports.sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt));
}

export async function generateEvalDashboard(reportDirectory: string): Promise<string> {
  const reports = await jsonReports(reportDirectory);
  const cards = reports.map(({ file, report }) => reportCard(report, file)).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parakh eval dashboard</title><style>
:root{font-family:Inter,Segoe UI,sans-serif;color:#e8eef7;background:#0d1117}body{max-width:1400px;margin:0 auto;padding:32px}h1{margin:0 0 8px;font-size:32px}p{color:#9aa8b8}code{color:#9bd1ff}.report{background:#151c25;border:1px solid #263445;border-radius:12px;margin:24px 0;padding:20px;overflow:auto}.report-header{display:flex;justify-content:space-between;gap:20px;align-items:start}.report-header h2{margin:0;font-size:18px}.report-header p{margin:8px 0}.report-header a{color:#8cc8ff;white-space:nowrap}.stats{display:flex;gap:10px;margin:18px 0}.stats div{background:#0d141d;border-radius:8px;padding:12px 18px;min-width:90px}.stats strong,.stats span{display:block}.stats strong{font-size:22px}.stats span{font-size:12px;color:#9aa8b8;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-top:1px solid #263445;padding:10px 8px;white-space:nowrap}.badge{border-radius:999px;padding:4px 8px;font-size:11px}.better{background:#174d35;color:#8ff0b8}.worse{background:#5b2025;color:#ffaaa8}.mixed{background:#594518;color:#ffd37c}.inconclusive,.judge_unstable{background:#323b48;color:#cad4e2}.positive{color:#8ff0b8}</style></head>
<body><h1>Parakh PR review evals</h1><p>Cached comparisons, newest first. Generated ${escapeHtml(new Date().toISOString())}.</p>${cards || '<p>No completed report JSON files found.</p>'}</body></html>`;
}

export async function writeEvalDashboard(reportDirectory: string, output: string): Promise<void> {
  await writeFile(resolve(output), await generateEvalDashboard(resolve(reportDirectory)));
}
