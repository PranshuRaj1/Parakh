# Parakh Architecture: How the Review Pipeline Got Here

> A plain-English story of the review pipeline: what we tried first, how it
> broke, how we found out why, and the changes we made — in the order we made
> them — so a future reader knows *why* the code looks the way it does.

---

## The product in one sentence

Parakh is a GitHub bot. When you open a PR (or mention `@parakh` in a
comment), it sends your diff through a configurable LLM provider chain
(Gemini is the default), turns the model output into "findings," scores the PR
out of 5, and posts the result as a GitHub review with 👍 / 👎 reactions.

The whole thing runs on **Cloudflare Workers** — which, for our purposes,
means three hard constraints that shape every design decision below:

1. **50 subrequests per invocation, hard cap.** A Worker can only make 50
   outgoing HTTP calls (`fetch`) before Cloudflare kills it. Every Gemini
   call, every database query (Neon), every Redis call (Upstash), every
   GitHub API call counts against this.
2. **Queue retries with a delivery limit.** Work is enqueued on a Cloudflare
   Queue. If the handler throws, the message is retried — but only a limited
   number of times before it's given up on.
3. **Cron is the only "background thread."** A Worker can't run forever; a
   cron job every minute is our watchdog for anything that gets stuck.

This doc is mostly the story of learning constraint #1 the hard way.

---

## Iteration 1 — The simple pipeline ("it works for small PRs")

The first version was straightforward:

```
webhook (PR opened) → insert a `reviews` row → enqueue REVIEW job
REVIEW job → fetch diff → load rules → for each file:
                     call Gemini → collect findings → score → post comment + reaction
```

For a PR with one or two files, this worked. Which is why nobody suspected
anything for a while.

**How it failed:** Any PR with more than a handful of files would just...
die. Not with a useful error — the review row would sit there, the dashboard
showed "REVIEWING_FILES / Stage timed out," and nothing ever got posted.

---

## Iteration 2 — Observable failure: stage tracking + the dashboard

Before we could fix anything, we had to *see* where reviews were dying. So we
built observability first:

- A `review_step_events` table — an append-only log of every pipeline stage
  (`FETCHING_DIFF`, `LOADING_RULES`, `REVIEWING_FILES`, `SCORING`,
  `POSTING_COMMENT`, `REACTING`), with per-stage start/end timestamps,
  duration, and an outcome (`COMPLETED` / `FAILED` / `TIMED_OUT`).
- A `stage_reason_code` + `stage_reason_detail` live pointer on the `reviews`
  row, updated as the worker works ("file 3/8: src/foo.ts").
- A dashboard page that renders this as a timeline.

**What it showed us:** PR #9 (14 files) failed at `REVIEWING_FILES` after ~6
minutes, `stage_attempt=1`, every single time. And the log exposed something
strange — the *same* review being delivered 4 times, ~80 seconds apart,
re-running `FETCHING_DIFF` from scratch each time.

That last detail was the first real clue.

---

## Iteration 3 — Root-cause round 1: timeouts, concurrency, and lost progress

Armed with stage events, we dug in and found four compounding bugs:

### 3.1 A hard 5-minute ceiling on the whole review stage

The review stage had a timeout formula that was *capped at 5 minutes*
regardless of PR size. A real 14-file review (Gemini latency + thinking +
rate-limit retries) takes longer than 5 minutes. So **any multi-file PR
structurally timed out.** Small PRs fit under the cap — which is why they
always "worked."

### 3.2 Comment-triggered reviews skipped the lock

A GitHub App installation is a *shared secret* — any code with the private
key can impersonate the bot. We used a Redis lock (`SET NX EX`) to prevent
two executions of the same review from racing. But comment-triggered
reviews (`@parakh review`) called `triggerReview` with `skipLock=true`.

