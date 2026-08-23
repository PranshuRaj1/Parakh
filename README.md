# Parakh

An AI code-review bot for GitHub that learns from your feedback. Parakh reviews pull requests, scores them out of 5, posts the review as a GitHub PR review with 👍 / 👎 reactions, and remembers your corrections so it stops repeating the same nags.

## What is Parakh

Parakh is a GitHub App built on Cloudflare Workers. When you open a PR or mention `@parakh` in a comment, it sends your diff to Gemini, turns the model output into structured findings, scores the PR, and posts the result. Correct it in a comment and it saves that correction as a rule in its memory, then enforces the rule on future reviews. Tell it to stop flagging something and it stops, deterministically, not just by hoping the model behaves.

This README is the entry point. For the deep story of how the pipeline evolved and why it looks the way it does, read [architecture.md](architecture.md). For the competitive analysis of how Greptile's memory works, read [greptile-architecture.md](greptile-architecture.md).

## System at a glance

Parakh is one Worker with three entry points, all owned by the same `parakh-worker` deployable:

```
GitHub webhook ──► fetch handler ──► enqueue ──►┐
dashboard API  ──► fetch handler ──► enqueue ──►┤
cron (every min)──► scheduled handler ─────────►┤
                                               ▼
                                   parakh-watchdog queue
                                    (max_retries 50)
                                               ▼
                                       queue handler
                                    REVIEW / COMMENT_RESPONSE
                                    / CONTRADICTION jobs
                                               ▼
                        ┌───────────────────────────────────────┐
                        │ Neon Postgres   durable truth, rules,  │
                        │                 reviews, step events   │
                        │ Upstash Redis   checkpoints, locks,    │
                        │                 key cooldowns, tokens  │
                        │ Gemini → Groq → CF AI → OpenRouter     │
                        │                 LLM provider chain     │
                        │ GitHub API      reviews, comments,     │
                        │                 reactions              │
                        └───────────────────────────────────────┘
```

The three invocation contexts:

- `fetch`: the webhook endpoint (`POST /webhook`) and the dashboard APIs (`POST /api/rules`, `POST /api/reviews/:id/retry`). Fast on purpose. It verifies the signature, inserts a row, and enqueues. It never does review work itself.
- `queue`: the `parakh-watchdog` queue consumer runs every job in resumable slices. This is where reviews, comment intents, and contradiction checks actually run.
- `scheduled`: a minutely cron is the watchdog. It sweeps stalled reviews, prunes expired reasoning, and auto-resumes daily-quota-paused reviews.

## Repo layout

This is an npm workspaces monorepo with three packages.

| Package | What it is |
|---|---|
| `shared/` | Type-only package: entity types, severity taxonomy, scoring, constants. Imported by worker and dashboard so they stay in sync. |
| `worker/` | The Cloudflare Worker: webhook, queue jobs, LLM provider chain, DB and Redis access, cron. |
| `dashboard/` | Next.js app: review timeline, reasoning viewer, rule memory view, rule creation. |

Other important paths:

| Path | Purpose |
|---|---|
| `db/schema.ts` | Declarative PostgreSQL schema managed by Drizzle Kit. |
| `.githooks/pre-push` | Runs the pipeline smoke test before every `git push`. |
| `tests/` | Root-level test scaffolding (vitest config lives at the root). |

## How a review flows

**PR opened or reopened:**

```
webhook pull_request.opened
  ├─ post 👀 reaction + "I have seen this PR" comment (synchronous, so the
  │   user sees proof within the 10s ack window)
  ├─ insert reviews row (status QUEUED, SHA pin captured)
  └─ enqueue REVIEW job
```

**A comment mentioning `@parakh`:**

