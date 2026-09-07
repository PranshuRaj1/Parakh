import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Finding, Rule } from '@parakh/shared';
import type { ReviewResult } from '../../gemini/client.js';
import type {
  EvalCase,
  EvalPipeline,
  EvalRunConfig,
  PipelineOutput,
  RetrievalDiagnostic,
} from './types.js';
import { buildRepositoryIndex } from '../../indexer/repository-index.js';
import { buildChangeUnderstandingPlan, type ChangeUnderstandingPlan } from '../semantic-diff/plan.js';
import { renderBehaviorGroup, renderGroupContext } from '../grouping/group-renderer.js';
import type { BehaviorGroup } from '../grouping/types.js';
import { parseUnifiedDiff } from '../semantic-diff/unified-parser.js';
import { canonicalAnchor, groupId } from '../grouping/group-id.js';

interface ReviewModule {
  parseDiffByFile(diff: string): Map<string, string>;
  isIgnoredLockfile(file: string): boolean;
  resolveReviewResult(
    result: ReviewResult,
    file: string,
    rules: Rule[],
    suppressPatterns: RegExp[]
  ): { findings: Finding[] };
}

interface GeminiLike {
  reviewDiff(
    file: string,
    diff: string,
    rules: Rule[],
    context?: unknown,
    referenceFileContent?: string
  ): Promise<ReviewResult>;
  reviewBehaviorGroup?(
    behaviorGroup: string,
    rules: Rule[],
    context?: unknown,
  ): Promise<ReviewResult>;
}

interface GeminiModule {
  GeminiClient: new (env: {
    GEMINI_API_KEY?: string;
    GEMINI_API_KEYS?: string;
    GEMINI_GENERATION_MODEL?: string;
  }) => GeminiLike;
}

interface ReviewUnit {
  file: string;
  diff: string;
  kind: 'file' | 'behavior';
  reference?: string;
}

function fileReviewUnits(fileDiffs: Map<string, string>, files = new Set(fileDiffs.keys())): ReviewUnit[] {
  return [...files].sort().flatMap((file) => {
    const diff = fileDiffs.get(file);
    return diff ? [{ file, diff, kind: 'file' as const }] : [];
  });
}

function renderFallbackDiff(
  file: string,
  plan: ChangeUnderstandingPlan,
  patchHashes: ReadonlySet<string>,
): string {
  const semanticFile = plan.files.find((candidate) =>
    (candidate.newPath ?? candidate.oldPath) === file
  );
  if (!semanticFile) return '';
  const oldPath = semanticFile.oldPath ? `a/${semanticFile.oldPath}` : '/dev/null';
  const newPath = semanticFile.newPath ? `b/${semanticFile.newPath}` : '/dev/null';
  const hunks = semanticFile.hunks
    .filter((hunk) => patchHashes.has(hunk.evidence.patchHash))
    .map((hunk) => [hunk.header, ...hunk.lines].join('\n'));
  if (hunks.length === 0) return '';
  return [`diff --git ${oldPath} ${newPath}`, `--- ${oldPath}`, `+++ ${newPath}`, ...hunks].join('\n');
}

function retrievalDiagnostics(input: {
  expectedFiles: string[];
  changedFiles: ReadonlySet<string>;
  sources: Record<string, { oldSource?: string; newSource?: string }>;
  index: ReturnType<typeof buildRepositoryIndex>;
  plan: ChangeUnderstandingPlan;
  reviewUnits: ReviewUnit[];
  maxCharacters: number;
}): RetrievalDiagnostic[] {
  const symbolsById = new Map(input.index.symbols.map((symbol) => [symbol.id, symbol]));
  const edgesByFile = new Map<string, string[]>();
  for (const edge of input.index.edges) {
    const from = symbolsById.get(edge.from);
    const to = symbolsById.get(edge.to);
    if (!from || !to) continue;
    const value = `${from.qualifiedName} -[${edge.type}]-> ${to.qualifiedName}`;
    for (const file of new Set([from.path, to.path])) {
      edgesByFile.set(file, [...(edgesByFile.get(file) ?? []), value]);
    }
  }
  const bridgePaths = new Map<string, string[]>();
  for (const node of input.plan.graph.contextNodes ?? []) {
    bridgePaths.set(node.symbol.path, [...(bridgePaths.get(node.symbol.path) ?? []),
      `${node.symbol.qualifiedName} <- ${node.changeIds.join(', ')}`]);
  }
  return input.expectedFiles.map((file) => ({
    file,
    sourcePresent: Boolean(input.sources[file]?.newSource ?? input.sources[file]?.oldSource),
    changed: input.changedFiles.has(file),
    extractedSymbols: input.index.symbols.filter((symbol) => symbol.path === file)
      .map((symbol) => symbol.qualifiedName).sort(),
    indexedEdges: [...new Set(edgesByFile.get(file) ?? [])].sort(),
    bridgePaths: [...new Set(bridgePaths.get(file) ?? [])].sort(),
    rendered: input.reviewUnits.some((unit) =>
      (unit.diff + '\n' + (unit.reference ?? '')).includes(`CONTEXT_FILE: ${file}`)),
    truncated: input.reviewUnits.some((unit) => unit.diff.length > input.maxCharacters
      && (unit.diff + '\n' + (unit.reference ?? '')).includes(`CONTEXT_FILE: ${file}`)),
  }));
}