**Result:** when the queue redelivered a message while a previous execution
was still alive, *two* copies of the same review ran at once. They both
upserted the same stage event (resetting its clock), both wrote Redis state
(causing the dashboard's file count to jump around: 1, 2, 3, 4, 14, 10...),
and both burned Gemini quota — which exhausted the key pool faster and made
rate-limit backoff worse.

### 3.3 Every retry restarted from the top

Each redelivery re-fetched the *live* PR diff and recomputed a hash. If the
branch had moved between attempts, the hash changed and the Redis progress
was wiped — so we lost all completed files and started from zero, again and
again.

### 3.4 `withTimeout` leaked the inner loop

The timeout was implemented with `Promise.race([work(), timeoutPromise])`.
When the timeout won, the race returned — but the *losing* promise kept
running in the background. The file loop kept calling Gemini and writing
state after the worker "timed out." This is why the final event showed
`TIMED_OUT` (written by the cron watchdog) instead of `FAILED` (written by
the handler): the handler had already silently given up while the orphaned
loop kept going.

### The hidden 5th bug: the 50-subrequest cap

PR #9 was also tripping Cloudflare's 50-subrequest limit mid-review. The
queue would redeliver, the worker would re-do all the startup fetches
(token, diff, rules), get a few files in, hit the cap again, and die with
`NeonDbError: Too many subrequests` — right in the middle of a file, losing
everything since the last save.

The symptoms were a mess of overlapping failures. This is why the fix had to
be layered.

---

## Iteration 4 — The checkpoint / resume architecture

The central idea that fixed most of this: **treat each queue delivery as a
small, resumable slice of work, not the whole review.**

### 4.1 Per-file state saves (checkpoints)

Instead of saving review state once at the end, we save it **after every
completed file** in Redis (`completedFiles`, `accumulatedFindings`,
`batchIndex`). If a delivery dies at any point — timeout, subrequest cap,
crash — the next delivery reloads state and continues from the exact file it
left off at.

### 4.2 Pin the diff to the commit (migration 008)

We capture `head_sha` + `base_sha` at review-start and fetch the diff via
`compare/{base}...{head}` — an immutable diff that never changes between
deliveries. The diff hash therefore never changes, so Redis state survives
redelivery. Pushes made after a review starts can no longer invalidate it.

### 4.3 Replace the absolute ceiling with a no-progress stall timeout

Instead of "5 minutes, then fail," the review now runs as long as it's
making progress. It only fails if **no file completes within 10 minutes**
(a sign every Gemini key is rate-limited and it's going nowhere). This is
checked with an `AbortSignal` that the file loop actually respects between
files, so `withTimeout` no longer leaks an orphaned loop.

### 4.4 Always take the lock

Removed `skipLock=true`. Both PR-opened and comment-triggered reviews now go
through the Redis lock. The lock is refreshed inside the loop (the existing
heartbeat does double duty) and its TTL exceeds the max stage length, so a
legitimately long review doesn't lose its own lock mid-run. A redelivery
with a fresh heartbeat skips instead of duplicating; a stale lock is stolen.

### 4.5 Bounded concurrency instead of a full burst

Files were processed sequentially — which wasted a 7-key pool — but a full
burst tripped per-minute rate limits and discarded whole batches on 429s.
We now process up to 2 files concurrently per batch. Enough parallelism to
use the pool, bounded enough to avoid the 429 death-spiral.

---

## Iteration 5 — The subrequest budget guard (the current approach)

Even with checkpoints, the 50-subrequest cap meant deliveries died **mid
file** — in the middle of a Gemini call or a DB write — which is awkward (a
partially-processed file, a wasted model call, unpredictable boundaries).

So we stopped counting on Cloudflare to kill us politely and started counting
ourselves.

### What it is

`worker/src/jobs/subrequest-budget.ts` is a tiny counter:

- We start a `SubrequestBudget(44)` at the top of a review delivery.
- Every subrequest we control spends from it: the token lookup, the lock,
  the diff fetch, rule loading, the stage events, the heartbeat, the
  per-file state save, the Gemini call, the per-rule DB increments.
- When `used >= 44`, `spend()` throws `SubrequestBudgetExceededError`.

44, not 50: we stop *before* Cloudflare's real cap, so the checkpoint
happens at a predictable, controlled boundary instead of mid-fetch. It's
conservative on purpose — the seams we can't see (the count is approximate)
still land under the real 50.

### Why checkpointing beats crashing

When the budget guard throws:

1. The file loop catches it, does **not** mark the file done, and rethrows.
2. The outer handler recognizes `SubrequestBudgetExceededError` as a
   **checkpoint, not a failure** — it skips `failStage` (which would record
   a fake failure on the timeline) and just rethrows.
3. The queue redelivers the message.
4. The next delivery reloads Redis state, sees which files are done, and
   resumes from there. Because per-file state is already saved, the only
   "wasted" work on the next attempt is the startup overhead — not the
   whole review.

### The finalize reserve

The last step (`finalizeReview` — scoring, posting the comment, reactions)
needs ~15 subrequests of its own. Before starting it, we check
`hasRoomFor(15)`. If this delivery already burned most of its budget, we
checkpoint instead — so the *next* delivery starts fresh, runs finalize
cleanly, and never trips the cap mid-comment-post.

### Budget math that fits the queue's retry limit

The queue allows a limited number of retries. The budget is sized so that
even a 14-file PR resumes and finalizes within those retries:

- startup ~12, per file ~2-3, per batch ~3, finalize ~15
- Delivery 1: startup + ~10 files → hits budget → checkpoint
- Delivery 2: remaining files + finalize → done

Two to four deliveries for the worst realistic case — within the retry
limit, with headroom.

---

## Iteration 6 — Reasoning capture (and fixing the silent gap)

While adding per-file work we also wired up **reasoning capture**: the
model's "thinking" text is stored per file in a `review_reasoning` table for
the dashboard (opt-in via `REASONING_CAPTURE_ENABLED`, auto-pruned after a
retention window by cron).

We discovered the original code filled a buffer of reasoning rows but
**never actually wrote it to the database** — `saveReviewReasonings` was
imported and never called. With checkpointing, that would have meant losing
all reasoning every time a delivery resumed. We now flush the buffer before
finalize and best-effort before a checkpoint. The flush is a single batched
`INSERT ... ON CONFLICT (review_id, file) DO UPDATE`, so it's idempotent and
costs one subrequest instead of one per file.

---

## Iteration 7 — The queue's retry ceiling (the budget guard worked too well)

The subrequest budget guard went into production and... it worked perfectly.
The database state confirmed it:

- The guard accurately interrupted the process **before** it crashed.
- It correctly yielded to the queue to retry, checkpoint after checkpoint.
- The step events show the queue retried the message exactly 3 times —
  that's `stage_attempt: 4` under the hood.

And that was the problem. **`max_retries` was set to 3** in `wrangler.toml`.
The budget guard was doing its job, but the queue stopped delivering after
the 4th attempt and simply **dropped the message**. The review stalled out at
**10/13 files** — it ran out of queue retries, not out of budget.

The lesson: our checkpoint/resume architecture depends entirely on the queue
redelivering messages. The budget guard makes each delivery small and safe,
but **the number of deliveries is a hard configuration ceiling** we hadn't
tuned for large PRs. A 13-file review needs several checkpoints; a 3-retry
queue can't deliver that many.

**The fix:** bumped `max_retries` to **50** in `worker/wrangler.toml` and
deployed. Fifty redeliveries gives enormous headroom for as many checkpoints
as a large PR needs. (We could tune it tighter later, but the cost of a
retry is near-zero — state resumes from the last saved file — so generous
headroom is free insurance.)

It's a small config change, but it's a real architectural lesson: **the
resume story is only as good as the delivery ceiling.** Checkpointing
guarantees each attempt is *safe and resumable*; the queue config
guarantees there *will be a next attempt*.

---

## Iteration 8 — The comment → review pipeline guard (the "reviews stopped appearing" incident)

The comment pipeline (`@parakh review` → queue → classify → trigger a review) was
*working* at the webhook and queue layers, but the review it was supposed to
start was never created. The dashboard showed nothing new; the bot went silent.

### 8.1 An unguarded reaction call could kill the enqueue

`triggerReview` posted the PR-level 👀 reaction like this:

```ts
const seenReactionId = await addReaction(owner, repo, prNumber, REACTIONS.SEEN, token);
```

That call was **not** wrapped. A single GitHub hiccup (transient 5xx, rate
limit, network blip) made it throw, which made `triggerReview` throw *before*
the review was ever enqueued. The `COMMENT_RESPONSE` queue job would retry on
every delivery, forever, without ever creating a review or posting a reply.

The trigger-comment reaction had already been made best-effort; the PR-level
one was the exception, and the exception is what found the incident.

**The fix:** wrap it in `try/catch` and persist `undefined` on failure, exactly
like the trigger-comment reaction. A reaction is cosmetic; enqueueing the
review is not.

### 8.2 The classifier could swallow a bare "@parakh review"

The intent prompt said `@parakh review` was *usually* a review request but left
wiggle room for the model to file a bare `@parakh review` under `GENERAL` (and
then silently do nothing — `GENERAL` deliberately gets no reply).

**The fix:** the prompt now asserts that calling the bot's name together with
the word "review" is **always** a `REVIEW_REQUEST`, so the request can't be
dropped as chit-chat.

### 8.3 Why the old tests missed it

The unit tests mocked `triggerReview` *itself*, so they verified the classifier
calls it — not that it succeeds end-to-end. Nothing exercised the real wiring
where the unguarded reaction sat.

**The fix (this repo's new safety net):** a `worker/src/smoke/pipeline-smoke.test.ts`
suite that runs the **real** webhook → queue → classify → `triggerReview` chain
with only the leaf deps (GitHub API / DB / Redis / LLM) mocked. Its crown-jewel
case makes `addReaction` throw and asserts the REVIEW job is *still* enqueued —
an exact replay of the incident. It runs automatically on every `git push` via
`.githooks/pre-push` (`npm run test:pipeline`), so a broken comment→review
wiring blocks the push before it ever reaches production.

---

## Proposed Iteration 9 — Review behavior, not file order (not implemented)

The current pipeline's recovery unit and reasoning unit are both a file. That
is convenient for checkpointing, but it is the wrong altitude for a reviewer.
A single behavior can cross a route, provider, callback, configuration file,
template, and test. Reviewing those files independently makes the model—and
later the human—reconstruct the behavior from disconnected observations.

The next architecture should separate three concerns that happen to be coupled
today:

- **Evidence unit:** an exact changed hunk or symbol with old/new coordinates.
- **Review unit:** a behavioral group containing related evidence from any
  number of files.
- **Recovery unit:** a small, idempotent unit that fits the Worker budget and
  can be checkpointed. Initially this can be one behavioral group; oversized
  groups must split into stable subgroups without losing their shared intent.

File boundaries remain useful fallback and display metadata. They stop being
the primary unit of reasoning.

### 9.1 Non-negotiable invariant: every claim points back to code

A behavior summary is navigation, not authority. Every intent claim, risk, and
finding must carry one or more evidence references:

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

interface BehaviorGroup {
  id: string;                    // stable hash, not an LLM-generated index
  title: string;
  intent: {
    claim: string;               // hypothesis, never treated as established fact
    confidence: 'high' | 'medium' | 'low';
    sources: Array<'pr' | 'commit' | 'ticket' | 'code'>;
    evidence: EvidenceRef[];
  };
  changes: EvidenceRef[];        // primary membership
  context: EvidenceRef[];        // read-only dependencies; may appear in other groups
  riskSignals: string[];
}
```

Removing the summaries must still leave a complete, reviewable diff. Removing
the evidence must make the summaries invalid. GitHub links are generated from
the pinned SHA and the `newStart`/`newEnd` coordinates, and all references are
validated before posting. A summary with no valid evidence is dropped rather
than displayed as an uncheckable story.

### 9.2 Normalize the diff before asking what it means

The first pass is deterministic and makes the change set less noisy:

1. Parse the pinned unified diff into files, hunks, lines, and coordinates.
   Replace the current regex-only parser before building anything on top of it;
   renames, binary files, quoted paths, deletions, and no-newline markers need
   explicit handling.
2. Sort evidence by normalized path and coordinate so replay order does not
   depend on GitHub's response order.
3. Detect **blocks** moved within or across files using normalized rolling
   hashes followed by exact verification. Line-by-line matching is not enough:
   repeated imports, braces, and common statements would create false moves.
4. Add token-level metadata for paired edited lines so a reviewer can see that
   `==` became `!=` without treating the whole line as novel.

Moved code is not automatically safe. Moving an initializer, decorator,
closure, registration call, or block with relative side effects can change
behavior even when its text is identical. Therefore a pure move is collapsed
to one semantic event, but the destination scope and neighboring context stay
available to the reviewer. Token-level deltas also supplement the raw hunk;
they never replace it, because a one-token change can be the highest-risk part
of a PR.

This pass reduces duplicate tokens and produces better signals for grouping.
It must not decide that a change is trivial merely because the textual delta
is small.

### 9.3 Build a change graph, then form behavioral groups

Do not send the full raw diff to a model and ask it to invent groups. That is
expensive, hard to reproduce, and prone to plausible groupings with no
traceable basis. Build a deterministic change graph first:

- nodes are changed symbols or, where parsing is unavailable, changed hunks;
- strong edges come from imports, calls, references, inheritance, matching
  route/config keys, and tests that directly exercise a changed symbol;
- weaker edges come from directory proximity, shared naming, commit, author,
  and temporal proximity;
- exact moves and renames preserve identity across old and new locations.

Connected components above a confidence threshold become candidate groups.
Large components are split with stable size/token limits; isolated evidence
falls back to a file-based group. A file may contribute primary changes to
multiple behaviors, and shared infrastructure can be attached as read-only
context to several groups. Forcing every file into exactly one bucket would
recreate the same false boundary under a different name.

Author and commit boundaries are useful priors, not truth. Squashes, rebases,
pairing, bots, and cleanup commits routinely break the assumption that one
author or one commit equals one task.

### 9.4 Extract intent as a structured, falsifiable hypothesis

PR title/body, commit messages, linked-ticket text, and code structure are
cheap signals for what the author was trying to do. They are also incomplete,
stale, and sometimes wrong. The intent pass receives the candidate group's
compact manifest—not the entire raw PR—and produces the structured `intent`
object above.

The detailed reviewer then asks two separate questions:

1. Does the evidence support the stated intent?
2. Even if it does, is the implementation correct, complete, and safe?

This prevents a persuasive PR description from becoming proof that the code
is correct. Low-confidence or contradictory intent is shown as uncertain and
must never suppress a finding. If intent extraction fails, review continues
with a deterministic label derived from paths/symbols; it does not fall back
to hallucinating a narrative.

### 9.5 Add symbol-level dependency context with a strict budget

For each changed symbol, fetch only the contracts needed to judge it: called
function signatures, relevant type/interface definitions, route bindings,
configuration keys, and directly related tests. This context is referenced by
pinned blob SHA and line range and stored separately from changed evidence so
the UI cannot imply that unchanged code was edited.

Context expansion is bounded by depth, item count, and tokens. Prefer a
signature or AST slice over a whole file. When the budget is exhausted, record
`context_truncated: true` and reduce confidence; silent truncation would make a
confident review misleading.

### 9.6 Check semantic staleness against the target branch

The currently pinned `base_sha` and `head_sha` make retries review the same
change, but they do not by themselves explain what changed on the target
branch after the feature branch diverged. Capture an immutable triple at
review start:

```text
merge_base_sha   common ancestor of the PR head and target tip
base_tip_sha     target-branch tip at review start
head_sha         PR head at review start
```

Then derive two change sets:

```text
PR changes        = diff(merge_base_sha, head_sha)
upstream changes  = diff(merge_base_sha, base_tip_sha)
```

Gate the expensive explanation in two steps: intersect files first, then
symbols/keys. Disjoint files need no model context. A same-file/different-symbol
overlap is a weak signal; a changed callee, interface, route, schema, or config
key used by the PR is strong. Only strong or ambiguous overlap becomes a
staleness review group.

Staleness is not an automatic score penalty. It is evidence of integration
risk, and the reviewer must identify a concrete incompatibility before it
becomes a finding. This avoids punishing an old branch that still integrates
cleanly.

### 9.7 Ground findings before trying to make the model deterministic

The score calculation is already pure and rule-violation severity is assigned
in code, but generic finding discovery and severity still come from the model.
Temperature `0` is already set on the review call; setting it again will not
make hosted inference bit-for-bit reproducible.

The path toward stable scores is to increase deterministic evidence and track
provenance:

```ts
interface FindingProvenance {
  source: 'analyzer' | 'repository-rule' | 'llm';
  detectorId: string;
  detectorVersion: string;
  evidence: EvidenceRef[];
}
```

Start with checks that can run on complete reconstructed source and have exact
line mappings. Do not lint a diff fragment: parsers and linters generally need
the complete file, configuration, module mode, and sometimes project graph.
WASM inside a Worker is a candidate only after bundle-size, CPU-time, memory,
and compatibility benchmarks. Builds, tests, and arbitrary repository tools
require a separate sandboxed runner; untrusted PR code must never execute in
the review Worker.

Analyzer and repository-rule findings receive fixed severity/weight mappings.
The model consumes them as facts, avoids duplicating them, and focuses on
intent, cross-file correctness, and architecture. Canonical finding IDs and
evidence overlap prevent the same defect from being counted once per group or
once per detector.

### 9.8 Cache artifacts, not unexplained model answers

The existing Redis state resumes one review. A content-addressed cache can
also make exact replays cheaper and stable, but a key based only on `fileDiff`
is unsafe: identical text can mean something different under new rules,
surrounding code, analyzer versions, prompts, or models.

Cache the separately inspectable artifacts (normalized evidence, graph,
intent, analyzer output, and review result) using a versioned key derived from:

```text
repository + pinned context hashes + normalized group evidence
+ active-rules hash + prompt/schema version + model ID
+ analyzer versions + pipeline version
```

Batch Redis reads/writes where possible; a GET and SET per file would consume
the same 50-subrequest budget the cache is meant to protect. Exact cache hits
may reuse a stored result. Semantic-similarity hits are hints for triage, not
proof that a review can be skipped.

### 9.9 Extend checkpoint state around groups

The proposed state is versioned so a deployment can invalidate or migrate old
checkpoints safely:

```ts
interface ReviewStateV2 {
  schemaVersion: 2;
  pipelineVersion: string;
  reviewId: string;
  input: { mergeBaseSha: string; baseTipSha: string; headSha: string };
  inputHash: string;
  rulesHash: string;
  normalizedChanges: EvidenceRef[];
  groups: BehaviorGroup[];
  completedGroupIds: string[];
  groupSummaries: Record<string, string>;
  accumulatedFindings: Finding[];
  staleness?: { overlappingEvidence: EvidenceRef[]; analyzed: boolean };
}
```

Normalization and grouping are checkpointed before detailed review. A
redelivery never asks a model to regroup already planned evidence. Stable IDs
make completion idempotent even if groups are processed concurrently. Finalize
must verify that every primary `EvidenceRef` belongs to a completed group or a
recorded fallback group.

### 9.10 What the proposed pipeline would look like

```text
FETCHING_INPUT
  pin merge base + target tip + PR head
  fetch PR diff, upstream diff, PR/commit intent metadata

NORMALIZING_DIFF                 deterministic, checkpoint
  robust parse → stable order → moves/renames → token metadata

PLANNING_REVIEW                  mostly deterministic, checkpoint
  changed symbols → dependency graph → candidate behavior groups
  cheap intent extraction only for grounded candidate groups
  file-based fallback for ungrouped evidence

REVIEWING_GROUPS                 resumable, bounded concurrency
  attach bounded symbol context → deterministic facts → model review
  validate every finding against pinned coordinates → canonical dedupe

CHECKING_STALENESS               only when file/symbol overlap exists
  explain concrete incompatibilities between upstream and PR changes

SCORING → POSTING_COMMENT → REACTING
  compute once from unique findings
  render by behavior, with exact code links and per-file fallback
```

Sequence diagrams should be generated only for groups with actual control-flow
evidence. Forcing every group into a diagram turns uncertainty into fake
precision. The normal output is a short behavior summary, its affected paths,
findings, and exact evidence links.

### 9.11 Rollout order and success criteria

Ship this in layers so each new abstraction proves it earns its cost:

1. Robust diff parser, stable ordering, and validated `EvidenceRef`s.
2. Exact block-move detection and token metadata, measured for false matches
   and token reduction.
3. Deterministic graph grouping with file fallback; no intent model yet.
4. Structured intent over group manifests and behavior-group review.
5. Merge-base/upstream overlap detection, gated before explanation.
6. Deterministic analyzers on complete source, starting with one supported
   language and a measured execution strategy.
7. Versioned artifact cache and feedback-based noise filtering after enough
   real review data exists.

Track: evidence-link validity, percentage of changes assigned to a group,
fallback rate, token and subrequest cost per changed line, latency, checkpoint
count, cache-hit rate, finding address/dismissal rate, staleness precision, and
score variance across exact replays. Behavioral grouping is successful only if
reviewers reach concrete correctness questions faster without losing their
ability to inspect the underlying code.

---

## What the pipeline looks like now

```
webhook (PR opened / synchronize) ──► insert reviews row + 👀 reaction
                                       └─► enqueue REVIEW job
@parakh comment ──► COMMENT_RESPONSE job ──► classify intent (LLM provider chain)
                     └─► REVIEW_REQUEST ──► triggerReview ──► enqueue REVIEW job

REVIEW job (a delivery = a resumable slice):
  acquire Redis lock (fresh-heartbeat → skip, stale → steal)
  capture SHA pin (head/base) → immutable diff
  start stage events (idempotent upsert per attempt)
  budget = SubrequestBudget(44)
  loop batches of files (concurrency 2):
     heartbeat + refresh lock + update live pointer   (spend 3)
     per file: LLM review ─► findings ─► save state (spend ~2-3)
     on SubrequestBudgetExceededError ──► checkpoint (throw → redeliver)
  when all files done:
     if !hasRoomFor(finalize) ──► checkpoint (throw → redeliver)
     else finalizeReview (scoring → comment → reactions)   (spend ~15)
  release lock

cron (every minute):
  prune expired reasoning
  sweep stalled reviews (no heartbeat > 12 min) → TIMED_OUT + "@parakh review" comment
  release their locks
```

---

## Why the design is shaped this way (the tl;dr)

- **Every failure taught us to be idempotent and resumable.** The queue
  retries; at-least-once delivery means a message can be delivered twice.
  Everything — stage events, state saves, reasoning writes, verdict
  reactions — is written so re-running it is harmless.
- **Count the resources you can't avoid using.** Cloudflare's 50-subrequest
  cap is invisible until you hit it. We made it a first-class, visible
  counter with a deliberate safety margin (44) and a clean checkpoint
  mechanism instead of a crash.
- **Observability came before fixing.** The `review_step_events` timeline is
  what turned "reviews fail on big PRs" into "here are the four concrete
  bugs." Keep it; it's the reason we could debug at all.
- **A Worker is not a server.** No long-running process, no background
  threads. The queue delivers work, the cron sweeps the strays, and every
  individual delivery must be short enough to survive both the timeout and
  the subrequest cap.

---

## Key files

| File | What it does |
|---|---|
| `worker/src/jobs/review.ts` | The whole pipeline: trigger, per-file review, checkpoint/resume, finalize |
| `worker/src/jobs/subrequest-budget.ts` | The 44-cap counter + `SubrequestBudgetExceededError` |
| `worker/src/jobs/stage-tracker.ts` | Stage events, `withTimeout` (abort-aware), per-stage timeouts |
| `worker/src/db/reviews.ts` | All DB access: reviews, stage events, SHA pin, reasoning, sweep |
| `worker/src/gemini/keyPool.ts` | Gemini key rotation, rate-limit / model-unavailable detection |
| `worker/src/llm/factory.ts` | Configured provider chain (Gemini, Groq, Workers AI, OpenRouter) + shared budget/cooldown wiring |
| `worker/src/jobs/comment-response.ts` | `@parakh` mention → intent classification → trigger |
| `worker/src/smoke/pipeline-smoke.test.ts` | Pre-push smoke: real webhook→queue→triggerReview wiring, leaf deps mocked; catches a broken comment→review chain |
| `.githooks/pre-push` | Runs the smoke test before every `git push` (aborts on failure) |
| `worker/src/cron.ts` | Watchdog: prune reasoning, sweep stalled reviews, free locks |
| `db/migrations/` | Schema, applied in order by `db/migrate.ts` |

## Lessons for anyone deploying this

1. **Migrations are manual.** `wrangler deploy` ships code; it does not run
   `db/migrate.ts`. Apply migrations to the production DB before or right
   after deploying code that depends on new columns.
2. **A GitHub webhook returning 200 does not mean the review succeeded.** The
   webhook only enqueues; the real work happens in the queue. Judge success
   by the review row's status and the step events, not the webhook response.
3. **The budget guard buys us retries, not unlimited work.** If a PR is huge
   enough to need more deliveries than the queue allows, it will eventually
   be given up on. The cron sweep posts a "stuck — reply `@parakh review`"
   comment so a human can re-trigger it.
4. **Cosmetic side effects must never be on the critical path to enqueueing.**
   A reaction/comment/emoji failure should warn and continue — if it can
   throw, it will find the worst possible moment (a GitHub hiccup right when
   someone asks for a review).
5. **Mock the leaves, not the wiring.** Unit tests that mock `triggerReview`
   can't catch a break *inside* it. The smoke suite runs the real queue chain
   so safety comes from exercising the actual path, not assuming it.
6. **Run the smoke test before you push.** `git push` is the last gate before
   production. `.githooks/pre-push` runs `npm run test:pipeline` and blocks a
   push that would ship a broken comment→review pipeline.
