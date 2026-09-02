# Semantic diff grouping recovery implementation plan

## Purpose

Repair the current semantic-diff implementation without spending more reviewer or judge quota until the deterministic planner is demonstrably better.

The immediate failure is not model quality. The planner creates almost one group per changed hunk:

| Case | Files | Changes | Groups | Fallback groups | Old calls | Grouped calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Sentry | 6 | 37 | 37 | 37 | 6 | 37 |
| Keycloak | 4 | 7 | 7 | 7 | 4 | 7 |
| Grafana | 11 | 22 | 22 | 20 | 11 | 22 |
| Cal.com planner | 15 | 24 | 20 | 13 | Not measured | Not measured |

The recovery order starts with deterministic file fallback because it reduces Sentry from 37 review calls toward 6 without requiring language parsing or model changes.

## Non-negotiable invariants

Every commit must preserve these rules:

1. Every changed evidence item belongs to exactly one execution group.
2. No changed evidence is dropped or assigned twice.
3. Group formation is deterministic for identical pinned input.
4. Planner failure falls back to the existing file-review path.
5. Shadow planning never schedules grouped LLM reviews or judge calls.
6. A resumed review cannot switch strategies halfway through execution.
7. The raw diff remains available and authoritative.
8. No grouped output is posted until shadow and eval gates pass.

## Commit sequence

### Commit 1: collapse low-confidence changes into file fallbacks

Suggested commit:

```text
fix: collapse low-confidence changes into file fallbacks
```

Files:

```text
worker/src/review/grouping/group-builder.ts
worker/src/review/grouping/grouping.test.ts
worker/src/review/semantic-diff/plan.test.ts
```

Implementation:

1. Build connected components from strong graph edges as today.
2. Calculate the low-confidence ratio for each component.
3. Keep components whose low-confidence ratio is at most 25 percent.
4. Do not emit a component whose low-confidence ratio exceeds 25 percent.
5. Add every change from a demoted component to a fallback bucket keyed by normalized file path.
6. Sort fallback changes by changed line and stable change ID.
7. Emit one fallback group per file.
8. Reuse the existing `MAX_SYMBOLS = 40` limit. A file with more than 40 fallback changes is split into deterministic chunks of 40.
9. Give every fallback group a `demotionReason` so reports can count it.
10. Verify complete and unique assignment before returning the groups.

The assignment check compares input change IDs with all output change IDs and reports missing or duplicate IDs explicitly.

Regression tests:

- Three low-confidence hunks in one file produce one fallback group.
- Low-confidence hunks in two files produce two fallback groups.
- A demoted cross-file component becomes one fallback group per represented file.
- A healthy high-confidence component remains unchanged.
- More than 40 fallback changes split into stable chunks of 40.
- Reordering input changes does not change group IDs or membership.
- A small Python diff with three hunks produces one fallback group.
- Every test asserts exact-once evidence assignment.

Offline acceptance:

| Case | Required result after Commit 1 |
| --- | --- |
| Sentry | At most 6 fallback groups for 6 files |
| Keycloak | At most 4 fallback groups for 4 files |
| Grafana | No one-fallback-group-per-hunk behavior |
| Cal.com | Fewer fallback groups, with every hunk assigned once |

No API eval runs are allowed before these checks pass.

### Commit 2: join all changes mapped to the same symbol

Suggested commit:

```text
fix: preserve all changed hunks for indexed symbols
```

Files:

```text
worker/src/review/grouping/graph.ts
worker/src/review/grouping/grouping.test.ts
```

Implementation:

1. Replace the current one-to-one symbol map with `Map<string, string[]>`.
2. Add strong intra-symbol edges between all changes mapped to one symbol.
3. Preserve import and call edges for every matching change, not only the last change inserted into the map.
4. Sort change IDs before creating edges so output stays deterministic.

Regression tests:

- Three hunks in one function form one component.
- Multiple methods connected by a call edge preserve all member hunks.
- Unrelated symbols remain separate.
- Duplicate graph edges are removed deterministically.

How this helps:

Cal.com currently maps several changes to `BookingListItem`, but the map retains only one change ID. This commit keeps those hunks together before broader cross-file grouping is attempted.

### Commit 3: add language-aware symbol adapters

Suggested commit:

```text
feat: index changed symbols across benchmark languages
```

Files:

