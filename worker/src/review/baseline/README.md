# Current review baseline

This directory freezes Parakh's file-oriented review behavior before semantic
diffing and behavioral grouping change it. It intentionally records current
limitations—such as reviewing the two sides of a cross-file move separately—
instead of fixing them in the baseline foundation.

## Commands

```text
npm run test:baseline       verify the committed golden without network access
npm run baseline:generate   print a candidate golden for inspection
npm run baseline:accept     replace the golden after an intentional change
```

`baseline:accept` is an authoring tool, never a CI step. Review its diff before
committing it. A later pipeline change must either keep the golden unchanged or
explain why each changed fixture is expected.

## What the numbers mean

- `estimatedInputTokens` is the simple `ceil(characters / 4)` estimate, not a
  provider billing total.
- `logicalReviewCalls` counts calls to Parakh's provider-chain facade. Internal
  key rotation and provider fallback are not extra logical reviews.
- `accountedSubrequests` is the Worker's conservative budget counter, not
  Cloudflare's authoritative fetch count.
- Checkpoint count is derived by counting delivery events whose outcome is
  `checkpoint`; a single delivery cannot know the eventual review-wide count.
- `diffHash` is an exact, order-sensitive resume-validation hash. It must not
  be reused as a semantic or cross-PR cache key.

## Safety boundaries

The replay path uses real parsing, filtering, rule resolution, suppression,
scoring, and formatting. Only service leaves are replaced with deterministic
data. The suite stubs `fetch` and fails if replay attempts network access.

Fixture cases are assembled in one test-only TypeScript module. Golden generation
uses Node filesystem APIs and is excluded from the production Worker build.
Runtime telemetry contains counts, hashes,
outcomes, and feature flags—never source, prompts, finding bodies, reasoning, or
credentials.
