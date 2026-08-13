# PR 20 review failure diagnosis

Date: 2026-08-13

Affected review: [Parakh PR 20](https://github.com/PranshuRaj1/Parakh/pull/20)

Production review ID: `b4d6b48a-18c8-4e21-930e-9b5c5ec54503`

## Conclusion

The review did not finish because Parakh calculated a `REVIEWING_FILES` timeout longer than Cloudflare allows a Queue consumer invocation to run.

For PR 20, which has 20 reviewable files, the deployed formula calculates:

```text
30 seconds base + ceil(20 / 2) * 90 seconds = 930 seconds
```

Cloudflare Queue consumers have a 15-minute, or 900-second, wall-clock limit. Parakh therefore expected its stage timeout to run 30 seconds after Cloudflare could terminate the Worker invocation.

The watchdog deadline added another 120 seconds of grace. As a result, the sequence was:

```text
09:49:12 UTC  REVIEWING_FILES started
09:50:24 UTC  last per-file event was written
10:04:12 UTC  Cloudflare's 15-minute consumer limit was reached
10:04:42 UTC  Parakh's 930-second stage timeout would have fired
10:06:42 UTC  persisted watchdog deadline became eligible
10:07:03 UTC  minute cron marked the review TIMED_OUT
```

This timing matches production state and the GitHub timeout comment.

## User-visible symptom

The bot acknowledged PR 20 at 09:49 UTC but never posted a completed review. At 10:07 UTC it posted:

```text
Review stuck at REVIEWING_FILES and timed out.
```

The webhook, queue enqueue, GitHub authentication, diff fetch, parser, rule loading, and initial provider calls all worked. The failure happened after review processing had started.

## What I checked and why

### 1. GitHub PR activity

I inspected PR 20 and compared it with earlier affected PR activity.

Why:

- Confirm that the webhook was delivered.
- Confirm that the bot identity could comment.
- Establish exact acknowledgment and timeout timestamps.
- Distinguish a trigger failure from a processing failure.

Result:

- The bot posted its acknowledgment at 09:49:04 UTC.
- The bot posted the stuck-review message at 10:07:04 UTC.
- There was no completed review comment between them.

This ruled out webhook delivery and GitHub comment permissions.

### 2. Production review row

I queried the production `reviews` row using a read-only SQL query. Credentials were loaded into environment variables and were not printed.

Why:

- Find the authoritative status and current stage.
- Check whether the new `stage_deadline_at` migration was present and used.
- Read the last stage reason rather than infer state from GitHub comments.

Result:

```text
status: FAILED
current_stage: REVIEWING_FILES
stage_attempt: 1
stage_reason_code: PROCESSING
stage_reason_detail: Reviewing batch 1 (5/20 files done)
error_step: REVIEWING_FILES
error_message: Stage timed out
```

This ruled out migration failure and showed that no queue redelivery created a second stage attempt.

### 3. Stage event timeline

I queried `review_step_events` for the production review.

Why:

- Determine whether the failure was in diff loading, rule loading, model review, scoring, or comment posting.
- Compare the real duration with the calculated timeout and platform limit.

Result:

```text
FETCHING_DIFF     completed in 652 ms
LOADING_RULES     completed in 1,519 ms
REVIEWING_FILES   timed out after 1,070,139 ms
```

`REVIEWING_FILES` started at 09:49:12.922 UTC and the watchdog closed it at 10:07:03.061 UTC.

### 4. Per-file telemetry

I queried `review_file_events` for the same review.

Why:

- Verify whether provider fallback was actually working.
- Identify the last durable action before progress stopped.
- Determine whether files were being silently counted as clean.

Result:

- Six files have completed telemetry rows.
- The first file was served by Gemini.
- The next five were served by Groq.
- No file has a terminal provider failure row.
- The last file event was written at 09:50:24 UTC.

Provider fallback was working. The review stopped after model completion for the sixth file, not while waiting for Gemini alone.

### 5. Redis checkpoint and execution lock

I read only the review checkpoint key and lock key from production Redis. Tokens and raw findings were not printed.

Why:

- Verify that resumable state survived the stopped invocation.
- Check whether a stale execution lock blocked queue redelivery.
- Compare checkpointed progress with database telemetry.

Result:

```text
allFiles: 20
completedFiles: 5
batchIndex: 1
terminalFailedFiles: 0
execution lock: missing
```

The lock is not blocking retries. The database records six completed file calls, while Redis records only five completed files. This proves the invocation stopped after writing telemetry for file six but before committing the corresponding durable progress checkpoint.

The exact awaited operation at that point cannot be recovered from existing telemetry. In the full-review path, the remaining network boundaries are rule evidence database writes and the Redis state write. Neither currently has an individual hard timeout.

### 6. Queue and checkpoint code

I inspected the queue handler, execution lock logic, subrequest budget, checkpoint code, and Queue consumer configuration.

Why:

- Check whether exceptions are acknowledged accidentally.
- Check whether retry payloads lose the review ID.
- Check whether the lock TTL prevents a retry.
- Check whether `message.retry()` is configured and tested.

Result:

- Failed review jobs call `message.retry()`.
- The payload retains the same `reviewId`.
- `max_retries` is 50.
- The lock is released in `finally` and is currently absent.
- Existing tests only verify the mocked `message.retry()` call and lock behavior. They do not execute a real checkpoint and redelivery across the Queue runtime.

These checks ruled out the payload, retry count, and current lock as the primary cause.

### 7. Deterministic failing invariant test

I temporarily added this assertion at the real timeout calculation seam:

```typescript
expect(getReviewingFilesTimeout(20)).toBeLessThan(15 * 60_000)
```

Then I ran:

```text
npm test --workspace=worker -- --run src/jobs/stage-tracker.test.ts
```

It failed deterministically:

```text
expected 930000 to be less than 900000
```

Why:

- Convert the production symptom into a fast local red signal.
- Prove the failure is caused by the deployed timeout formula, not a timing guess.
- Exercise the exact function responsible for PR 20's deadline.

The temporary assertion was removed after capturing the result. No diagnostic instrumentation remains in the codebase.

### 8. Cloudflare platform limits

I verified the current limits against Cloudflare's official documentation.

- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Queue retry behavior](https://developers.cloudflare.com/queues/configuration/javascript-apis/)

Cloudflare documents a 15-minute wall-clock limit for Queue consumer invocations. This is the external invariant the timeout calculation violated.

## Root cause chain

1. The provider hardening changed the per-file stage estimate from 30 seconds per file to 90 seconds per concurrent pair.
2. The timeout calculation was intentionally left uncapped.
3. For 20 files, the application stage timeout became 930 seconds.
4. Cloudflare can terminate the Queue consumer after 900 seconds.
5. Parakh's `withTimeout` cannot fire before the platform termination.
6. The watchdog is scheduled after the application timeout plus 120 seconds of grace.
7. The cron therefore sees an abandoned `RUNNING` review and posts the stuck-review message around 18 minutes after the stage began.

The watchdog itself is now behaving consistently with its persisted deadline. The bug is that the persisted deadline is based on a stage timeout that is impossible for the Queue consumer to reach.

## Secondary reliability gap

The provider timeout only bounds provider requests. It does not bound every database, Redis, or GitHub request in the file-processing path.

Production evidence shows:

```text
review_file_events completed rows: 6
Redis completedFiles checkpoint: 5
```

That means a file's model result was available and telemetry was written, but processing did not reach a durable checkpoint. A stalled persistence or evidence-update request can still hold the entire stage until the outer timeout. Since the outer timeout is currently later than Cloudflare's platform limit, the runtime wins first.

## Why tests passed before deployment

The test suite covered:

- provider request timeouts;
- sequential fallback through four hanging providers;
- delayed queue retry calls;
- watchdog deadline ordering relative to the application stage timeout;
- parser regressions;
- incomplete review formatting.

It did not cover the platform invariant:

```text
application stage timeout + cleanup reserve < Queue consumer wall-clock limit
```

One existing test explicitly expected the timeout to scale without an absolute ceiling. That test encoded the incorrect assumption that the subrequest checkpoint or application timeout would always run before Cloudflare terminated the consumer.

## Recommended correction

The fix should preserve these invariants together:

1. A single Queue delivery must checkpoint and exit well before 15 minutes, preferably with at least 90 to 120 seconds reserved for cleanup and retry marking.
2. The application stage timeout must always be shorter than the Queue consumer wall-clock limit.
3. The watchdog deadline must remain later than the application stage timeout, but it must not be the normal completion mechanism.
4. Every outbound provider, database, Redis, and GitHub request in the hot file path needs a bounded timeout.
5. Durable file progress should be committed before optional telemetry or evidence-count updates when practical.
6. A regression test must assert the Queue platform invariant for large file counts.
7. An integration test should force a mid-review checkpoint and prove that the same `reviewId` resumes on a second delivery.

A safe ordering is:

```text
per-request timeout
  -> per-file operation timeout
  -> time-aware delivery checkpoint
  -> application stage timeout
  -> Queue consumer platform limit
  -> watchdog deadline
```

## Initial diagnosis scope

This investigation was read-only against GitHub, PostgreSQL, Redis, Cloudflare documentation, and deployed health state. It did not trigger another review, alter production data, or deploy a fix.

## Implemented correction

The follow-up patch applies the diagnosis in five layers:

1. `REVIEWING_FILES` is capped at 12 minutes and its watchdog grace is 2 minutes, keeping both deadlines below Cloudflare's 15-minute Queue consumer limit.
2. Each Queue delivery reviews at most five files. It persists the checkpoint, closes the stage, sets the review back to `QUEUED`, releases the execution lock, and requests delayed redelivery when work remains.
3. A 10-minute delivery checkpoint prevents new bounded work from starting when its estimated budget would cross the checkpoint deadline.
4. Neon, Upstash Redis, GitHub API, and GitHub App token requests now abort after 15 seconds instead of being able to hold the invocation indefinitely.
5. Concurrent file completions serialize their Redis state commits. A completed file is added to durable state before evidence counters and per-file telemetry run, and optional writes are capped at five per delivery.

The All-Keys-exhausted path no longer sleeps inside the Queue consumer. It uses the same persisted three-attempt file retry state and delayed Queue redelivery as the provider fallback path.

## Regression coverage

The added tests assert that:

- large file counts cannot create a stage timeout at or beyond the Queue platform limit;
- stage timeout plus watchdog grace remains below that limit;
- the time-aware checkpoint trips at the expected boundary;
- a checkpointed review is redelivered with the same `reviewId` and the next Queue attempt number.

The Worker TypeScript build and focused stage, Queue redelivery, review redelivery, and provider fallback tests pass after the correction.
