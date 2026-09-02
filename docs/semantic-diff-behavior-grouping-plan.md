# Semantic diff plus behavior grouping implementation plan

## Decision

Implement both features as one change-understanding pipeline. Semantic diff is
the deterministic evidence layer. Behavior grouping is the deterministic graph
layer. The model should summarize intent and review grounded groups, but it
should not invent file membership, coordinates, or evidence links.

This matches the strongest common idea in CodeRabbit and Greptile's public
material: flat file review is a poor representation of system behavior; useful
context comes from structure, dependencies, intent, and verification. It also
matches research showing that repository-level tasks require dependency-aware
context and that review quality depends on localization, change recognition,
and solution reasoning rather than one undifferentiated generation score.

Sources:

- [CodeRabbit semantic diff](https://www.coderabbit.ai/blog/introducing-semantic-diff)
- [CodeRabbit explainable review workflow](https://www.coderabbit.ai/blog/coderabbit-review-reads-a-pr-how-author-would-explain-it)
- [CodeRabbit context engineering](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews)
- [Greptile graph-based codebase context](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context)
- [Greptile code validation](https://www.greptile.com/blog/automating-code-validation)
- [CodeReviewQA](https://aclanthology.org/2025.findings-acl.476/)
- [Repository-level context study](https://aclanthology.org/2025.findings-naacl.82/)
- [CodeAgent](https://aclanthology.org/2024.emnlp-main.632/)
- [Aiding Code Change Understanding](https://www.cs.ubc.ca/~rtholmes/papers/icsme_2019_hanam.pdf)

Vendor posts are useful product evidence, not independent proof. The plan
therefore keeps grouping deterministic, preserves exact code evidence, and
requires replay and human-quality evaluation before changing posted output.

## Current repository constraints

- `worker/src/jobs/review.ts` currently parses a PR into per-file chunks and
  checkpoints `completedFiles`.
- `worker/src/indexer/parser.ts` and `worker/src/indexer/edges.ts` already have
  a TypeScript symbol and edge foundation, but the parser is regex-based and
  the index is not yet the review unit.
- `worker/src/review/blast-radius.ts` already computes reverse callers and test
  signals that can become grouping edges.
- `worker/src/review/incremental/changes.ts` handles basic rename and change
  metadata, but semantic identity must be stronger than file paths.
- `worker/src/config/feature-flags.ts` already reserves
  `semanticDiff`, `behaviorGrouping`, `behaviorGroupingShadow`, and
  `groupedReviewOutput`; these flags currently have no meaningful runtime
  implementation.
- The Worker has a strict subrequest budget, so repository indexing must be
  bounded, cached or produced from already fetched review inputs.

## Target architecture

```text
FETCH INPUT
  pinned base/head + complete file contents + unified diff
        |
NORMALIZE DIFF
  robust files/hunks/coordinates + old/new entities + move/rename matches
        |
BUILD CHANGE GRAPH
  changed symbols/hunks as nodes + typed dependency edges
        |
FORM BEHAVIOR GROUPS
  deterministic components, stable IDs, bounded splitting, file fallback
        |
OPTIONAL INTENT PASS
  one compact model call per group or batch of groups
        |
REVIEW GROUPS
  group evidence + bounded dependency context + raw changed hunks
        |
VALIDATE AND DEDUPE
  exact coordinates, evidence ownership, canonical finding IDs
        |
CURRENT FINALIZATION
  score once, overview once, anchored findings once
```

The raw diff remains available in every group. Semantic data supplements the
diff and never replaces it. A failure at any new stage falls back to the
current file-based review.

## Data model

Add shared types in `shared/src/types.ts` or a focused review types module:

```ts
interface EvidenceRef {
  file: string;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  symbol?: string;
  patchHash: string;
  kind: 'edit' | 'add' | 'delete' | 'move' | 'context';
}

interface SemanticChange {
  id: string;
  file: string;
  operation: 'add' | 'delete' | 'edit' | 'move' | 'rename';
  oldSymbol?: string;
  newSymbol?: string;
  evidence: EvidenceRef[];
  tokenChanges: Array<{ kind: 'added' | 'removed' | 'changed'; value: string }>;
  confidence: 'high' | 'medium' | 'low';
}

interface BehaviorGroup {
  id: string;
  title: string;
  primaryChanges: SemanticChange[];
  context: EvidenceRef[];
  files: string[];
  symbols: string[];
  riskSignals: string[];
  confidence: 'high' | 'medium' | 'low';
}
```

The group ID must not be a hash of the complete member set. Otherwise an
unrelated file joining a component changes the ID and breaks incremental
continuity. Use a versioned stable anchor:

```text
group_id = g2:<hash(repository + canonical anchor identity)>
```

The canonical anchor is the first changed symbol after sorting by semantic
identity, with the lowest changed hunk as a tie-breaker. Semantic identity is
the old/new symbol pair when a rename is detected, otherwise the qualified
symbol path and name. It must not include the current base SHA or mutable body
hash. A pure file/hunk fallback uses the normalized path and the first stable
hunk fingerprint.

Membership changes do not change the anchor ID. When a component splits or two
components merge, write an explicit lineage record containing parent group IDs,
child group IDs, and evidence overlap. Finding carry-forward uses evidence and
the lineage record, not group ID equality alone. Include pipeline, parser, and
graph versions in the review compatibility hash, not in the stable identity.

Group IDs are only unique within a review. Every execution-local Redis key,
metric row, and cache entry must use `(reviewId, groupId)` or an equivalent
review-scoped key. Never key execution-local persistence or aggregation by
`groupId` alone; two concurrent PRs can legitimately share the same anchor
identity.

`reviewId` identifies one pinned review execution, including its redeliveries.
A new push to the same PR creates a new `reviewId`; it does not mutate the old
execution. Incremental continuity crosses that boundary through
`parentReviewId` and a PR-scoped lineage lookup keyed by `(repository,
prNumber, parentReviewId, childReviewId)`. The lookup imports only validated
groups and findings from the parent execution, then writes the child execution
under its own `(reviewId, groupId)` keys. This keeps concurrent PRs isolated
while allowing continuity across pushes.

## Phase 0: safety and baseline

1. Keep both new flags off and preserve the current file review as the control.
2. Add a `changeUnderstandingVersion` to the review compatibility metadata.
3. Capture metrics for group count, fallback rate, assigned evidence, parser
   confidence, token reduction, model calls, latency, and findings per group.
4. Extend replay fixtures with expected normalized evidence and expected group
   membership. Existing fixtures must remain byte-for-byte compatible when the
   flags are off.
5. Add a feature snapshot to checkpoint state so a resumed review cannot mix
   file mode and group mode.

## Phase 1: robust semantic diff

Create `worker/src/review/semantic-diff/` with small pure modules:

- `unified-parser.ts`: parse quoted paths, additions, deletions, renames,
  binary files, hunks, no-newline markers, and old/new coordinates.
- `entity-parser.ts`: map changed lines to symbols. Start with TypeScript and
  JavaScript using the existing indexer, but return a confidence and reason for
  every mapping. A low-confidence symbol mapping falls back to its hunk; it
  does not contaminate downstream groups with a guessed boundary.
- `move-detector.ts`: match normalized blocks using rolling hashes, then exact
  verification. Require a minimum block size and destination-scope checks to
  avoid matching repeated braces, imports, or common statements.
- `token-delta.ts`: produce token-level additions, removals, and replacements
  for paired changed lines. Keep the complete hunk beside this metadata.
- `semantic-diff.ts`: return sorted, immutable `SemanticChange` records.

Important rules:

- Never call an unchanged text move safe automatically. Scope, decorators,
  initialization order, registration calls, and relative side effects remain
  visible.
- Never use language parsing failure as permission to drop a change.
- Never infer behavior from token similarity alone.
- Sort by normalized path and coordinates for deterministic replay.
- Treat regex parsing as a provisional adapter, not semantic identity. Before
  enabling group execution, either improve its coverage with explicit tests for
  generics, decorators, overloads, re-exports, nested declarations, and JSX, or
  add a stronger parser adapter for supported languages. Unsupported or
   ambiguous symbols must remain hunk-level evidence.

Tests should cover additions, deletions, pure renames, edited renames, moved
blocks, repeated code, nested functions, comments, strings, binary files,
quoted paths, CRLF, no-newline markers, and malformed diffs.

## Phase 2: deterministic change graph

Create `worker/src/review/grouping/graph.ts` and build on the existing indexer.
The graph should use changed symbols or changed hunks as nodes and these edge
types:

Strong edges:

- import or export relationship
- local call relationship
- inheritance or interface implementation
- route, configuration, schema, or migration key usage
- direct test coverage
- exact move or rename identity
- reverse caller relationship from `blast-radius.ts`

Weak edges:

- same directory
- shared naming
- same commit or PR area
- nearby changed ranges

Only strong edges should join groups by themselves. Weak edges can raise a
candidate score but must not connect unrelated files without another signal.
This prevents a large directory or broad PR from becoming one giant group.

Build the graph only from already fetched diff content and any complete file
contents already fetched for review. The first version makes no additional
GitHub or database requests for graph construction. Traverse reverse callers
to depth 2, with at most 40 symbols and 80 edges per candidate group; sort and
truncate deterministically. If the limits are exceeded, emit a bounded-context
warning and retain the group rather than silently dropping evidence. A cached
repository-wide index can be a later optimization, not a dependency of this
feature.

Reuse and improve `worker/src/indexer/parser.ts` and `edges.ts`, but do not
pretend the current regex parser is complete. Use a parser adapter interface so
TypeScript can improve first and unsupported languages cleanly fall back to
hunks. Do not add a heavy parser dependency until bundle size and Worker CPU
benchmarks pass.

## Phase 3: group formation and bounded execution

1. Create candidate connected components from strong edges.
2. Add high-confidence weak edges only when they agree with a strong signal.
3. Split groups above fixed file, symbol, token, and evidence limits.
4. Use stable graph partitioning, such as sorted seeded expansion, so the same
   input always produces the same groups.
5. Put unassigned evidence into deterministic file-based fallback groups.
6. Attach unchanged dependencies as context, never as primary changed evidence.
7. Mark every group with risk signals such as changed exported API, auth,
   route, schema, config, migration, callback, or missing direct tests.
8. If more than 25% of a group's primary changes are low-confidence hunk
   fallbacks, demote that group to file-based fallback groups for execution.
   Keep the semantic candidate and demotion reason in shadow data. This rule
   applies per group, not to the whole PR. Medium-confidence groups remain
   semantic groups but run the medium-confidence validation contract below.

The first version should not ask an LLM to decide membership. That makes the
checkpoint non-reproducible and can silently hide changed evidence.

### Medium-confidence validation contract

Before judge adjudication, every finding from a medium-confidence group must
pass a deterministic validation pass:

1. It must reference at least one primary changed evidence item, not only
   unchanged context.
2. Every referenced item must match the checkpointed `patchHash`, file, and
   old/new coordinate range.
3. The finding's anchor line must be inside the changed hunk for that file.
   The check always uses new-file coordinates. For a deletion-only hunk with
   no new coordinates, the finding may use the old range internally but cannot
   be posted as a new-file anchor until the existing GitHub anchor fallback
   resolves a valid changed line.
4. A claim involving more than one file must include at least two valid
   primary evidence references from distinct files. Otherwise quarantine it.
5. Any failed check quarantines the finding before judge execution. The group
   itself remains reviewable and its other findings continue.

High or critical findings from a medium-confidence group are not automatically
demoted. They receive the same severity treatment as other findings only after
this validation pass succeeds. Quarantined findings are recorded in telemetry
and never affect scoring or GitHub output.

## Phase 4: connect to the current review loop

Add a planner before `remainingFiles` is calculated in
`worker/src/jobs/review.ts`:

- If `semanticDiff` is off, keep the current path unchanged.
- If `semanticDiff` is on and grouping is off, use semantic changes only to
  improve each file prompt and preserve file scheduling.
- If both are on, schedule `BehaviorGroup` objects instead of files.
- If planning fails, record the reason and use file fallback for the entire
  review.

Refactor `reviewSingleFile` into a review-unit function whose input can be a
file fallback group or a behavior group. It should still receive:

- raw changed hunks
- semantic changes and exact evidence
- bounded context symbols and relevant tests
- active rules and repository conventions
- prior findings for all files represented in the group

The provider interface should gain a group-review method only if the existing
prompt shape cannot cleanly carry this context. Prefer one shared review-unit
request shape over separate provider-specific methods.

Keep the model output compatible with the existing finding schema initially.
Add optional `evidence` and `groupId` fields internally, validate them, then
convert findings to current GitHub anchors. A finding without valid changed
evidence must be dropped or marked for internal diagnostics, never posted.

## Phase 5: intent and prompt design

Use a two-step prompt strategy:

1. Deterministic group manifest: changed files, symbols, evidence, dependency
   edges, tests, risk signals, and PR metadata.
2. Review request: test whether the stated intent is supported, then check
   correctness, completeness, security, compatibility, and edge cases.

Use one intent call per batch of up to 4 groups, only after deterministic
planning succeeds. Also cap each batch at 32 symbols, 64 edges, and 24,000
manifest characters, approximately 6,000 input tokens. Pack groups in stable
ID order and start a new batch before any cap is exceeded. A single group that
exceeds the cap receives a compact manifest containing only its primary
evidence, strongest edges, and risk signals; detailed context stays in the
review call. Each group gets a strict delimiter and a bounded manifest; the
response must contain one result keyed by the supplied group ID. Validate that
every returned ID exists and that every group has a result. If the batch is
malformed, retry once per failed group only. If that retry fails, use a
deterministic title for that group and continue. This keeps a 15-group PR near
four initial calls without allowing large groups to exceed the manifest budget.

Intent is a hypothesis, not proof. If the intent call fails, derive a simple
deterministic title from symbols and paths. The detailed review must continue.

Ask the model to cite the supplied evidence references. Do not let it cite
unchanged context as if it were changed code. Keep repository conventions and
learned rules, but scope them to the relevant files and group.

## Phase 6: checkpoint and finalization

Evolve the Redis state from file-based state to a versioned state containing:

- input hashes and pinned SHAs
- normalized semantic changes
- behavior groups
- completed group IDs
- group summaries
- group lineage records for split and merge events
- accumulated findings
- fallback groups and parser warnings

At the PR level, maintain a latest-review pointer keyed by `(repository,
prNumber)`. At review start, read that pointer to resolve `parentReviewId` for
the new child execution. Update it only after the child plan and findings are
durably committed. If the pointer is missing or points to an incomplete or
incompatible review, start without a parent. Concurrent starts use the review
lock and compare-and-set semantics so an older child cannot overwrite a newer
latest-review pointer.

The pointer value is `{ reviewId, headSha, pipelineVersion, completedAt }`.
The pointer is updated only by the finalization transaction after the review
has a durable plan and validated findings. Phase 3 must implement this as a
small PR-level record or equivalent compare-and-set key. It is not part of the
group ID and it is not used as a global group lookup.

A redelivery must never regroup an already planned review. Group completion
must be idempotent. Finalization must verify that every primary change belongs
to a completed group or explicit fallback group before scoring and posting.

## Patch hash integrity

The diff is fetched once at review start using the pinned base and head SHAs.
The canonical full-diff hash and each evidence hunk's `patchHash` are stored
in checkpoint state. Resume never refetches or silently reconstructs the diff;
it verifies the stored full-diff hash before using the plan. Before posting,
the validator recomputes every referenced hunk hash from the checkpointed diff
and blocks any finding whose hash, coordinates, or file content no longer
matches. If a future implementation must refetch input, it must create a new
review plan and invalidate the old groups rather than reusing stale evidence.

For incremental reviews, preserve group identity where the canonical anchor and
evidence lineage remain stable. When a group changes, re-review the group and
reconcile its findings. Carry a prior finding only when its canonical finding
identity still points to valid evidence in the new group. A group merge or
split creates a lineage mapping and forces evidence-based revalidation; it
does not blindly copy findings.

## Judge and adjudication policy

The existing judge remains a finding-level verifier. Grouping changes the
review unit, not the truth unit. Every finding is first resolved, suppressed,
severity-checked, and grounded against its exact evidence. Then the existing
judge or adjudication path evaluates each finding independently.

The eight universal finding checks in the finalization section apply to every
finding. Medium-confidence groups receive an additional pre-judge tier: the
validator must enforce the primary-evidence, coordinate, patch-hash, and
cross-file reference requirements listed in the medium-confidence contract.
This is stricter validation, not a severity downgrade. A failed extra check
quarantines only that finding.

If findings from one group disagree, do not average or let the group majority
win. Preserve the current severity and human-review safeguards. A group may
produce a group summary, but a summary cannot create, merge, or upgrade a
finding. Cross-file findings must carry multiple evidence references and are
posted only after all referenced changed files have passed validation. If one
reference is invalid, quarantine the finding rather than posting a partially
grounded comment.

This keeps `groupedReviewOutput` a presentation change. It must not alter
finding scoring, judge semantics, suppression behavior, or anchored-comment
idempotency.

## Feature flags

Use the existing flags with explicit dependency rules:

- `SEMANTIC_DIFF_ENABLED`: normalized evidence and semantic metadata.
- `BEHAVIOR_GROUPING_SHADOW`: build groups, store comparisons, keep file review.
- `BEHAVIOR_GROUPING_ENABLED`: schedule group reviews after shadow gates pass.
- `GROUPED_REVIEW_OUTPUT_ENABLED`: render groups in the overview only after
  group execution is proven. Keep anchored findings compatible with GitHub.

Add one flag only if needed:

- `BEHAVIOR_GROUPING_INTENT_ENABLED`: enable the extra model intent pass after
  deterministic grouping is already stable.

Do not create separate flags for every internal heuristic. Version those
algorithms in compatibility metadata instead. Too many independent switches
will create unsafe combinations that are difficult to replay.

## Rollout gates

Shadow mode must compare old and new behavior on the same pinned inputs:

- 100% of changed evidence assigned to a group or explicit fallback
- zero invalid evidence references
- zero missing changed hunks in group prompts
- stable group IDs across exact replays
- no increase in review failure or checkpoint retry rate
- meaningful reduction in duplicated input tokens on move-heavy PRs
- no statistically meaningful drop in high-confidence defect recall
- human reviewers prefer or match file review for navigation and correctness
- acceptable subrequest cost and latency at small, medium, and large PR sizes

Start with at least 30 eligible shadow comparisons, matching the repository's
existing incremental rollout discipline, then inspect difficult cases manually.
Do not enable grouped posted output based only on token reduction.

## Evaluation plan

Build a benchmark from existing fixtures plus manually labeled real PRs:

- move-heavy refactors
- cross-file API changes
- route, schema, config, and migration changes
- callback and event wiring
- tests changed with implementation
- unrelated multi-feature PRs
- generated code and lockfiles
- unsupported languages and parser failures

Measure separately:

- semantic diff precision and recall for move, rename, and token changes
- evidence coordinate validity
- group purity and group completeness against human labels
- cross-file defect recall
- finding precision, severity calibration, and dismissal rate
- duplicate finding rate
- token and subrequest cost
- latency, retries, and checkpoint recovery
- exact replay variance

Use the existing baseline and evaluation harness under
`worker/src/review/baseline/` and `worker/src/review/eval/`. Do not use only
LLM-as-judge scores. Include human labels and outcome-based signals where
possible. CodeReviewQA's separation of change recognition, localization, and
solution identification is a useful model for keeping these measurements
distinct.

## Recommended first implementation slice

The safest first PR should include only:

1. `semantic-diff` pure types and robust parser.
2. TypeScript symbol mapping using the existing indexer.
3. Move detection and token metadata.
4. Deterministic graph edges from imports, calls, exports, tests, routes, and
   config references.
5. Stable group formation with file fallback.
6. Shadow persistence and metrics.
7. Replay tests and no-flag regression tests.

The second PR should wire shadow groups into prompts. The third should enable
group execution behind `BEHAVIOR_GROUPING_ENABLED`. Intent extraction and
grouped GitHub rendering should come after the evidence and scheduling gates.

## Main risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Incorrect parser drops evidence | Hunk fallback and coverage invariant |
| False move matches | Rolling hash plus exact verification and scope checks |
| Giant groups exceed Worker limits | Stable size limits and deterministic splitting |
| LLM invents group membership | Model receives precomputed groups only |
| Unchanged context becomes a finding anchor | Separate primary evidence from context |
| Group retry duplicates findings | Stable group IDs and canonical finding IDs |
| More context increases cost | Bounded dependency expansion and metrics |
| Existing reviews regress | Full file fallback and flag-off replay parity |
| Model trusts PR description too much | Treat intent as hypothesis and require evidence |

## Bottom line

Build semantic diff first inside the same feature branch, but make it useful
only as the evidence substrate for behavior grouping. The quality leap comes
from the combination: semantic diff removes textual noise, while grouping lets
the reviewer reason over one behavior across files. Keep both deterministic at
the planning layer, use the model for grounded reasoning, and roll out through
shadow comparisons before changing production comments.