const TEST_FILE_PATTERN = /(?:^|[./_-])(?:test|spec)(?:[./_-]|$)/i;

function groupedReviewUnits(input: {
  repository: string;
  plan: ChangeUnderstandingPlan;
  fileDiffs: Map<string, string>;
  sources: Record<string, { oldSource?: string; newSource?: string }>;
  maxCharacters: number;
  contextExclude?: RegExp[];
}): ReviewUnit[] {
  const { repository, plan, fileDiffs, sources, maxCharacters, contextExclude } = input;
  const fallbackPatchHashes = new Set(plan.groups
    .filter((group) => group.demotionReason)
    .flatMap((group) => group.changes.map((change) => change.evidence.patchHash)));
  const hunks = new Map(plan.files.flatMap((file) => file.hunks)
    .map((hunk) => [hunk.evidence.patchHash, hunk]));
  const merged = new Map<string, BehaviorGroup>();
  for (const group of plan.groups) {
    const changes = group.changes.filter(change => !fallbackPatchHashes.has(change.evidence.patchHash));
    if (!changes.length) continue;
    const key = [...new Set(changes.map(change => change.file))].sort().join('\n');
    const previous = merged.get(key);
    merged.set(key, { ...group, changes: [...(previous?.changes ?? []), ...changes],
      riskSignals: [...new Set([...(previous?.riskSignals ?? []), ...group.riskSignals])],
      confidence: previous?.confidence === 'medium' ? 'medium' : group.confidence,
    });
  }
  const behaviorUnits: ReviewUnit[] = [];
  for (const group of merged.values()) {
    let changes: BehaviorGroup['changes'] = [];
    const evidence = new Map<string, BehaviorGroup['changes']>();
    for (const change of group.changes) evidence.set(change.evidence.patchHash, [...(evidence.get(change.evidence.patchHash) ?? []), change]);
    const emit = () => behaviorUnits.push({
      file: changes[0].file,
      diff: renderBehaviorGroup({ group: { ...group, id: groupId(repository, changes), anchor: canonicalAnchor(changes), changes }, graph: plan.graph, hunks, sources, maxCharacters, contextExclude }),
      kind: 'behavior',
    });
    for (const next of evidence.values()) {
      const candidate = { ...group, changes: [...changes, ...next] };
      if (changes.length && renderBehaviorGroup({ group: candidate, graph: plan.graph, hunks, maxCharacters: 0 }).length > maxCharacters) {
        emit();
        changes = [];
      }
      changes.push(...next);
    }
    if (changes.length) emit();
  }
  const fallbackChangesByFile = new Map<string, Set<string>>();
  for (const change of plan.changes) {
    if (!fallbackPatchHashes.has(change.evidence.patchHash)) continue;
    const hashes = fallbackChangesByFile.get(change.file) ?? new Set<string>();
    hashes.add(change.evidence.patchHash);
    fallbackChangesByFile.set(change.file, hashes);
  }
  const fallbackUnits = [...fallbackChangesByFile.keys()].sort().flatMap((file) => {
    const diff = renderFallbackDiff(file, plan, fallbackChangesByFile.get(file)!);
    return diff ? [{ file, diff, kind: 'file' as const }] : [];
  }).map(unit => {
    const changes = plan.changes.filter(change =>
      fallbackChangesByFile.get(unit.file)?.has(change.evidence.patchHash));
    const group: BehaviorGroup = { id: unit.file, anchor: unit.file, changes, context: [], riskSignals: [], confidence: 'low' };
    const context = renderGroupContext({ group, graph: plan.graph, sources, maxCharacters: Math.max(0, maxCharacters - unit.diff.length), contextExclude });
    return { ...unit, reference: context.text ? `${context.text}\n\n${sources[unit.file]?.newSource ?? ''}` : undefined };
  });
  const covered = new Set(plan.changes.map(change => change.file));
  return [...behaviorUnits, ...fallbackUnits, ...fileReviewUnits(fileDiffs, new Set([...fileDiffs.keys()].filter(file => !covered.has(file))))];
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: (error: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(new Error(`Eval review timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createBranchPipelineFromModules(input: {
  review: ReviewModule;
  gemini: GeminiModule;
  apiKey?: string;
  apiKeys?: string;
  strategy?: 'file' | 'grouped';
}): EvalPipeline {
  const clients = new Map<string, GeminiLike>();

  return {
    async review(testCase: EvalCase, config: EvalRunConfig): Promise<PipelineOutput> {
      if (config.tools.length > 0 || config.rulesHash !== 'none') {
        throw new Error('Eval v1 supports only empty tools and rules');
      }
      const rawFindings: Finding[] = [];
      const finalFindings: Finding[] = [];
      let inputCharacters = 0;
      let outputCharacters = 0;
      let providerCalls = 0;
      let planningGroups: number | undefined;
      let planningChanges: number | undefined;
      let planningMoves: number | undefined;
      let planningFallbackGroups: number | undefined;
      let retrieval: PipelineOutput['retrieval'];

      const grouped = input.strategy === 'grouped';
      const fileDiffs = input.review.parseDiffByFile(testCase.diff);
      let reviewUnits: ReviewUnit[];
      if (grouped) {
        const sources = Object.fromEntries([...new Set([...Object.keys(testCase.files), ...Object.keys(testCase.baseFiles ?? {})])]
          .map(file => [file, { newSource: testCase.files[file], oldSource: testCase.baseFiles?.[file] }]));
        for (const file of await parseUnifiedDiff(testCase.diff)) {
          if (file.oldPath && file.newPath && sources[file.newPath]) sources[file.newPath].oldSource = testCase.baseFiles?.[file.oldPath];
        }
        const headIndex = buildRepositoryIndex(testCase.repo, testCase.headSha, testCase.files);
        const baseIndex = buildRepositoryIndex(testCase.repo, testCase.baseSha, testCase.baseFiles ?? {});
        const plan = await buildChangeUnderstandingPlan({
          repository: testCase.repo,
          oldSha: testCase.baseSha,
          newSha: testCase.headSha,
          diff: testCase.diff,
          sources,
          symbols: [...baseIndex.symbols.map(symbol => ({ ...symbol, id: `base:${symbol.id}` })), ...headIndex.symbols],
          edges: [...baseIndex.edges.map(edge => ({ ...edge, from: `base:${edge.from}`, to: `base:${edge.to}` })), ...headIndex.edges],
        });
        planningGroups = plan.groups.length;
        planningChanges = plan.changes.length;
        planningMoves = plan.moves.length;
        planningFallbackGroups = plan.groups.filter((group) => group.demotionReason).length;
        reviewUnits = groupedReviewUnits({ repository: testCase.repo, plan, fileDiffs, sources, maxCharacters: config.contextBudget * 4, contextExclude: [TEST_FILE_PATTERN] });
        const retrievedFiles = [...new Set((plan.graph.contextNodes ?? [])
          .map(node => node.symbol.path).filter(file => !fileDiffs.has(file)))].sort();
        const renderedFiles = [...new Set(reviewUnits.flatMap(unit =>
          [...(unit.diff + '\n' + (unit.reference ?? '')).slice(0, config.contextBudget * 4).matchAll(/^CONTEXT_FILE: (.+)$/gm)].map(match => match[1])))]
          .filter(file => !fileDiffs.has(file)).sort();
        const expectedFiles = testCase.expectedRelatedFiles ?? null;
        const fallbackGroups = plan.groups.filter((group) => group.demotionReason);
        const fallbackReasons = Object.fromEntries([...fallbackGroups.reduce((reasons, group) => {
          const reason = group.demotionReason ?? 'unknown';
          reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          return reasons;
        }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)));
        retrieval = {
          expectedFiles, retrievedFiles, renderedFiles,
          recall: expectedFiles?.length ? expectedFiles.filter(file => renderedFiles.includes(file)).length / expectedFiles.length : null,
          fallbackRate: reviewUnits.length ? reviewUnits.filter(unit => unit.kind === 'file').length / reviewUnits.length : 0,
          behaviorCalls: reviewUnits.filter(unit => unit.kind === 'behavior').length,
          fileCalls: reviewUnits.filter(unit => unit.kind === 'file').length,
          truncatedReviewUnits: reviewUnits.filter(unit => unit.diff.length > config.contextBudget * 4).length,
          groupCount: plan.groups.length,
          fallbackGroups: fallbackGroups.length,
          fallbackChanges: fallbackGroups.reduce((count, group) => count + group.changes.length, 0),
          bridgeEdges: plan.graph.edges.filter((edge) => edge.reason.startsWith('bridge dependency:')).length,
          fallbackReasons,
          diagnostics: expectedFiles ? retrievalDiagnostics({
            expectedFiles,
            changedFiles: new Set(fileDiffs.keys()),
            sources,
            index: headIndex,
            plan,
            reviewUnits,
            maxCharacters: config.contextBudget * 4,
          }) : undefined,
        };
      } else {
        reviewUnits = fileReviewUnits(fileDiffs);
      }

      for (const { file, diff, kind, reference: groupReference } of reviewUnits) {
        if (input.review.isIgnoredLockfile(file)) continue;
        const maxCharacters = config.contextBudget * 4;
        const boundedDiff = diff.slice(0, maxCharacters);
        const reference = kind === 'file' ? (groupReference ?? testCase.files[file])?.slice(
          0,
          Math.max(0, maxCharacters - boundedDiff.length)
        ) : undefined;
        let client = clients.get(config.reviewerModel);
        if (!client) {
          client = new input.gemini.GeminiClient({
            GEMINI_API_KEY: input.apiKey,
            GEMINI_API_KEYS: input.apiKeys,
            GEMINI_GENERATION_MODEL: config.reviewerModel,
          });
          clients.set(config.reviewerModel, client);
        }
        const result = await withTimeout(
          (signal) => kind === 'behavior' && client.reviewBehaviorGroup
            ? client.reviewBehaviorGroup(boundedDiff, [], { signal, timeoutMs: config.timeoutMs })
            : client.reviewDiff(file, boundedDiff, [], { signal, timeoutMs: config.timeoutMs }, reference),
          config.timeoutMs
        );
        providerCalls++;
        inputCharacters += boundedDiff.length + (reference?.length ?? 0);

        const raw = result.genericFindings.map((finding) => ({
          ...finding,
          file: finding.file || file,
          suggestion: finding.suggestion || null,
          rule_id: null,
        }));
        rawFindings.push(...raw);
        finalFindings.push(
          ...input.review.resolveReviewResult(result, file, [], []).findings
        );
        outputCharacters += JSON.stringify(result).length;
      }

      return {
        rawFindings,
        finalFindings,
        inputTokens: Math.ceil(inputCharacters / 4),
        outputTokens: Math.ceil(outputCharacters / 4),
        providerCalls,
        planningGroups,
        planningChanges,
        planningMoves,
        planningFallbackGroups,
        retrieval,
      };
    },
  };
}

export async function loadBranchPipeline(input: {
  worktreePath: string;
  apiKey?: string;
  apiKeys?: string;
  strategy?: 'file' | 'grouped';
}): Promise<EvalPipeline> {
  const moduleUrl = (path: string) =>
    pathToFileURL(join(input.worktreePath, path)).href;
  const [review, gemini, adapter] = await Promise.all([
    import(moduleUrl('worker/src/jobs/review.ts')) as Promise<ReviewModule>,
    import(moduleUrl('worker/src/gemini/client.ts')) as Promise<GeminiModule>,
    import(moduleUrl('worker/src/review/eval/branch-pipeline.test-helper.ts')) as Promise<{
      createBranchPipelineFromModules: typeof createBranchPipelineFromModules;
    }>,
  ]);
  return adapter.createBranchPipelineFromModules({
    review,
    gemini,
    apiKey: input.apiKey,
    apiKeys: input.apiKeys,
    strategy: input.strategy,
  });
}
