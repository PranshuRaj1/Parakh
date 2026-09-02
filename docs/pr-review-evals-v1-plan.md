# Parakh PR Review Evals v1

## Objective

Answer one narrow question:

> On the exact same PR, does the new Parakh pipeline find more real defects
> with no unacceptable increase in false positives compared with the old
> pipeline?

This first version is a diagnostic benchmark. It is not large enough to prove
general superiority.

## Phase 0: Establish the noise floor

Before comparing old and new, run the same pipeline twice through the identical
runner and judge:

~~~text
old pipeline run A vs old pipeline run B
~~~

Use the same case snapshots and configuration, but allow normal model
nondeterminism. Measure reviewer output disagreement, judge disagreement, and
metric deltas. This gives the practical noise floor for interpreting the real
old-versus-new comparison.

Repeat the same control with the new pipeline:

~~~text
new pipeline run A vs new pipeline run B
~~~

Report old-pipeline variance and new-pipeline variance separately. A new
pipeline that is materially noisier is itself a finding, even if its average
accuracy improves.

If the old-versus-new delta is smaller than or comparable to the relevant
old-versus-old or new-versus-new delta, report the result as inconclusive and
inspect the affected cases.

## Scope decisions

- Do not build mutation testing yet.
- Do not evaluate arbitrary review prose with text similarity.
- Do not use Parakh's displayed score as the quality metric.
- Do not change the production review path in v1.
- Use the existing baseline replay harness as the execution foundation.
- Compare only runs that use the same PR snapshot, context budget, tools, rules,
  provider settings, and timeouts.

## Phase 1: Build the case set

Start with 15 to 20 cases:

- PRs from Parakh or other owned repositories where a real bug was fixed later.
- PRs with actionable human review comments that were clearly acted upon.
- Two to five clean PRs as negative controls.
- A chunk of the Martian golden_comments cases filtered to bug, security,
  concurrency, data, and API categories.
- A mix of CRITICAL, HIGH, MEDIUM, and LOW issues where available.

Prefer defects with concrete evidence: a later fix commit, a test added to
cover the issue, a revert, a security correction, or an explicit author reply
such as “fixed”. Treat comments that were merely tolerated or followed by an
unrelated change as candidates, not gold labels.

Pin every case to a base SHA and head SHA. The benchmark must review the code
as it existed before the fix. Keep the later fix commit and supporting evidence
in the evaluator metadata, not in the reviewer prompt.

## Phase 2: Store cases and gold defects

Add test-only database tables or a checked-in fixture representation equivalent
to:

```sql
create table eval_cases (
  id text primary key,
  repo text not null,
  base_sha text not null,
  head_sha text not null,
  language text not null,
  is_negative_control boolean not null default false,
  created_at timestamptz not null default now()
);

create table eval_defects (
  id text primary key,
  case_id text not null references eval_cases(id),
  claim text not null,
  evidence text not null,
  files text[] not null,
  severity text not null check (severity in ('CRITICAL','HIGH','MEDIUM','LOW')),
  fix_condition text not null
);
```

For each case, write the gold defects manually. A gold defect describes the
underlying problem and acceptance condition, not the exact wording of the
human comment. This allows multiple valid review comments to match one defect.

Because this is initially a solo process, re-review the labels after a delay of
several days. Record any changed labels before freezing the first benchmark
version. Give the gold set an explicit immutable version such as gold-v1.
Every run manifest must record the gold-set version used for scoring.

## Phase 3: Run old and new pipelines

Extend `worker/src/review/baseline` with an eval runner. It should produce one
run record per case and pipeline version:

```text
case_id
pipeline_version
reviewer_model
prompt_version
feature_flags
raw_findings
final_findings
latency_ms
token_count
provider_calls
failure_status
`gold_set_version`
```

Store both raw and final findings. Raw findings show whether a change came from
the model or from filtering, suppression, verification, deduplication, or
formatting.

The runner must fail if the old and new runs do not use the same case snapshot
or evaluation configuration. Run both versions against the same mocked GitHub
and provider inputs wherever possible. Use real provider calls only in an
explicitly marked evaluation mode.

## Phase 4: Adjudicate findings

Every finding receives exactly one primary outcome:

- `correct`: identifies a gold defect and satisfies its acceptance condition.
- `partially_correct`: points toward a real defect but misses an important part.
- `incorrect`: the claimed problem does not exist or is materially wrong.
- `unsupported`: the claim cannot be verified from the supplied context.
- `duplicate`: repeats another finding for the same defect.
- `valid_unlisted`: a real, useful finding not represented in the current gold
  list.

valid_unlisted must not silently improve the benchmark. Log it separately and
promote it into the next gold-set revision only after manual review.

For v1, report two precision values:

- known_precision: correct findings divided by all findings that are not
  duplicates or valid_unlisted.
- expanded_precision: precision after manually promoting valid_unlisted
  findings into the next gold-set version and rerunning the metrics.

Use known_precision for the strict v1 F1 and success-criteria comparison.
Report expanded precision and expanded F1 as secondary metrics after the gold
set is revised. This prevents a thin gold list from unfairly penalizing the new
system while also preventing unknown findings from being ignored forever.

Only fully correct findings count in the known_precision numerator. Exclude
partially_correct findings from the numerator and report partial_rate
separately. This keeps strict v1 F1 easy to interpret.

## Phase 5: Add the LLM judge carefully

Use a judge from a different model family than the reviewer when possible. If
Parakh generates with Gemini, use a Claude or GPT-class judge. The judge is an
adjudication assistant, not the source of truth.

For each finding, provide only:

- the relevant code and diff context;
- the candidate finding;
- the case's gold defects;
- the output schema and decision rules.

The prompt must enforce this order:

