# Grouping Strategy Research

Date: 2026-09-06

## Executive finding

The current grouped strategy is active but not yet effective. The latest 15-case comparison shows:

| Metric | Old file strategy | New grouped strategy |
| --- | ---: | ---: |
| Average F1 | 22.4% | 20.8% |
| Average precision | 33.3% | 26.7% |
| Average defect recall | 16.0% | 15.3% |
| Average input tokens | 30,200 | 37,153 |
| Grouped review units | | 26.1% |
| File fallback units | | 73.9% |
| Judge-unstable cases | | 2 of 15 |

The strongest conclusion is not that graph-based grouping is a bad idea. It is that the current graph and fallback policy are too weak and too conservative to make grouping useful. This is an inference from the local eval report and the implementation, supported by the research below.

## What the current implementation does

The relevant path is:

1. Parse changed hunks into semantic changes.
2. Build base and head repository indexes.
3. Build a change graph from changed symbols and indexed edges.
4. Build connected components from strong changed-to-changed edges.
5. Demote a component when more than 25% of its changes have low confidence.
6. Split remaining components into groups of up to 40 symbols.
7. Render unchanged dependency symbols as context for a group.
8. Review behavior groups with Gemini and use file review for demoted changes.

The important design mismatch is that unchanged dependency symbols are stored in `contextNodes`, but they are not graph nodes that can connect two changed symbols. A path such as:

```text
changed controller -> unchanged service -> changed repository
```

cannot currently join the controller and repository into one behavior group. The dependency is included as text only after grouping has already happened.

The second mismatch is component splitting. When a component exceeds the symbol limit, changes are split by sorted identifier order. That can separate closely related symbols and combine less-related symbols simply because their names sort next to each other.

The third mismatch is fallback behavior. One component with enough low-confidence changes can be demoted into file review, even when other changes in that component have strong symbol and dependency evidence.

## Research findings

### 1. Impact analysis should traverse dependencies, not only changed nodes

