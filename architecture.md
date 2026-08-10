# Parakh Architecture: How the Review Pipeline Got Here

> A plain-English story of the review pipeline: what we tried first, how it
> broke, how we found out why, and the changes we made — in the order we made
> them — so a future reader knows *why* the code looks the way it does.

---

## The product in one sentence

Parakh is a GitHub bot. When you open a PR (or mention `@parakh` in a
comment), it sends your diff to Google's Gemini model, turns the model's
output into "findings," scores the PR out of 5, and posts the result as a
GitHub review with 👍 / 👎 reactions.

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

## What the pipeline looks like now

```
webhook (PR opened / synchronize) ──► insert reviews row + 👀 reaction
                                       └─► enqueue REVIEW job
@parakh comment ──► COMMENT_RESPONSE job ──► classify intent (Gemini)
                     └─► REVIEW_REQUEST ──► triggerReview ──► enqueue REVIEW job

REVIEW job (a delivery = a resumable slice):
  acquire Redis lock (fresh-heartbeat → skip, stale → steal)
  capture SHA pin (head/base) → immutable diff
  start stage events (idempotent upsert per attempt)
  budget = SubrequestBudget(44)
  loop batches of files (concurrency 2):
     heartbeat + refresh lock + update live pointer   (spend 3)
     per file: Gemini review ─► findings ─► save state (spend ~2-3)
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