```
webhook issue_comment.created
  └─ enqueue COMMENT_RESPONSE job
       └─ classify intent (Gemini): CORRECTION / EXPLANATION / DISMISSAL
          / QUESTION / REVIEW_REQUEST / GENERAL
            ├─ REVIEW_REQUEST  → trigger a review (or resume one)
            ├─ CORRECTION      → save a rule, reply "Learned" / "Noted"
            ├─ EXPLANATION     → reply "👍 Noted.", save nothing
            ├─ QUESTION        → draft a reply
            └─ GENERAL         → stay silent
```

**The REVIEW job** (one queue delivery equals one resumable slice):

```
acquire Redis lock (fresh heartbeat skips, stale lock is stolen)
load SHA-pinned diff (immutable between deliveries)
start stage events (FETCHING_DIFF, LOADING_RULES, REVIEWING_FILES, ...)
budget = SubrequestBudget(44)
for each batch of files (concurrency 2):
  per file: Gemini review → findings → save per-file state to Redis
  heartbeat + refresh lock + update live pointer
  on budget exceeded → checkpoint and throw, queue redelivers
when all files done:
  finalizeReview: score → post comment → 👍 / 👎 verdict reactions
```

For the full reliability story behind this, see [Reliability model](#reliability-model) and [architecture.md](architecture.md).

## Tech stack and why

| Technology | Why we use it | Trade-off |
|---|---|---|
| Cloudflare Workers | One deployable for webhook, queue, and cron; no servers to manage. | Hard limits shape the design: 50 subrequests per invocation and a 10s webhook ack window. |
| Cloudflare Queues | Lets the webhook enqueue and return immediately instead of doing Gemini work inside the 10s window. `max_retries = 50` so large PRs survive many resumable deliveries. | At-least-once delivery means every job must be idempotent. |
| Cron triggers | The minutely watchdog: sweeps stuck reviews, prunes reasoning, auto-resumes quota-paused reviews. | A Worker cannot run forever, so long-running work is illegal by design. |
| Neon Postgres + pgvector | Serverless HTTP driver (`@neondatabase/serverless`) works on the edge, and pgvector powers the contradiction engine's similarity search over rule embeddings. | Every query costs a subrequest against the 50 cap. |
| Upstash Redis | Stores per-delivery checkpoint state, review locks, LLM key cooldowns, and cached GitHub tokens. Redis backing survives queue redeliveries where an in-memory store would reset. | State is ephemeral and TTL-bound; Redis is not the source of truth. |
| Gemini | Primary LLM: reviews diffs, classifies comment intent and rule priority. | Free-tier quotas are tight, which is why everything else below exists. |
| Groq, Cloudflare Workers AI, OpenRouter | Ordered failover chain. When Gemini exhausts every key, a call falls through to the next configured provider so a quota on one vendor never stalls a review. | Fallbacks are only used on exhaustion, never on plain request errors. |
| GitHub App | Installation tokens and webhooks for PR events, comments, and reviews. | The app's private key is a shared secret any code with it can impersonate, hence the Redis lock. |
| Next.js (dashboard) | App router UI over the same Neon database, plus server routes that call the worker API for writes. | Reads hit Postgres directly; writes route through the worker so the dashboard never touches Gemini. |

## How we switch context

The word "switch" covers three different seams in this system. Each one is a deliberate handoff.

### Execution contexts

The Worker has three handlers and they never share a running process. Work moves between them through three carriers:

- Queue messages carry the *request*: a `REVIEW`, `COMMENT_RESPONSE`, or `CONTRADICTION` job payload.
- Database rows carry the *truth*: the `reviews` row records status, stage, score, and reactions.
- Redis carries the *ephemeral state*: per-file checkpoints, the lock, key cooldowns.

The webhook hands off to the queue because it cannot survive a multi-file Gemini review inside its 10s ack window. The queue hands off to Redis state because a delivery can die at any moment (timeout, subrequest cap) and the next delivery must resume. The cron hands off to the queue when it finds a stuck or quota-paused review, re-enqueueing it with its existing review id.

### LLM provider switching

Every model call goes through `LLMClient`, a facade over an ordered chain: `[LLM_PRIMARY, LLM_FALLBACK, ...every configured provider]`. The defaults are `gemini` then `groq`, with Cloudflare Workers AI and OpenRouter appended when their credentials exist.

A call starts on the primary. It only fails over when the provider throws `AllKeysExhaustedError`, which means every key in that provider's pool is rate-limited, daily-quota'd, or model-unavailable. Plain errors propagate immediately; a failover must never hide a bad request.

Within a pool, keys rotate one by one. A key that hits a rate limit gets parked in Redis for a cooldown, so a queue redelivery that builds a fresh client still skips it. `DailyQuotaExhaustedError` extends `AllKeysExhaustedError`, with two extra behaviors:

- a daily-quota'd key parks for 6 hours, not 60 seconds;
- if the last configured provider is daily-quota'd, the review parks as `PAUSED_DAILY_QUOTA` instead of retry-thrashing, and the cron auto-resumes it after 12 hours (which always crosses the quota reset).

Embeddings follow their own chain: providers without an embedding endpoint (OpenRouter) are skipped, and the first provider that can embed wins.

### Storage and data-layer switching

The same `@parakh/shared` types appear in the worker, the dashboard, and the database, but each store has a distinct role:

| Store | Holds | Because |
|---|---|---|
| Neon Postgres | Rules, reviews, step events, reasoning, file events, relationships | Durable, queryable source of truth the dashboard reads directly. |
| Upstash Redis | Per-delivery checkpoints, locks, key cooldowns, token cache | Fast, transient, survives redelivery, and its TTLs auto-clean abandoned state. |
| Cloudflare Queues | In-flight job messages | The durable carrier between invocation contexts, with retry semantics. |

The rule of thumb: if it must survive a crash, it lives in Postgres. If it only needs to survive a redelivery, it lives in Redis. If it is work still in progress, it lives in the queue.

## Database

Postgres runs on Neon. The desired database structure lives in `db/schema.ts`; apply schema changes before deploying dependent code:

```bash
DATABASE_URL=<neon-url> npm run db:push
```

Drizzle Kit compares the declared schema with the target database and asks for confirmation before applying changes. The existing `db/migrations/` directory remains as historical context and must not receive new migrations. The pgvector extension must already be enabled on a new database before the first push.

Main tables:

| Table | Purpose |
|---|---|
| `rules` | Learned standards. `status` is ACTIVE/SUPERSEDED/INACTIVE. `kind` is `standard` (enforce) or `instruction` (suppress). Holds the `embedding` vector, `scope`, `priority`, supersession FKs, and `evidence_count` / `reinforcement_count` counters. |
| `rule_relationships` | DUPLICATE and REFINEMENT links between rules, written by the contradiction engine. |
| `reviews` | One row per review with score, findings JSON, SHA pin, reaction ids, trigger comment, and status. |
| `repo_settings` | Per-repo overrides such as `reply_mode` and `stuck_timeout_seconds`. |
| `review_step_events` | Append-only log of every pipeline stage: start/end, duration, outcome, error, and reason transitions. This is what makes failures observable. |
| `review_reasoning` | Captured model "thinking" text, auto-pruned after a retention window. |
| `review_file_events` | Per-file telemetry: which file, provider, model, and error when a file review fails. |
| `provider_installations` | Connected code-host accounts (provider, owner) and the repos the app can see — written by `installation` webhooks, read by the dashboard Connect page. |
| `schema_migrations` | Historical record of migrations applied before the schema-push workflow. |

Two pieces worth calling out:

- **Memory as rules**: a correction comment becomes a rule whose body is the comment text, embedded for similarity. The contradiction engine (`findSimilarRules`) compares embeddings via pgvector cosine similarity and classifies the relationship as DUPLICATE, REFINEMENT, CONTRADICTION, or UNRELATED. A contradiction supersedes the old rule.
- **Instruction rules**: a correction with suppression phrasing ("stop flagging X", "never raise Y") is stored as `kind = 'instruction'`. Instruction rules are excluded from the enforceable list, rendered as a `## Suppressed Issues` section in the prompt, and matched deterministically so those findings are dropped regardless of what the model says.

## Reliability model

Parakh's pipeline is built to survive its own platform. The short version:

- **Subrequest budget**: a `SubrequestBudget(44)` counter caps each delivery before Cloudflare's real 50. Hitting it is a checkpoint, not a failure, so the queue redelivers and work resumes.
- **Checkpoint and resume**: per-file state saves to Redis (`completedFiles`, `accumulatedFindings`) plus a SHA-pinned diff mean a redelivery starts from the exact file it left off at.
- **Observable stages**: `review_step_events` turns "reviews fail on big PRs" into "here are the concrete bugs". Keep it.
- **Watchdog**: the cron marks anything stalled past 12 minutes as TIMED_OUT, posts a "reply @parakh review to retry" comment, and frees the lock.
- **Pre-push safety net**: `.githooks/pre-push` runs the pipeline smoke test, which exercises the real webhook → queue → `triggerReview` chain with only leaf dependencies mocked. A broken comment-to-review wiring blocks the push.

The full story of how each of these came to be is in [architecture.md](architecture.md).

## Getting started

Prerequisites: Node 18+, a Cloudflare account, a GitHub App, a Neon database, and an Upstash Redis instance.

```bash
npm install
npm run setup:hooks   # enable the pre-push pipeline smoke test
npm run build         # build all workspaces
```

### Local development

The worker runs with `wrangler dev`:

```bash
cd worker
wrangler dev
```

Secrets live in `worker/.dev.vars` (gitignored). The full list of expected secrets is documented in `worker/wrangler.toml`. Minimum set: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_BOT_USER_ID`, `DATABASE_URL`, `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`, `GEMINI_API_KEY`, `WORKER_API_SECRET`. Optional: `GITHUB_APP_SLUG` (public app slug used to build the dashboard "Connect" link; defaults to `parakh-bot`).

The dashboard runs with `next dev` from `dashboard/` and reads the same `DATABASE_URL`.

### Deploying

1. Push the declared schema first: `DATABASE_URL=<neon-url> npm run db:push` from the repo root.
2. Deploy the worker: `cd worker && npm run deploy`.
3. Verify on the dashboard that the new review reaches COMPLETED.

Incremental rollout is intentionally gated:

1. Keep `INCREMENTAL_REVIEW_ENABLED=false` and `INCREMENTAL_REVIEW_SHADOW=true` while collecting traffic.
2. Run `psql "$DATABASE_URL" -f db/reports/incremental-shadow-gate.sql`.
3. Run `npm run test:baseline` and the incremental planner tests; these verify unchanged output hashes and fixture-labelled ancestry/fallback decisions.
4. Do not enable execution until the report has at least 30 eligible comparisons, returns `shadow_gate_passed=true`, and both test gates pass.
5. Keep push-triggered re-reviews disabled during the manual rollout; use `@parakh review` or `@parakh full review`.

To stop incremental execution, set `INCREMENTAL_REVIEW_ENABLED=false` in `worker/wrangler.toml` and redeploy. Full reviews remain available. To restore an earlier Worker build, run `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`. A Vercel dashboard rollback is independent: run `vercel rollback <deployment-url>` from `dashboard/`.

### Testing

```bash
npm test                # all workspaces (vitest)
npm run test:pipeline   # pre-push smoke test, run automatically on git push
```

## Docs map

| Doc | Covers |
|---|---|
| [architecture.md](architecture.md) | Iteration-by-iteration story of how the review pipeline got here. |
| [greptile-architecture.md](greptile-architecture.md) | Competitive audit of Greptile's memory and rule lifecycle. |
| [dashboard/README.md](dashboard/README.md) | Next.js bootstrap notes. |