```text
First decide whether the claimed issue exists in the supplied code.
Only if it exists, decide whether it matches a listed gold defect.
Then score correctness, localization, and actionability.
If the supplied context is insufficient, mark the finding unsupported.
```

The judge returns:

```text
defect_exists
matched_defect_id
correctness: 0 | 1 | 2
localization: 0 | 1 | 2
actionability: 0 | 1 | 2
unsupported_claim
evidence_quote
actionability_reason
```

Use this deterministic bridge from judge output to adjudication outcome:

- correctness 2, defect_exists true, and matched_defect_id set: correct.
- correctness 1 and defect_exists true: partially_correct.
- correctness 0 and defect_exists false: incorrect.
- unsupported_claim true, or insufficient supplied context: unsupported.
- A repeated match for an already matched defect: duplicate.
- defect_exists true with no matched_defect_id: valid_unlisted.

If fields conflict, use unsupported or needs_human_review and do not infer a
more favorable category. Keep this mapping versioned with the judge prompt.

Run the judge twice per finding with the same context and low temperature. If
the verdicts disagree on existence, matched defect, or correctness, send the
finding to manual adjudication. Never hide disagreement by averaging it.

Keep judge prompts, model versions, and raw judge responses versioned with the
eval run so results remain reproducible. Cache verdicts by:

~~~text
(finding_hash, gold_set_version, judge_prompt_version, judge_model)
~~~

The cache must include the full verdict and should be used by metric reruns so
aggregation never triggers another judge request for unchanged input.

Track judge disagreement as a first-class metric:

~~~text
judge_disagreement_rate =
  findings with conflicting judge verdicts / findings judged twice
~~~

If this exceeds 15 to 20 percent, pause metric interpretation and revise the
judge prompt or gold defect descriptions. A high disagreement rate indicates
an underspecified protocol, not merely inconvenient noise.

Findings marked needs_human_review are held out of all Phase 6 metrics until a
human resolves them. The aggregate report must include the held-out count and
rate so a broken judge protocol cannot hide behind silent exclusions.

## Phase 6: Compute metrics

Compute metrics per case first, then aggregate across cases.

### Defect metrics

- Recall: distinct gold defects matched by at least one correct finding divided
  by all gold defects. Deduplicate by matched_defect_id before counting.
- Precision: correct findings divided by adjudicated findings, with the
  `known_precision` and `expanded_precision` definitions above.
- F1: harmonic mean of precision and recall.
- Severity-weighted recall: apply published weights such as CRITICAL 4, HIGH 3,
  MEDIUM 2, and LOW 1.

### Noise metrics

- Negative-control false-positive rate: percentage of clean PRs with at least
  one non-duplicate finding.
- Unsupported-claim rate.
- Duplicate rate.
- Partially-correct finding rate.
- Held-out needs_human_review count and rate.

For negative controls, “any finding at all” is a useful strict metric. Also
report a relaxed version that excludes findings manually classified as valid
unlisted, since clean PRs can still contain real defects that were missed by the
initial gold review.

### Operational metrics

- Latency per PR.
- Estimated input and output tokens.
- Provider calls.
- Failure and timeout rate.
- Findings after filtering versus findings before filtering.
- Reviewer output disagreement in the noise-floor run.
- Judge disagreement rate.

## Phase 7: Compare versions as paired cases

For every case, create a comparison row:

```text
case_id
old_recall
new_recall
old_precision
new_precision
old_f1
new_f1
old_false_positives
new_false_positives
old_latency_ms
new_latency_ms
```

Report the per-case deltas before reporting averages. With 15 to 20 cases,
confidence intervals will be wide, so use this phase mainly for diagnosis.

Run the noise-floor comparison before this phase. Include both the old-versus-old
and old-versus-new metric deltas in the report.

Immediately investigate these concrete regressions:

- The new pipeline misses a defect found by the old pipeline.
- The new pipeline adds a finding to a negative control.
- The new pipeline converts a correct finding into an unsupported or incorrect
  finding.
- The new pipeline increases severity without stronger evidence.

Once the case count grows, add bootstrap confidence intervals over PRs. For
binary paired outcomes, consider McNemar's test. Do not treat a small average
delta as proof of improvement.

## Success criteria for v1

The new pipeline is promising if it:

- improves or preserves strict defect-level F1 built from known_precision;
- does not regress HIGH and CRITICAL recall;
- does not materially increase negative-control false positives;
- does not materially increase unsupported claims;
- keeps judge disagreement below the review threshold, or explains why the
  affected cases need manual adjudication;
- has an explainable tradeoff when latency or cost increases.

There is no single pass number for the first 15 to 20 cases. The first goal is
to discover concrete wins and regressions, validate the judge protocol, and
identify missing gold defects.

## Deliverables

1. Versioned eval case fixtures.
2. Gold defect records.
3. Old/new paired runner built on baseline replay.
4. Structured adjudication records.
5. Per-case and aggregate JSONL metrics.
6. A small report showing every old/new disagreement.
7. A revised gold set containing promoted `valid_unlisted` findings.
8. A noise-floor report from the old-versus-old control run.
9. A cached judge-verdict store.

## Build order

Implement in this order:

1. Schema and fixtures, including the adjudication mapping as a deterministic
   conversion function.
2. Runner with a hard snapshot and configuration equality assertion.
3. Judge caller with caching enabled from the first run.
4. Old-versus-old and new-versus-new noise-floor runs.
5. Metrics and old-versus-new comparison.

Do not interpret the old-versus-new results until both noise-floor controls
complete.

## Later extensions

Only after this loop is trusted should we add mutation testing, larger external
datasets, cross-file benchmark cases, multi-round review evaluation, online
author feedback, or a learned judge.
