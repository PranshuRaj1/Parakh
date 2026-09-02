# Pull Request Review Evaluation Plan

## Goal

Measure whether a new Parakh review pipeline produces more useful findings than
the current pipeline on the same pull requests. The primary question is:

> Does the reviewer identify more real, important problems while making fewer
> incorrect or distracting claims?

Do not use the displayed review score, raw finding count, or text similarity as
the primary metric. Those can improve while review quality gets worse.

## Recommended evaluation stack

Use three layers, in this order:

1. Deterministic regression tests for pipeline behavior.
2. Finding-level benchmark evaluation against adjudicated defects.
3. A calibrated LLM judge for explanation quality and pairwise preference.

The first layer catches accidental changes. The second measures correctness.
The third measures qualities that are difficult to label with exact matching.

## Dataset design

Build a fixed, versioned benchmark of PR snapshots. Every case must contain the
base commit, head commit, complete repository context needed by the reviewer,
tests or static-analysis evidence where available, and a case category.

Use a mixture of:

- Real PRs with accepted human review comments.
- Real PRs with post-merge bugs, reverted changes, or follow-up fixes.
- Expert-seeded defects created by applying small, realistic mutations to a
  correct PR. Keep the mutation and expected behavior private to the review
  prompt, but available to the evaluator.
- Negative controls: correct code, intentional style choices, and suspicious
  looking code that is correct after reading callers or configuration.
- Cross-file cases where the defect is not visible in the changed hunk.
- Multi-round cases where a defect is fixed, remains open, or is reintroduced.

Stratify results by severity, defect type, language, file count, diff size,
cross-file dependency, and whether full-file context was required. Split by
repository or project, not randomly by comment, to avoid leaking conventions
and near-duplicate code between evaluation sets.

The repository already has deterministic baseline fixtures in
`worker/src/review/baseline` and durable finding identities in the review
ledger. Extend those concepts for semantic cases rather than replacing them.

## Gold annotation format

Represent each expected issue as an atomic defect record:

```json
{
  "defect_id": "auth-017",
  "files": ["src/api.ts"],
  "line_range": [41, 47],
  "type": "authorization",
  "severity": "HIGH",
  "claim": "A non-owner can reach the delete endpoint without an authorization check.",
  "evidence": "deleteProject is called after authentication but before ownership validation.",
  "fix_condition": "The reviewer must identify the missing ownership check and point to the affected path."
}
```

A case may have multiple valid explanations and fixes. The gold record should
describe the defect and acceptance condition, not prescribe one exact sentence.
Have at least two expert annotators label each defect and adjudicate conflicts.
Record agreement and unresolved ambiguity. Do not call an LLM-generated label
gold until a human has verified it.

## Finding-level metrics

Match a generated finding to a gold defect using structured adjudication. A
finding can be fully correct, partially correct, incorrect, duplicate, or
unverifiable.

Report these as the headline metrics:

- Defect recall: gold defects found at least once.
- Finding precision: findings that identify a real issue and meet the
  acceptance condition.
- Defect-level F1: harmonic mean of precision and recall.
- Severity-weighted recall: weight CRITICAL, HIGH, MEDIUM, and LOW according to
  product policy. Publish the weights instead of hiding them.
- False-positive rate on negative controls.
- Localization accuracy: whether file and line or symbol are close enough to
  act on.
- Actionability rate: whether the comment gives a technically valid next step.
- Duplicate rate: multiple findings for one defect or repeated findings across
  review rounds.
- Unsupported-claim rate: claims contradicted by the repository or supplied
  evidence.