[Change impact analysis research](https://doi.org/10.1016/j.infsof.2009.04.018) models the effects of a change through dependency relationships, including effects that appear in unchanged code. The direct implication is to traverse forward and reverse dependencies from changed symbols and retain the path evidence.

For this repository, changed symbols should connect through unchanged bridge symbols when the path uses strong relations such as calls, imports, exports, type references, route registration, schema usage, test coverage, or shared configuration keys.

### 2. Dataflow is more useful than imports or text similarity alone

[DraCo](https://aclanthology.org/2024.acl-long.431/) constructs a repository-specific context graph using extended dataflow analysis. Its authors report that import relations and text similarity alone are insufficient for relevant cross-file context.

The practical lesson is to add edges for values and contracts that cross files: return types, parameter types, object properties, route handlers, schemas, configuration keys, and test targets. These edges are more valuable for code review than generic name similarity because they represent how behavior actually flows.

### 3. Keep lexical retrieval as the first stage

[RepoCoder](https://aclanthology.org/2023.emnlp-main.151/) uses iterative retrieval and generation and reports gains over both in-file and basic retrieval baselines. [Sourcegraph's BM25F engineering writeup](https://sourcegraph.com/blog/keeping-it-boring-and-relevant-with-bm25f) describes a production approach that ranks files lexically and then ranks relevant lines or chunks within those files.

The recommendation is not to replace the current deterministic graph with embeddings. Use a staged hybrid ranker:

```text
exact symbol and signature matches
-> lexical candidate retrieval
-> graph proximity and edge-type scoring
-> optional semantic reranking
-> token-budget selection
```

This keeps identifier and API matches precise while allowing semantic similarity to help with natural-language claims.

### 4. Retrieval needs multiple paths and a necessary-context distinction

[CodeRAG](https://aclanthology.org/2025.emnlp-main.1187/) identifies inappropriate query construction, single-path retrieval, and retriever-model misalignment as repository-level problems. Its proposed framework uses query construction, multi-path retrieval, and reranking to select relevant and necessary knowledge.

For this project, context should be divided into three classes:

1. Required context: direct definitions, implementations, types, schemas, route registration, and configuration that a changed symbol depends on.
2. Supporting context: tests, callers, adapters, and nearby modules that explain behavior.
3. Optional context: weakly related files or broad repository neighbors.

When the budget is reached, remove optional siblings first. Do not truncate a required dependency chain while retaining unrelated context.

### 5. Graph-local expansion is better than a flat repository dump

[RepoGraph](https://arxiv.org/abs/2410.14684) retrieves k-hop ego-graphs around code symbols and uses the graph for repository navigation. Its analysis reports that graph context improves repository-level software engineering systems and that contextual misalignment remains a major failure mode.

The implementation implication is to retrieve a small, labeled neighborhood around each changed anchor rather than flattening all available neighbors. Preserve edge type, direction, hop distance, and the changed symbol that caused the context to be selected.

### 6. Separate localization from review quality in evaluation

[CodeReviewQA](https://aclanthology.org/2025.findings-acl.476/) separates change-type recognition, change localization, and solution identification. [DependEval](https://aclanthology.org/2025.findings-acl.373/) evaluates dependency recognition, repository construction, and multi-file editing separately.

The current F1 score cannot tell whether a failure came from:

- Incorrect grouping
- Missing dependency context
- Poor review reasoning
- Judge disagreement

The eval needs group-level and retrieval-level metrics in addition to final finding F1.

### 7. Use syntax-aware and standardized symbol data where possible

[Tree-sitter](https://tree-sitter.github.io/) provides concrete syntax trees, named nodes, fields, source ranges, and robust parsing in the presence of syntax errors. [SCIP](https://github.com/scip-code/scip/blob/main/docs/scip.md) defines symbols, occurrences, definitions, and relationships for code intelligence indexes.

The current heuristic parser and edge builder should be improved incrementally. For supported languages, syntax-aware extraction should provide the symbol and relationship facts. For unsupported languages, retain the existing file fallback rather than inventing weak graph edges.

## Diagnosis of the current result

### The 73.9% fallback rate is a routing problem

The fallback rate is calculated as:

```text
file review units / all review units
```

It is not retrieval recall. A high value means the grouped planner is not trusted to review most changes as behavior groups.

The main likely causes are:

- Weak graph connectivity because unchanged bridge symbols do not participate in components.
- Low-confidence changes causing an entire component to be demoted.
- Heuristic symbol and edge extraction producing disconnected or incorrect graphs.
- Sorted chunk splitting breaking otherwise coherent components.

### The current dashboard recall is not retrieval recall

The `Recall` column is defect recall from judge adjudication. It is calculated from matched gold defect IDs. The grouped pipeline's retrieval recall is null for the latest corpus because `expectedRelatedFiles` is not populated for those cases.

Therefore, the current dashboard cannot answer whether retrieval found the correct related files. That metric must be added to the corpus and reported separately.

### The token increase means grouping is adding overhead without enough reuse

The grouped strategy averages 37,153 input tokens versus 30,200 for the file strategy. This suggests grouped prompts are adding behavior and dependency context while 73.9% of units still use file fallback. The intended efficiency benefit is being cancelled by duplicated or low-value context.

## Recommended implementation order

### Phase 0: Make the measurement trustworthy

Before changing grouping behavior:

- Add `expectedRelatedFiles` to a representative set of gold cases.
- Add expected related symbols or behavior members where possible.
- Report retrieval recall separately from defect recall.
- Record each group's changes, edge evidence, demotion reason, selected context, and token count.
- Break judge-unstable and unsupported verdicts out of the grouping experiment score.

### Phase 1: Add unchanged bridge traversal

This is the highest-value first experiment because it addresses the current graph's structural gap without adding an embedding dependency or extra Gemini calls.

Build a bounded two-hop or three-hop impact view:

```text
changed A -> unchanged bridge -> changed B
```

Keep only changed symbols as group members. Use unchanged symbols as connecting evidence. Restrict bridge traversal to strong, typed relations and cap the number of bridge paths per pair.

Measure:

- Group recall
- Group precision
- File fallback rate
- Behavior-to-file review ratio
- Input tokens
- Defect recall and F1

### Phase 2: Replace connected components with weighted grouping

Use a weighted score for candidate joins. A possible starting point is:

```text
direct call or implementation edge: 5
bridge path through one unchanged symbol: 4
import or export edge: 3
type or schema edge: 3
route or configuration edge: 3
same changed file: 2
shared identifier stem: 1
```

Require either one strong direct relation or multiple independent signals. Do not join nodes on a shared basename alone.

### Phase 3: Split groups by graph locality

When a group exceeds limits:

1. Select the highest-risk or highest-degree changed anchor.
2. Expand through the strongest edges until the character or symbol limit is reached.
3. Start the next group from the highest-ranked unassigned change.
4. Preserve graph paths inside each group.

This avoids splitting solely by sorted IDs.

### Phase 4: Demote only ambiguous changes

Replace whole-component demotion with local demotion. Strongly connected high-confidence changes remain grouped. Only low-confidence changes, or small neighborhoods that lack enough evidence, go to file fallback.

This should reduce fallback without forcing unreliable changes into a behavior group.

### Phase 5: Add hybrid lexical and semantic reranking

Only after deterministic graph improvements have a clean measurement loop:

- Use exact symbol, signature, route, schema, and config-key matches for candidates.
- Add BM25-style lexical scores over symbol and line-level chunks.
- Add embeddings only for candidates that lexical and graph signals cannot rank confidently.
- Rerank by graph distance, edge type, number of changed anchors reached, and context necessity.

This follows the multi-stage pattern described by [Sourcegraph BM25F](https://sourcegraph.com/blog/keeping-it-boring-and-relevant-with-bm25f) and the multi-path and reranking approach in [CodeRAG](https://aclanthology.org/2025.emnlp-main.1187/).

## Best experiment design

Run the same 15 cases and same Gemini model through three planners while keeping the judge identical:

```text
A: current direct changed-node graph
B: current graph plus unchanged bridge traversal
C: weighted bridge graph plus graph-local splitting and local demotion
```

Do not compare only final F1. The acceptance bar for a grouping planner should be:

- Retrieval/group recall improves or stays level.
- Group precision does not fall.
- File fallback falls materially from 73.9%.
- Input tokens fall rather than rise.
- New defect recall and F1 are no worse than the file baseline.
- Judge-unstable cases are reported separately.

The first implementation should be Phase 1, unchanged bridge traversal. It is the smallest change that directly attacks the current failure mode and is the easiest to validate against the existing graph and index structures.

## Sources

- [Change impact analysis](https://doi.org/10.1016/j.infsof.2009.04.018)
- [DraCo: Dataflow-Guided Retrieval Augmentation for Repository-Level Code Completion](https://aclanthology.org/2024.acl-long.431/)
- [RepoCoder: Repository-Level Code Completion Through Iterative Retrieval and Generation](https://aclanthology.org/2023.emnlp-main.151/)
- [CodeRAG: Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion](https://aclanthology.org/2025.emnlp-main.1187/)
- [RepoGraph: Enhancing AI Software Engineering with Repository-level Code Graph](https://arxiv.org/abs/2410.14684)
- [CodeReviewQA: The Code Review Comprehension Assessment for Large Language Models](https://aclanthology.org/2025.findings-acl.476/)
- [DependEval: Benchmarking LLMs for Repository Dependency Understanding](https://aclanthology.org/2025.findings-acl.373/)
- [Tree-sitter documentation](https://tree-sitter.github.io/)
- [SCIP reference](https://github.com/scip-code/scip/blob/main/docs/scip.md)
- [Sourcegraph: Keeping it boring and relevant with BM25F](https://sourcegraph.com/blog/keeping-it-boring-and-relevant-with-bm25f)
- [Sourcegraph: Rethinking search results ranking](https://sourcegraph.com/blog/new-search-ranking)
