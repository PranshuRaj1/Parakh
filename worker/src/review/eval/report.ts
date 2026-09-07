import type {
  AdjudicationOutcome,
  CaseComparison,
  CaseMetrics,
  EvalCaseReport,
  EvalReport,
  EvaluatedRun,
  FindingAdjudication,
  NoiseFloor,
} from './types.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(3);
}

function deltaSymbol(delta: number): string {
  if (delta > 0) return '+';
  if (delta < 0) return '−';
  return ' ';
}

function severityEmoji(outcome: AdjudicationOutcome): string {
  switch (outcome) {
    case 'correct': return '✓';
    case 'partially_correct': return '~';
    case 'incorrect': return '✗';
    case 'unsupported': return '?';
    case 'duplicate': return '=';
    case 'valid_unlisted': return '+';
    case 'needs_human_review': return '!';
  }
}

function renderMetricsTable(metrics: CaseMetrics, label: string): string[] {
  return [
    `  **${label}**`,
    `  | Metric | Value |`,
    `  |--------|-------|`,
    `  | Precision | ${pct(metrics.knownPrecision)} |`,
    `  | Recall | ${metrics.recall === null ? 'N/A' : pct(metrics.recall)} |`,
    `  | F1 | ${metrics.strictF1 === null ? 'N/A' : num(metrics.strictF1)} |`,
    `  | Weighted Recall | ${metrics.weightedRecall === null ? 'N/A' : num(metrics.weightedRecall)} |`,
    `  | False Positives | ${metrics.strictFalsePositives} |`,
    `  | Unsupported Rate | ${pct(metrics.unsupportedRate)} |`,
    `  | Duplicate Rate | ${pct(metrics.duplicateRate)} |`,
    `  | Partial Rate | ${pct(metrics.partialRate)} |`,
    `  | Judge Disagreement | ${pct(metrics.judgeDisagreementRate)} |`,
    `  | Held Out | ${metrics.heldOutCount} (${pct(metrics.heldOutRate)}) |`,
    `  | Latency | ${metrics.latencyMs}ms |`,
    `  | Tokens | ${metrics.inputTokens} in / ${metrics.outputTokens} out |`,
  ];
}

function renderNoiseFloor(noise: NoiseFloor, label: string): string[] {
  return [
    `  **${label} Noise Floor**`,
    `  | Metric | Delta |`,
    `  |--------|-------|`,
    `  | Reviewer Disagreement | ${pct(noise.reviewerDisagreementRate)} |`,
    `  | Precision Δ | ${deltaSymbol(noise.precisionDelta)}${pct(Math.abs(noise.precisionDelta))} |`,
    `  | Recall Δ | ${noise.recallDelta === null ? 'N/A' : `${deltaSymbol(noise.recallDelta)}${pct(Math.abs(noise.recallDelta))}`} |`,
    `  | F1 Δ | ${noise.f1Delta === null ? 'N/A' : `${deltaSymbol(noise.f1Delta)}${num(Math.abs(noise.f1Delta))}`} |`,
    `  | False Positive Δ | ${noise.falsePositiveDelta} |`,
  ];
}

function renderComparison(comparison: CaseComparison): string[] {
  const lines: string[] = [
    `  **Comparison**`,
    `  | Metric | Old | New | Delta |`,
    `  |--------|-----|-----|-------|`,
    `  | Precision | ${pct(comparison.oldMetrics.knownPrecision)} | ${pct(comparison.newMetrics.knownPrecision)} | ${deltaSymbol(comparison.precisionDelta)}${pct(Math.abs(comparison.precisionDelta))} |`,
  ];
  if (comparison.recallDelta !== null) {
    lines.push(
      `  | Recall | ${pct(comparison.oldMetrics.recall ?? 0)} | ${pct(comparison.newMetrics.recall ?? 0)} | ${deltaSymbol(comparison.recallDelta)}${pct(Math.abs(comparison.recallDelta))} |`
    );
  }
  if (comparison.f1Delta !== null) {
    lines.push(
      `  | F1 | ${num(comparison.oldMetrics.strictF1)} | ${num(comparison.newMetrics.strictF1)} | ${deltaSymbol(comparison.f1Delta)}${num(Math.abs(comparison.f1Delta))} |`
    );
  }
  lines.push(
    `  | False Positives | ${comparison.oldMetrics.strictFalsePositives} | ${comparison.newMetrics.strictFalsePositives} | ${comparison.falsePositiveDelta > 0 ? '+' : ''}${comparison.falsePositiveDelta} |`
  );
  lines.push(
    `  | Latency | ${comparison.oldMetrics.latencyMs}ms | ${comparison.newMetrics.latencyMs}ms | ${comparison.latencyDeltaMs > 0 ? '+' : ''}${comparison.latencyDeltaMs}ms |`
  );
  return lines;
}

