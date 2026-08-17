# Checkpoint log — DB connect-timeout outage fix (2026-08-17)

## Production symptom (from worker logs)

- Every Neon request threw `NeonDbError: Error connecting to database: The operation was
  aborted due to timeout` for a sustained ~12+ minute window, across cron ticks
  (`pruneExpiredReasoning`, `expirePendingRules`, `dbFindResumableDailyQuotaReviews`,
  `dbSweepStalledReviews`, `dbTimeoutStage`) and queue deliveries (REVIEW job, attempt 11).
- `[queue] Retry limit reached for REVIEW; acknowledging delivery` — the REVIEW job was
  ACKed and permanently dropped (no FAILED row, no comment, no re-attempt).
- `ReviewFailurePersistenceError` — failure persistence also failed because it needs the DB.

## Root cause chain (verified in-repo, no external sources)

1. Every DB call is a REST fetch to Neon SQL-over-HTTP armed with
   `AbortSignal.timeout(20s)` (`request-timeout.ts:1`, `db/client.ts:28`). When the signal
   fires the driver throws exactly the logged error
   (`@neondatabase/serverless` index.mjs:1548-49: `Error connecting to database: ${e.message}`).
2. DB was healthy at diagnosis time: `SELECT 1` in 311 ms from local machine against the
   `.env.moved` pooler URL (neon 0.10.4). The failure was transient on the connect path
   (Neon scale-to-zero resume / pooler churn / network blip).
3. 20s is under Neon's documented resume window; each aborted connect re-triggers resume
   churn, and the 1-minute cron re-aborts every attempt → self-sustaining outage.
4. Cron-path DB calls had ZERO retry — one timeout killed the watchdog minute, so stalled
   reviews could not be marked TIMED_OUT and the queue kept redelivering the same job.
5. `queue-handler.ts` ACKed any job past 8 app-level attempts (~11.8 min of backoff,
   matching the outage window) regardless of cause — the queue's own `max_retries=50`
   never engaged → silent job loss.

## Fix (4 checkpoints, each verified before proceeding)

### CP1 — DB client cold-start tolerance — VERIFIED
- `db/client.ts`: added `DB_REQUEST_TIMEOUT_MS = 45_000` + `createDbRequestSignal()`.
  Neon now gets 45s per request (fresh signal per `getDb()` call = fresh budget per retry
  attempt). Redis/GitHub keep the 20s `OUTBOUND_REQUEST_TIMEOUT_MS`.
- New `db/client.test.ts` (2 tests).
- Verified: `client.test.ts` + `db-resilience.test.ts` → 14 tests pass.

### CP2 — Retry all cron-path DB calls — VERIFIED
- `cron.ts`: added `CRON_DB_RETRY_OPTS` (3 attempts, 250ms base, 2s max, transient-only)
  and wrapped every DB call: `pruneExpiredReasoning`, `expirePendingRules`,
  `dbFindResumableDailyQuotaReviews`, `dbSweepStalledReviews`, `dbTimeoutStage`, `getReview`.
  The 45s per-request budget dominates; retries only ride out a resume landing between
  attempts.
- `cron.test.ts`: +2 tests (transient connect failure in prune path and in sweep path).
- Verified: `cron.test.ts` + `db/` → 25 tests pass.

### CP3 — Queue never ACKs DB infrastructure outages — VERIFIED
- `db/db-retry.ts`: added `isDbConnectFailure()` — walks the cause chain matching
  "error connecting to database" / "the operation was aborted due to timeout".
- `jobs/queue-handler.ts`: when the app retry cap is reached BUT the failure is a DB
  connect failure, `message.retry({ delaySeconds: 300 })` instead of `message.ack()` —
  bounded by the queue's own `max_retries = 50` (wrangler.toml). Non-infra failures keep
  the old ack-at-cap behavior.
- Tests: +2 in `queue-handler.test.ts` (direct NeonDbError at attempt 10; wrapped
  ReviewFailurePersistenceError with Neon cause), +4 in `db-resilience.test.ts`.
- Verified: queue-handler + db suites → 37 tests pass.

### CP4 — Full suite + typecheck — VERIFIED
- `npm test -w worker` → 49 files / 454 tests pass (baseline was 48/445).
- `npm run build -w worker` (tsc) → clean.

## Rollback rule (per verify-before-iterate)

Any stage that failed verification would have been reverted (`git restore` the stage's
files) and re-implemented from the last known-good state. No stage failed; the working
tree additionally carries a pre-existing uncommitted `worker/wrangler.toml` diff
(review-quality LLM flags) that is NOT part of this fix and was left untouched.

## Files changed by this fix

- worker/src/db/client.ts (+DB_REQUEST_TIMEOUT_MS, createDbRequestSignal)
- worker/src/db/client.test.ts (new)
- worker/src/db/db-retry.ts (+isDbConnectFailure)
- worker/src/db/db-resilience.test.ts (+4 tests)
- worker/src/cron.ts (+CRON_DB_RETRY_OPTS, wrapped all DB calls)
- worker/src/cron.test.ts (+2 tests)
- worker/src/jobs/queue-handler.ts (+infra-outage retry policy)
- worker/src/jobs/queue-handler.test.ts (+2 tests)
