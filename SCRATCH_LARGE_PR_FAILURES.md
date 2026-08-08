# SCRATCH: Large-PR Review Failures — Diagnosis + Logging Plan (INTERNAL)

> Internal scratch doc. Do NOT commit/push. Used to plan the fix + the logging
> mechanism after this issue is understood. Update it as we learn more.

---

## 1. Symptom

- Small PRs (a few files) review fine.
- Any larger change (PR #9 = 14 files) fails at **REVIEWING_FILES** with
  `Stage timed out` after ~6 minutes (379779ms measured).
- Every re-review produces a NEW review row (e1fc023f, f2d78302, c8fa89d0 …),
  each `FAILED` / `REVIEWING_FILES` / `Stage timed out`, `stage_attempt=1`.
- Live progress on the dashboard jumps non-monotonically
  (`file 1/14, 2/14, 3/14, 4/14, 14/14, 10/14 …`) — signature of MULTIPLE
  concurrent executions of the same review racing each other.
- Webhook always returns 200 (it only dispatches to the queue), so GitHub
  "200" never means the review succeeded.

## 2. Hard evidence (from DB + step events, review c8fa89d0)

```
FETCHING_DIFF  COMPLETED  534ms   04:36:12.012
LOADING_RULES  COMPLETED  377ms   04:36:12.965
FETCHING_DIFF  COMPLETED  536ms   04:37:35.016   <- attempt redelivered (~80s later)
LOADING_RULES  COMPLETED  347ms   04:37:36.201
FETCHING_DIFF  COMPLETED  513ms   04:38:55.398   <- redelivered again
LOADING_RULES  COMPLETED  352ms   04:38:56.341
FETCHING_DIFF  COMPLETED  495ms   04:39:44.405   <- redelivered again
LOADING_RULES  COMPLETED  339ms   04:39:45.543
REVIEWING_FILES TIMED_OUT 379779ms 04:39:46.057 -> 04:46:05.836
```

- The same review was delivered **4 times** (~80s apart) → the queue
  `message.retry()` path fired repeatedly (see `queue-handler.ts:51`).
- Only ONE `REVIEWING_FILES` event exists because `dbStartStage` is an
  UPSERT (`ON CONFLICT (review_id, stage, attempt_number) WHERE ended_at IS NULL
  DO UPDATE SET started_at = now()`) — every redelivery RESETS the stage clock.
- The final event outcome is `TIMED_OUT` (only written by the cron watchdog via
  `dbTimeoutStage`), NOT `FAILED` (written by `failStage`) → the executing
  attempt never returned a proper StageTimeoutError/failStage; it silently
  stopped heartbeating and the cron swept it (stall timeout = 5 min,
  `cron.ts:12`).

## 3. Root cause breakdown

### 3.1 THE primary bug — hard 5-minute ceiling on REVIEWING_FILES
`getReviewingFilesTimeout()` (`worker/src/jobs/stage-tracker.ts:145`):
```
min(BASE_REVIEW_MS + PER_FILE_REVIEW_MS * filesTotal, ABSOLUTE_CEILING_REVIEW_MS)
   = min(5000 + 30000 * n, 300000)   // ABSOLUTE_CEILING_REVIEW_MS = 300_000
```
For n >= 10 the ceiling 300s dominates. A real review with 14 files takes
longer than 5 minutes (Gemini latency + thinking + rate-limit retries), so ANY
multi-file PR times out. Small PRs (1-3 files) fit → "work fine".

### 3.2 Concurrency — comment-triggered reviews skip the lock
`comment-response.ts:72,90` calls `triggerReview(..., skipLock=true)`. With
`skipLock=true` (`review.ts:333`) **no lock is acquired**. Combined with
Cloudflare Queue at-least-once + redelivery while a previous execution may
still be alive, two executions of the same review can run simultaneously:
- both upsert the same stage event (resetting started_at),
- both write Redis state → `completedFiles` jumps around (1,2,3,4,14,10),
- both burn Gemini quota → keys exhaust faster → more rate-limit backoff.

### 3.3 Every retry restarts from FETCHING_DIFF
Each redelivery re-runs `FETCHING_DIFF` + `LOADING_RULES` (`review.ts:494-535`)
and re-fetches the live PR diff. If the PR changed since the previous attempt,
the diff-hash check (`review.ts:504`) wipes Redis state → start from 0 files.
Wasted calls + lost progress on every redelivery.

### 3.4 `withTimeout` leaks the inner promise
`Promise.race([work(signal), timeoutPromise])` does NOT cancel the losing
promise. After the timeout fires, the inner file loop keeps running in the
background → unhandled rejections, extra Gemini calls, and a review that looks
"stalled" to the watchdog even though it's still burning quota. This is why the
final event is TIMED_OUT (watchdog) rather than FAILED (failStage).

### 3.5 No per-file / per-call telemetry
The only timing data is stage-level `duration_ms`. We cannot see:
which files completed, per-file latency, token usage, number of 429s, backoff
time vs. working time, GitHub/DB call latencies. We are flying blind.

## 4. Fix logic to write (after this is agreed)

### 4.1 Make REVIEWING_FILES resumable and remove the absolute ceiling
- Record per-file completion in the DB (not just Redis), or keep Redis state
  but DO NOT wipe it on redelivery (keep diff-hash pinning, see §4.3).
- Replace the absolute 300s ceiling with a **no-progress stall timeout**:
  e.g. fail only if NO file has completed in the last N minutes, using the
  existing `worker_heartbeat_at` + a `lastFileCompletedAt`. Large PRs should
  be allowed to run as long as they are making progress (up to the worker
  execution limit).
- Alternatively keep a ceiling but scale it properly and make the queue
  retry RESUME (don't restart the stage): bump `stage_attempt` and continue
  from `completedFiles` instead of re-running from the top.

### 4.2 Fix concurrency
- Always acquire the review lock, even for comment triggers (remove
  `skipLock=true`, or make lock acquisition conditional but not skipped).
- Make the lock TTL exceed the max stage length; refresh it inside the
  per-file loop (heartbeat already does this — reuse it for the lock).
- On redelivery, if the lock is still held AND the heartbeat is fresh,
  **skip** (ack the message) instead of running a duplicate.

### 4.3 Pin the diff to the commit at review-start (from earlier decision)
- Store `head_sha` + `base_sha` on the review row at trigger time.
- Fetch the diff from `GET /repos/{o}/{r}/compare/{base}...{head}` with
  `Accept: application/vnd.github.diff` on EVERY attempt → immutable diff.
- Then `diffHash` never changes → Redis state survives redelivery → true resume.

### 4.4 Cancel work on timeout
- Give `withTimeout` an abort path that actually stops the inner loop
  (it already takes an `AbortSignal` — ensure the loop checks it between
  files AND that the signal aborts on timeout), and `await` the inner
  promise so a timeout produces a clean `StageTimeoutError` → `failStage`
  instead of an orphaned background loop + watchdog TIMED_OUT.

### 4.5 Batch with real parallelism (after correctness)
- 7 keys in the pool but files are processed SEQUENTIALLY
  (`review.ts:571`). Process 2-3 files concurrently (limited by keys + TPM)
  to use the pool and shorten wall time. Keep the per-file failure semantics
  (AllKeysExhausted -> unshift rest of batch, no data loss).

## 5. Logging / telemetry mechanism plan (implement AFTER the fix)

Goal: know exactly where time goes and WHY a review fails. Everything below
should land in a review's step events / a new per-file table, plus structured
worker logs.

### 5.1 New table: `review_file_events`
```
review_id UUID, file TEXT, model TEXT,
latency_ms INT, input_tokens INT, output_tokens INT, thinking_tokens INT,
retries INT,          -- how many Gemini 429/404s before success
key_used TEXT,        -- masked key hint (index), NOT the secret
attempt_number INT, status TEXT (ok/failed/skipped), error TEXT,
started_at, ended_at
```

### 5.2 Extend `review_step_events.detail` (already JSONB)
Per completed stage, record:
- `attempts` (number of redeliveries that touched this stage)
- `resumed_from_files`, `files_completed`, `files_total`
- `backoff_ms`, `backoff_count` (time spent in RATE_LIMITED_BACKOFF)
- `working_ms` (Gemini call time), `dbtime_ms`, `github_ms`
- per-stage `elapsed_breakdown: { fetch_diff, load_rules, review_files, react, post }`

### 5.3 Structured worker logs (Cloudflare observability is on)
Emit `key=value` lines so `wrangler tail` / Logpush is greppable:
- `[perf] review=<id> stage=REVIEWING_FILES file=src/x.ts latency=45200ms retries=3 key=4`
- `[perf] review=<id> stage=<s> total=<ms> breakdown={...}`
- `[perf] review=<id> backoff event: until=... cause=429 key=3`
- `[queue] job=<id> type=REVIEW delivery=<n> outcome=retry err=<msg>`
- GitHub + DB call timings around every API/query.

### 5.4 Dashboard surface
- Per-step timeline bar for each stage: duration + % of total + status.
- Per-file table (from `review_file_events`) with latency/tokens/retries,
  sortable, so a slow file is obvious.
- A single "timeline" JSON per review used by the ETA endpoint
  (`getAvgDurationByStep` already reads stage durations — extend it to
  read per-file averages too).

### 5.5 Quick queries to run during a failing review (today, before the fix)
```sql
-- per-stage timing + outcome for a review
SELECT stage, outcome, duration_ms, error_code, error_message,
       started_at, ended_at
FROM review_step_events WHERE review_id='<id>' ORDER BY started_at;

-- live pointer / heartbeat freshness
SELECT current_stage, stage_reason_code, stage_reason_detail,
       worker_heartbeat_at, stage_started_at
FROM reviews WHERE id='<id>';
```
(These already exist and are the ONLY data available today — that's the gap.)

## 6. Key file references

| Concern | File |
|---|---|
| Timeout ceiling | `worker/src/jobs/stage-tracker.ts:141-147` |
| Stage lifecycle (upsert/reset) | `worker/src/db/reviews.ts` `dbStartStage/dbCompleteStage/dbFailStage` |
| Watchdog sweep / TIMED_OUT | `worker/src/cron.ts:12,26,32` |
| Queue retry path | `worker/src/jobs/queue-handler.ts:49-52` |
| skipLock on comment trigger | `worker/src/jobs/comment-response.ts:72,90` + `review.ts:333` |
| Diff re-fetch + hash wipe | `worker/src/jobs/review.ts:496-507` |
| Sequential per-file loop | `worker/src/jobs/review.ts:552-628` |
| withTimeout (leaks inner) | `worker/src/jobs/stage-tracker.ts:122-130` |
| Diff fetch (live, unpinned) | `worker/src/github/api.ts:66-83` |