```text
worker/src/indexer/parser.ts
worker/src/indexer/repository-index.ts
worker/src/indexer/*.test.ts
worker/src/review/semantic-diff/entity-parser.ts
worker/src/review/semantic-diff/entity-parser.test.ts
```

Implementation:

1. Introduce one parser-adapter entry point selected by file extension.
2. Keep the existing TypeScript and JavaScript parser behind that interface.
3. Add bounded symbol extraction for Python, Go, Java, and Lua.
4. Extract only functions, methods, classes, interfaces, and types needed for grouping.
5. Return low confidence instead of guessing when a boundary is ambiguous.
6. Prefer the smallest enclosing changed symbol when ranges overlap.
7. Keep hunk-level fallback for unsupported files and parser failures.

Confidence contract for every new adapter:

- `high`: an exact declaration boundary and changed-line containment are both verified.
- `medium`: the declaration is identified but one boundary is approximate or overlapping.
- `low`: no declaration can be identified reliably, or the parser rejects the construct.

Before an adapter merges, run it against representative corpus fixtures and report its high, medium, and low-confidence distribution. The existing 25 percent low-confidence demotion threshold remains fixed during Commit 3. An adapter is not considered supported if ordinary valid files exceed that threshold broadly; those files continue through deterministic file fallback until the adapter improves. Do not tune the threshold independently per language to make grouping metrics look better.

Do not add a native parser dependency until Cloudflare Worker bundle size and CPU compatibility are verified. A stronger parser can replace an adapter later without changing downstream contracts.

Regression fixtures must cover the actual language patterns seen in Sentry, Grafana, and Keycloak.

### Commit 4: strengthen graph construction

Suggested commit:

```text
feat: connect behavior groups with corroborated code relationships
```

Files:

```text
worker/src/indexer/edges.ts
worker/src/review/grouping/graph.ts
worker/src/review/grouping/grouping.test.ts
```

Strong relationships:

- Same changed symbol
- Direct import or export
- Direct call
- Exact move or rename
- Test directly referencing a changed symbol

Weak relationships:

- Same file
- Matching changed identifier
- Implementation and test path pairing
- Shared route, configuration, or schema key

Rules:

1. Strong relationships can form components directly.
2. A weak relationship can merge candidates only when another independent signal agrees.
3. Same-file edges remain useful for fallback construction but cannot create a giant behavior group by themselves.
4. Move and token metadata must either contribute a defined graph signal or be removed from execution until they do.

### Commit 5: expand old, new, and unchanged repository context

Suggested commit:

```text
feat: load bounded dependency context for semantic planning
```

This commit addresses the diagnosed limitation that the index currently contains only changed head files.

Implementation:

1. Load old source for changed files from the pinned base SHA.
2. Load new source for changed files from the pinned head SHA.
3. Resolve direct imports and referenced symbols into unchanged files.
4. Include directly related tests and callers when they are already available through existing repository-context facilities.
5. Bound expansion by depth, files, symbols, bytes, and subrequests.
6. Cache resolved source in the existing Upstash Redis state store by repository, SHA, and path. Do not introduce a second cache backend.
7. Treat unchanged files as context only. They never become primary changed evidence.
8. Record truncation and unresolved-dependency metrics.

Subrequest rules:

1. Use the existing review-wide `SubrequestBudget`; context loading does not create a separate counter that can exceed the Worker's 44-subrequest guard.
2. Persist `contextSubrequestsUsed` in review checkpoint state so queue redelivery cannot restart the context allowance.
3. Allow at most 8 additional context-loading subrequests across the complete review execution, not per group.
4. Stop context expansion when either the 8-subrequest ceiling is reached or the shared budget cannot preserve `FINALIZE_BUDGET_RESERVE`.
5. Count Redis reads, Redis writes, GitHub source fetches, and retries against the context ceiling and shared budget.
6. Batch candidate cache reads and cache writes through Upstash Redis so one file does not automatically consume separate read and write requests.
7. Reuse source already present in the pinned review input without spending context budget.
8. Record whether expansion stopped because of file, byte, symbol, depth, or subrequest limits.

Initial limits:

```text
dependency depth: 1
unchanged context files: 20
symbols per group candidate: 40
edges per group candidate: 80
context subrequests per review execution: 8
```