Use exact matching only for stable fields such as defect IDs, file paths, and
severity classes. Do not require lexical overlap between comments. CRScore
shows why reference-text metrics can underrate a valid review that discusses a
different but real aspect of the same change, and reports better correlation
with human scores for semantic evaluation ([CRScore paper](https://aclanthology.org/2025.naacl-long.457/)).

## LLM-as-a-judge protocol

Use the judge as an adjudicator of a finding, not as the only source of truth.
Give it the PR task, relevant code context, one candidate finding, and the
atomic defect records when they exist. Ask for JSON with:

- `correctness`: 0 to 2
- `relevance`: 0 to 2
- `localization`: 0 to 2
- `actionability`: 0 to 2
- `severity_calibration`: 0 to 2
- `unsupported_claim`: boolean
- `matched_defect_id`: nullable
- `evidence_quote`: short quote or code location from the supplied context
- `reason`: concise explanation

Require the judge to first decide whether the alleged defect exists, then score
the comment. This prevents polished prose from compensating for a false claim.
Make the judge cite supplied evidence and treat missing evidence as uncertainty,
not proof of correctness.

For each candidate comparison:

1. Randomize candidate order.
2. Run the comparison again with the order swapped.
3. Use a blind candidate label such as A and B.
4. Run multiple judge samples at a low temperature or use multiple judge
   models when the decision is important.
5. Mark disagreements as `needs_human_review` instead of forcing a winner.

These controls directly address the position, knowledge, and format biases
described by JudgeLM. Its swap augmentation, optional reference support, and
reference dropping are useful patterns for our judge prompts, but its reported
agreement with GPT-4 is not evidence that the judge is correct for code review
([JudgeLM](https://arxiv.org/html/2310.17631v2)).

Keep the generator and judge roles separate. If a model produced a review, do
not use the same model and prompt as the sole evaluator of that review.
Calibrate the judge on a held-out set of human-labeled examples and periodically
measure judge-human agreement.

## Comparing two review versions

For every benchmark case, run the old and new reviewer on the identical commit,
context budget, rules, and tool availability. Store a run manifest containing:

- reviewer version, model, provider, prompt version, and feature flags;
- case ID, base SHA, head SHA, and context mode;
- raw findings before filtering and final findings after filtering;
- latency, estimated tokens, provider calls, and failures;
- finding adjudications and judge outputs;
- whether a human overrode the adjudication.

Compare paired outcomes per PR. Report the delta in recall, precision, F1,
severity-weighted recall, false-positive rate, and cost. Use bootstrap confidence
intervals over PRs, not individual comments. For a binary paired outcome such as
“found the defect,” use a paired test such as McNemar's test when its assumptions
are suitable. Do not call a change better unless the confidence interval for the
important metric excludes a practically irrelevant difference.

Prefer a Pareto view over one opaque score. A candidate should normally improve
defect-level F1 and not materially worsen false positives or cost. If a single
number is required, publish the formula, for example:

```text
utility = 4 * critical_recall
        + 3 * high_recall
        + 2 * medium_recall
        + 1 * low_recall
        - 4 * false_positive_rate
        - 2 * unsupported_claim_rate
        - 1 * duplicate_rate
```

Treat the weights as product policy, not a scientific truth.

## Product outcome metrics

After offline evaluation is stable, add a small online experiment. Sample PRs
and randomize whether authors see the old or new reviewer, while keeping the
reviewer hidden from the evaluator where possible. Measure:

- author acceptance or dismissal of individual findings;
- replies indicating a finding was wrong or useful;
- whether the author changes code in the suggested area;
- time to resolve review findings;
- post-merge defects related to the reviewed change;
- review latency and cost.

These are outcome signals, not standalone truth. Authors may ignore a correct
finding, and accepted comments may reflect politeness or project culture.

## Smallest implementation path

### Phase 1: offline harness

Add a test-only runner that loads frozen PR cases, invokes the review pipeline
with mocked provider leaves, normalizes findings, and emits JSONL. Reuse the
existing baseline replay harness for deterministic cases.

### Phase 2: gold adjudication

Add a benchmark manifest and finding matcher. Start with 25 to 50 cases and
roughly 100 atomic defects, balanced with negative controls. Manually label
every generated finding in the first version. This gives a trustworthy seed
set before automating judgment.

### Phase 3: judge-assisted labeling

Use the structured judge for correctness, localization, actionability, and
duplicate detection. Sample all disagreements and a random slice of agreements
for human review. Track judge precision and recall against that audit slice.

### Phase 4: regression gate

Run the benchmark for every review-pipeline change. Fail or warn on regressions
in high-severity recall, precision, false-positive rate, and unsupported claims.
Keep the benchmark cases and gold labels versioned separately from production
review data.

## Important limitations

Human review comments are noisy and incomplete. A comment not present in GitHub
does not prove that a defect was absent. Synthetic mutations can overfit to the
mutation operator. LLM judges can be persuasive while being wrong, so the
highest-severity and disagreement cases need expert adjudication.

Recent repository-level benchmarks reinforce the need for cross-file context
and expert-verified defects ([AACR-Bench](https://github.com/alibaba/aacr-bench)).
Recent multi-round work also shows that static, one-shot evaluation misses
defect lifecycle behavior ([MCR-Bench](https://arxiv.org/abs/2608.27442)).
The older CodeReviewer benchmark remains useful for dataset scale and review
generation baselines, but its task framing is narrower than Parakh's full PR
workflow ([CodeReviewer](https://arxiv.org/abs/2203.09095)).