function renderAdjudications(
  adjudications: FindingAdjudication[],
  label: string
): string[] {
  if (adjudications.length === 0) return [];
  const lines: string[] = [
    `  **${label} Findings**`,
    `  | # | Outcome | File | Line | Body |`,
    `  |---|---------|------|------|------|`,
  ];
  for (let i = 0; i < adjudications.length; i++) {
    const adj = adjudications[i];
    const finding = adj.finding;
    const body = finding.body.length > 80
      ? `${finding.body.slice(0, 77)}...`
      : finding.body;
    lines.push(
      `  | ${i + 1} | ${severityEmoji(adj.outcome)} ${adj.outcome} | ${finding.file} | ${finding.line} | ${body} |`
    );
  }
  return lines;
}

function renderHeldOutSection(report: EvalReport): string[] {
  const heldOut: {
    caseId: string;
    finding: FindingAdjudication;
    pipeline: string;
  }[] = [];

  for (const caseReport of report.cases) {
    for (const [key, run] of Object.entries(caseReport.runs)) {
      const pipelineLabel = key.startsWith('old') ? 'old' : 'new';
      for (const adj of run.adjudications) {
        if (adj.outcome === 'needs_human_review') {
          heldOut.push({
            caseId: caseReport.caseId,
            finding: adj,
            pipeline: pipelineLabel,
          });
        }
      }
    }
  }

  if (heldOut.length === 0) return [];

  const lines: string[] = [
    `## Held-Out Findings (needs_human_review)`,
    ``,
    `Total: ${heldOut.length}`,
    ``,
    `| Case | Pipeline | Finding |`,
    `|------|----------|---------|`,
  ];

  for (const item of heldOut) {
    const body = item.finding.finding.body.length > 60
      ? `${item.finding.finding.body.slice(0, 57)}...`
      : item.finding.finding.body;
    lines.push(
      `| ${item.caseId} | ${item.pipeline} | ${item.finding.finding.file}:${item.finding.finding.line} — ${body} |`
    );
  }

  return lines;
}

function renderPerCaseReport(caseReport: EvalCaseReport): string[] {
  const lines: string[] = [
    `### ${caseReport.caseId}`,
    ``,
    `Assessment: **${caseReport.assessment}**`,
    ``,
  ];

  lines.push(...renderComparison(caseReport.comparison));
  lines.push('');

  lines.push(...renderNoiseFloor(caseReport.oldNoiseFloor, 'Old'));
  lines.push('');
  lines.push(...renderNoiseFloor(caseReport.newNoiseFloor, 'New'));
  lines.push('');

  for (const [key, run] of Object.entries(caseReport.runs)) {
    const label = key.replace(/([A-Z])/g, ' $1').trim();
    const retrieval = run.run.output.retrieval;
    if (retrieval) {
      lines.push(`  **${label} Retrieval**`, '',
        `  - Expected related files: ${retrieval.expectedFiles?.join(', ') ?? 'not labeled'}`,
        `  - Retrieved: ${retrieval.retrievedFiles.join(', ') || 'none'}`,
        `  - Rendered: ${retrieval.renderedFiles.join(', ') || 'none'}`,
        `  - Related-file recall: ${retrieval.recall === null ? 'N/A' : pct(retrieval.recall)}`,
        `  - File fallback: ${pct(retrieval.fallbackRate)}; behavior calls: ${retrieval.behaviorCalls}; file calls: ${retrieval.fileCalls}; truncated inputs: ${retrieval.truncatedReviewUnits}`, '');
    }
    lines.push(...renderAdjudications(run.adjudications, label));
    lines.push('');
  }

  return lines;
}