The Redis cache uses one versioned namespace, a bounded default TTL of 24 hours, and batched reads and writes. Pinned SHA content is immutable, but the TTL bounds storage growth. Tests use mocked Redis and repository fetches and verify that limits are deterministic. They must prove that several groups share one review-wide allowance, redelivery resumes the persisted count, cache misses cannot exceed the ceiling, and finalization reserve is preserved. No live GitHub or Redis requests are used in tests.

How this helps:

- Deleted hunks can map against old symbols.
- Calls into unchanged functions can resolve.
- Tests and callers outside the changed-file set can contribute context.
- Cross-file behavior chains are no longer limited to files already present in the PR snapshot.

### Commit 6: render complete bounded group context

Suggested commit:

```text
feat: render grounded multi-file review units
```

Files:

```text
worker/src/review/grouping/group-renderer.ts
worker/src/review/grouping/group-renderer.test.ts
worker/src/review/eval/branch-pipeline.test-helper.ts
```

Each review unit includes:

- Group ID and deterministic reason for membership
- Every primary changed hunk
- Bounded old and new source around each hunk
- Relevant symbol signatures
- Strong graph relationships
- Risk signals
- Explicit separation between changed evidence and unchanged context

Remove the current behavior where a multi-file group receives full source for only its first file.

The renderer must enforce the same context budget for file and grouped strategies. Oversized groups are split before rendering, not truncated in a way that silently drops changed evidence.

### Commit 7a: wire shadow planning into the production review job

Suggested commit:

```text
feat: run semantic grouping in production shadow mode
```

This is a wiring change, not only a configuration change.

Implementation in `worker/src/jobs/review.ts`:

1. After fetching and pinning the full diff, invoke `buildChangeUnderstandingPlan` when semantic diff or grouping shadow is enabled.
2. Run only deterministic planning in shadow mode.
3. Record plan metrics, confidence, fallback reasons, coverage, group counts, and estimated review calls.
4. Keep the existing file-review scheduler and posted output unchanged.
5. Catch planner failures, record the reason, and continue with file review.
6. Persist planner version and strategy in checkpoint compatibility metadata.

Safe shadow configuration:

```toml
SEMANTIC_DIFF_ENABLED = "true"
BEHAVIOR_GROUPING_ENABLED = "false"
BEHAVIOR_GROUPING_SHADOW = "true"
GROUPED_REVIEW_OUTPUT_ENABLED = "false"
```

In this state:

- The planner runs.
- Group metrics are stored.
- No grouped reviewer calls are scheduled.
- No additional judge calls are made.
- GitHub output stays file-based.

Add configuration validation that fails closed when execution and shadow are both requested. If both `BEHAVIOR_GROUPING_ENABLED` and `BEHAVIOR_GROUPING_SHADOW` are true, execution is disabled and a safe warning is emitted.

Tests must prove that shadow mode invokes the planner but schedules only file review units.

### Commit 7b: enable grouped execution after shadow gates pass

Suggested commit:

```text
feat: schedule grouped review units behind execution flag
```

This commit is blocked until the shadow rollout gates pass.

Execution configuration:

```toml
SEMANTIC_DIFF_ENABLED = "true"
BEHAVIOR_GROUPING_ENABLED = "true"
BEHAVIOR_GROUPING_SHADOW = "false"
GROUPED_REVIEW_OUTPUT_ENABLED = "false"
```

Implementation:

1. Refactor file review into a strategy-neutral review-unit function.
2. Schedule file fallback groups and behavior groups through the same bounded executor.
3. Count real provider attempts against the existing subrequest budget.
4. Checkpoint completed group IDs and accumulated findings.
5. Fall back to file review before any grouped model call if planning is incomplete or invalid.
6. Keep anchored findings and overview output compatible with the current schema.

Grouped presentation remains disabled. Group execution and grouped GitHub formatting are separate rollout decisions.

### Commit 8: make eval strategy explicit and cache-safe

Suggested commit:

```text
fix: version eval strategy and planner cache identity
```

Implementation:

1. Add `--old-strategy file|grouped` and `--new-strategy file|grouped`.
2. Remove hardcoded strategy selection from the eval CLI.
3. Add strategy, planner version, parser version, and graph version to the review cache key.
4. Include those values in JSON and Markdown reports.
5. Assert that both runs use the same pinned PR snapshot, reviewer model, context budget, and judge configuration.
6. Allow same-commit strategy comparisons without stale cache reuse.

Tests verify that file and grouped results never share a cache entry.