export function generateMarkdownReport(report: EvalReport): string {
  const lines: string[] = [
    `# Parakh PR Review Evaluation Report`,
    ``,
    `Generated: ${report.createdAt}`,
    ``,
    `## Configuration`,
    ``,
    `| Setting | Value |`,
    `|---------|-------|`,
    `| Gold Set Version | ${report.goldSetVersion} |`,
    `| Old Pipeline | ${report.oldPipeline.branchRef} (${report.oldPipeline.resolvedSha.slice(0, 12)}) |`,
    `| New Pipeline | ${report.newPipeline.branchRef} (${report.newPipeline.resolvedSha.slice(0, 12)}) |`,
    `| Judge Model | ${report.judgeModel} |`,
    `| Judge Tier | ${report.judgeTier} |`,
    `| Reviewer Model | ${report.config.reviewerModel} |`,
    `| Context Budget | ${report.config.contextBudget} |`,
    `| Judge Context Budget | ${report.config.judgeContextBudget ?? report.config.contextBudget} |`,
    `| Cases | ${report.cases.length} |`,
    ``,
    `## Summary`,
    ``,
    `| Assessment | Count |`,
    `|------------|-------|`,
  ];

  for (const [assessment, count] of Object.entries(report.summary)) {
    lines.push(`| ${assessment} | ${count} |`);
  }

  lines.push('');
  lines.push('## Aggregate Metrics');
  lines.push('');

  if (report.cases.length > 0) {
    const stableCases = report.cases.filter(caseReport => caseReport.assessment !== 'judge_unstable');
    lines.push(`Scored cases: ${stableCases.length}/${report.cases.length}. Judge-unstable cases are excluded from headline aggregate metrics.`);
    lines.push('');
    const aggregate = aggregateMetrics(stableCases);
    lines.push(...renderAggregateMetrics(aggregate));
    lines.push('');
  }

  lines.push(...renderHeldOutSection(report));
  lines.push('');

  lines.push('## Per-Case Reports');
  lines.push('');

  for (const caseReport of report.cases) {
    lines.push(...renderPerCaseReport(caseReport));
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

interface AggregateMetrics {
  oldAvgPrecision: number;
  newAvgPrecision: number;
  oldAvgRecall: number | null;
  newAvgRecall: number | null;
  oldAvgF1: number | null;
  newAvgF1: number | null;
  totalOldFalsePositives: number;
  totalNewFalsePositives: number;
  totalHeldOut: number;
  avgJudgeDisagreement: number;
  totalLatencyMs: number;
}

function aggregateMetrics(cases: EvalCaseReport[]): AggregateMetrics {
  const n = cases.length;
  if (n === 0) {
    return {
      oldAvgPrecision: 0,
      newAvgPrecision: 0,
      oldAvgRecall: null,
      newAvgRecall: null,
      oldAvgF1: null,
      newAvgF1: null,
      totalOldFalsePositives: 0,
      totalNewFalsePositives: 0,
      totalHeldOut: 0,
      avgJudgeDisagreement: 0,
      totalLatencyMs: 0,
    };
  }

  let oldPrecisionSum = 0;
  let newPrecisionSum = 0;
  let oldRecallSum = 0;
  let newRecallSum = 0;
  let oldF1Sum = 0;
  let newF1Sum = 0;
  let oldRecallCount = 0;
  let newRecallCount = 0;
  let oldF1Count = 0;
  let newF1Count = 0;
  let totalOldFP = 0;
  let totalNewFP = 0;
  let totalHeldOut = 0;
  let totalDisagreement = 0;
  let totalLatency = 0;

  for (const c of cases) {
    oldPrecisionSum += c.comparison.oldMetrics.knownPrecision;
    newPrecisionSum += c.comparison.newMetrics.knownPrecision;

    if (c.comparison.oldMetrics.recall !== null) {
      oldRecallSum += c.comparison.oldMetrics.recall;
      oldRecallCount++;
    }
    if (c.comparison.newMetrics.recall !== null) {
      newRecallSum += c.comparison.newMetrics.recall;
      newRecallCount++;
    }
    if (c.comparison.oldMetrics.strictF1 !== null) {
      oldF1Sum += c.comparison.oldMetrics.strictF1;
      oldF1Count++;
    }
    if (c.comparison.newMetrics.strictF1 !== null) {
      newF1Sum += c.comparison.newMetrics.strictF1;
      newF1Count++;
    }

    totalOldFP += c.comparison.oldMetrics.strictFalsePositives;
    totalNewFP += c.comparison.newMetrics.strictFalsePositives;
    totalHeldOut +=
      c.comparison.oldMetrics.heldOutCount +
      c.comparison.newMetrics.heldOutCount;
    totalDisagreement +=
      c.comparison.oldMetrics.judgeDisagreementRate +
      c.comparison.newMetrics.judgeDisagreementRate;
    totalLatency +=
      c.comparison.oldMetrics.latencyMs + c.comparison.newMetrics.latencyMs;
  }

  return {
    oldAvgPrecision: oldPrecisionSum / n,
    newAvgPrecision: newPrecisionSum / n,
    oldAvgRecall: oldRecallCount > 0 ? oldRecallSum / oldRecallCount : null,
    newAvgRecall: newRecallCount > 0 ? newRecallSum / newRecallCount : null,
    oldAvgF1: oldF1Count > 0 ? oldF1Sum / oldF1Count : null,
    newAvgF1: newF1Count > 0 ? newF1Sum / newF1Count : null,
    totalOldFalsePositives: totalOldFP,
    totalNewFalsePositives: totalNewFP,
    totalHeldOut,
    avgJudgeDisagreement: totalDisagreement / (2 * n),
    totalLatencyMs: totalLatency,
  };
}

function renderAggregateMetrics(agg: AggregateMetrics): string[] {
  const lines: string[] = [
    `| Metric | Old | New | Delta |`,
    `|--------|-----|-----|-------|`,
    `| Avg Precision | ${pct(agg.oldAvgPrecision)} | ${pct(agg.newAvgPrecision)} | ${deltaSymbol(agg.newAvgPrecision - agg.oldAvgPrecision)}${pct(Math.abs(agg.newAvgPrecision - agg.oldAvgPrecision))} |`,
  ];

  if (agg.oldAvgRecall !== null && agg.newAvgRecall !== null) {
    const delta = agg.newAvgRecall - agg.oldAvgRecall;
    lines.push(
      `| Avg Recall | ${pct(agg.oldAvgRecall)} | ${pct(agg.newAvgRecall)} | ${deltaSymbol(delta)}${pct(Math.abs(delta))} |`
    );
  }

  if (agg.oldAvgF1 !== null && agg.newAvgF1 !== null) {
    const delta = agg.newAvgF1 - agg.oldAvgF1;
    lines.push(
      `| Avg F1 | ${num(agg.oldAvgF1)} | ${num(agg.newAvgF1)} | ${deltaSymbol(delta)}${num(Math.abs(delta))} |`
    );
  }

  const fpDelta = agg.totalNewFalsePositives - agg.totalOldFalsePositives;
  lines.push(
    `| Total False Positives | ${agg.totalOldFalsePositives} | ${agg.totalNewFalsePositives} | ${fpDelta > 0 ? '+' : ''}${fpDelta} |`
  );
  lines.push(`| Total Held Out | ${agg.totalHeldOut} | | |`);
  lines.push(`| Avg Judge Disagreement | ${pct(agg.avgJudgeDisagreement)} | | |`);
  lines.push(`| Total Latency | ${agg.totalLatencyMs}ms | | |`);

  return lines;
}

export function generateAdjudicationReview(report: EvalReport): string {
  const lines: string[] = [
    `# Adjudication Review`,
    ``,
    `Findings requiring human review across all cases.`,
    ``,
    `Generated: ${report.createdAt}`,
    `Gold Set: ${report.goldSetVersion}`,
    ``,
  ];

  for (const caseReport of report.cases) {
    const heldOut: {
      finding: FindingAdjudication;
      pipeline: string;
      runKey: string;
    }[] = [];

    for (const [key, run] of Object.entries(caseReport.runs)) {
      for (const adj of run.adjudications) {
        if (adj.outcome === 'needs_human_review') {
          heldOut.push({
            finding: adj,
            pipeline: key.startsWith('old') ? 'old' : 'new',
            runKey: key,
          });
        }
      }
    }

    if (heldOut.length === 0) continue;

    lines.push(`## ${caseReport.caseId}`);
    lines.push('');

    for (const item of heldOut) {
      const f = item.finding;
      lines.push(`### ${item.pipeline} — ${item.runKey}`);
      lines.push('');
      lines.push(`- **File:** ${f.finding.file}:${f.finding.line}`);
      lines.push(`- **Severity:** ${f.finding.severity}`);
      lines.push(`- **Body:** ${f.finding.body}`);
      if (f.finding.suggestion) {
        lines.push(`- **Suggestion:** ${f.finding.suggestion}`);
      }
      lines.push(`- **Outcome:** ${f.outcome}`);
      lines.push(`- **Reason:** ${f.reason}`);
      lines.push('');
      lines.push('**Judge verdicts:**');
      for (let i = 0; i < f.verdicts.length; i++) {
        const v = f.verdicts[i];
        lines.push(`  ${i + 1}. exists=${v.defectExists} correct=${v.correctness} matched=${v.matchedDefectId} unsupported=${v.unsupportedClaim}`);
        lines.push(`     reason: ${v.reason}`);
      }
      lines.push('');
      lines.push('**Human resolution:**');
      lines.push('- [ ] correct');
      lines.push('- [ ] partially_correct');
      lines.push('- [ ] incorrect');
      lines.push('- [ ] unsupported');
      lines.push('- [ ] duplicate');
      lines.push('- [ ] valid_unlisted');
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}