### Commit 9: normalize judge outcomes and resume quota-limited runs

Suggested commit:

```text
fix: normalize judge disagreement and quota recovery
```

Implementation:

1. Normalize each judge pass into the six adjudication outcomes before testing disagreement.
2. When both passes say `defectExists=false` and `correctness=0`, a difference only in `unsupportedClaim` resolves to `incorrect`.
3. Preserve human review for disagreements that can change correctness, defect matching, duplication, or partial credit.
4. Parse provider retry timing from 429 responses.
5. Persist each completed verdict immediately.
6. Exit with a resumable message when the wait exceeds a configured limit.
7. Re-running the same command resumes from reviewer and judge caches.

Named regression test:

```text
Sentry outdated-comment finding:
pass A: defect does not exist, correctness 0, unsupported false
pass B: defect does not exist, correctness 0, unsupported true
expected outcome: incorrect
expected human review: false
```

This test remains independent of the aggregate judge-disagreement threshold.

## Flag state machine

| Rollout state | Semantic diff | Group execution | Shadow planning | Grouped output |
| --- | --- | --- | --- | --- |
| Disabled | false | false | false | false |
| Shadow | true | false | true | false |
| Group execution | true | true | false | false |
| Group presentation | true | true | false | true |

Invalid combinations must fail closed. In particular, shadow planning and group execution are not enabled simultaneously.

## Verification gates

### Gate A: deterministic planner

- Exact replay produces identical group IDs and membership.
- Every change is assigned exactly once.
- Sentry produces at most one fallback group per changed file.
- Keycloak produces at most one fallback group per changed file.
- No parser failure produces one model call per hunk.
- No API calls are required.

### Gate B: shadow production wiring

- Planner runs on pinned production input.
- Existing file review output is byte-for-byte compatible.
- No grouped reviewer or judge calls occur.
- Planner failures do not fail the review job.
- Checkpoint resume uses the same strategy and planner version.

Collect at least 30 eligible shadow plans before enabling grouped execution.

### Gate C: offline eval readiness

- Group count is no higher than the old file-review call count on unsupported-language cases.
- Changed evidence survives rendered context without truncation.
- Multi-file groups contain source context for every primary file.
- Eval cache identity includes strategy and planner versions.

### Gate D: online quality evaluation

Run Grafana, Keycloak, Sentry, and Cal.com sequentially after reviewer and judge quota reset.

Required signals:

- No aggregate recall regression outside measured reviewer noise.
- No increase in false positives.
- Provider calls are no higher than file review.
- Latency increase stays below 25 percent.
- Judge disagreement stays below 20 percent.
- At least one verified cross-file defect is found that file review misses.
- Human adjudication confirms that `valid_unlisted` findings are useful defects, not style observations.

Only after these four cases pass should the full 15-case corpus run.

## Commit discipline

For every commit:

1. Add the regression test first and observe it fail.
2. Make the smallest implementation change that passes it.
3. Run focused tests and type checking.
4. Run the offline real-corpus planner check when grouping changes.
5. Inspect the staged diff for unrelated files and secrets.
6. Commit only after verification succeeds.

Do not include `worker/wrangler.toml` in an implementation commit until Commit 7a. Do not enable grouped execution in configuration until Commit 7b and its shadow gates are complete.

## Expected progression

| Milestone | Expected improvement |
| --- | --- |
| Commit 1 | Sentry calls fall from 37 toward 6; Keycloak from 7 toward 4 |
| Commit 2 | Multiple hunks in one symbol remain together |
| Commit 3 | Python, Go, Java, and Lua changes gain symbol identity |
| Commit 4 | Related changed symbols form behavior components |
| Commit 5 | Old code and unchanged dependencies become available as bounded context |
| Commit 6 | Multi-file prompts preserve complete grounded evidence |
| Commit 7a | Real PR plans are measured safely with no user-visible behavior change |
| Commit 7b | Grouped review execution becomes available behind an explicit flag |
| Commit 8 | Eval comparisons become strategy-explicit and cache-safe |
| Commit 9 | Judge disagreements and free-tier quota interruptions become resumable and correctly classified |

## First implementation checkpoint

Implement only Commit 1, verify it against synthetic tests and the four corpus cases, and review the resulting group manifests before starting Commit 2. The first checkpoint is complete only when the one-hunk-per-group failure is gone without losing or duplicating evidence.
