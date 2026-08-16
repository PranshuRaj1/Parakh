# Parakh Review Quality Diagnosis — Aug 16, 2026

Why the review bot produces noisy, low-credibility reviews (score 3.8/5 on PR #25
with multiple provably false or junk-rule-derived findings), what the evidence
says, and what to fix.

## Symptom

The Aug 16 review of `feat/threaded-comment-replies` (range `9ca5c21 → fb6f9e8`)
returned 11 findings — 4 MEDIUM, 7 LOW. At least 4 are demonstrably false or
derived from junk rules in the memory bank:

| Finding | Verdict | Evidence |
|---|---|---|
| "`fullRepo` is not used anywhere in the function" (correction.ts:76) | **False** | Used at `worker/src/jobs/correction.ts:87` (`repo: fullRepo`) and `:98` (log line) |
| "`postAnchoredFindings` used without checking if it's a hex-coded value" (review.ts:27) | **Nonsense** | No hex-related rule or code exists anywhere except webhook signature verification (`worker/src/webhook/verify.ts`) |
| "Import of CommentAnalysis not checked against any active coding rules" (client.ts:41) | **Nonsense** | No such rule exists; imports are resolved by the bundler/typechecker |
| "`classifyIntent` changed return type — ensure all call sites are updated" (client.ts:394) | **Stale/fabricated** | Repo typechecks and 335+ tests pass; call sites were updated in the same branch |
| "`await params` is unnecessary" (retry route, PR #24 review) | **False** | Next.js App Router types `params` as `Promise` — the await is required |

The old "0/5 early review" era produced the same pattern: "FailureDetail lacks a
`canManage` prop" (prop existed), "Content-Type header missing" (header present),
"await params unnecessary" (required by the framework). The mechanism, not luck,
produces this.

## Root causes (grounded in code + production data)

### 1. The memory bank accepts junk as enforceable standards

Production `rules` table for `PranshuRaj1/Parakh` (19 ACTIVE rules), most recent
first:

```
[instruction/normal] remember: never suggest adding node-fetch imports — fetch/Response are globals on Node 18+ under Vitest
[standard/normal]    remember this <entire rebuttal about cron.ts DATABASE_URL, multi-paragraph>
[standard/normal]    we use hex coding so remember that
[instruction/normal] Do not flag GitHub Actions workflow files for missing error handling or retries...
[standard/high]      we use CF_API_TOKEN, CF_ACCOUNT_ID as secret names just for convention
[standard/high]      remember this <entire rebuttal about queue-handler.ts scope, with code block>
[instruction/normal] stop flagging exported helpers that are "only used within this module"
[instruction/normal] never raise "returning an empty object" API suggestions
[instruction/normal] don't flag awaiting a flush whose errors are handled internally
[instruction/normal] stop flagging "mock reset" and "fresh vi.fn()" details in tests
[instruction/normal] stop flagging "URL length limits" on our Redis client
[instruction/high]   never raise "without prior validation" or "used without validation" findings
[instruction/normal] stop flagging "cast directly to 'uuid'" findings
[standard/high]      always validate untrusted input before using it
[instruction/normal] please stop flagging "could be more descriptive" naming nits
[instruction/normal] never raise "magic number" findings
[instruction/normal] please don't flag "unused parameter" findings
[instruction/normal] stop flagging "definite assignment assertions"
[instruction/normal] @parakh verify: Please stop flagging "No newline at the end of the file"
```

**Smoking gun:** the "(rule violation)" finding about a "hex-coded value" is the
model faithfully enforcing `[standard] "we use hex coding so remember that"` —
a casual chat one-liner stored as an ACTIVE coding standard. The import finding
is the same mechanism against the import-related rules.

**Where junk enters:**
- `worker/src/jobs/comment-response.ts:144-189` (CORRECTION branch) saves
  extracted rule bodies **verbatim, status ACTIVE, zero validation**.
- The fallback at `comment-response.ts:148-155` saves the **entire stripped
  comment** as a rule whenever extraction returns zero rules ("never lost").
- Any reply with forward-looking phrasing ("remember this", "we use X", "stop
  flagging Y") is classified CORRECTION even when it is really a rebuttal of a
  single finding — so rebuttals become standards.
- Dashboard manual rule creation (`CreateRuleForm` → `/api/rules`) has no gate
  either.

### 2. Findings are unverified LLM assertions over 3-line-context hunks

`fetchDiff`/`fetchDiffPinned` (`worker/src/github/api.ts:60-104`) request
`application/vnd.github.diff` — a unified diff with 3 context lines. The model
then asserts whole-file facts ("variable unused", "prop missing", "call sites
not updated") that are unverifiable from hunks and occasionally wrong. There is
**no** grep/AST/typecheck verification layer between model output and posting.

### 3. Severity is model-assigned with no deterministic cap for cosmetic findings

"Consider extracting a function" and "add a comment explaining MAX_REPLY_DEPTH"
were rated MEDIUM. Cosmetic families have no deterministic LOW/omit cap, so they
hit the saturated MEDIUM penalty curve (up to 1.5 points).

### 4. The "What NOT to Flag" section is ineffective and suppression is minimal

`buildReviewPrompt` (`worker/src/gemini/prompts.ts:70-82`) bans rename nits and
"comment could be clearer" commentary, but the model ignores it — the review
contains rename/documentation/extraction suggestions anyway. The deterministic
filter `BUILTIN_SUPPRESSED_PATTERNS` (`worker/src/jobs/review.ts:188-190`)
covers **only** EOF-newline. Instruction rules are skipped from enforcement
(`resolveReviewResult` at review.ts:251) yet the model still raises their
targets ("used without validation", "could be more descriptive").

### 5. Scoring is correct — and amplifies the noise

`3.8/5 = 5 − sat₄(MEDIUM) − sat₇(LOW)` from `shared/src/scoring.ts`. The score
is honestly computed from garbage findings, so fixing finding quality fixes
scores automatically.

## Recommended fixes (priority order)

1. **Rule-intake quality gate** (`comment-response.ts`, correction flow)
   - Reject rebuttals/chat text as standards: >N-word bodies, "remember this",
     "not true as stated" prefixes, pasted code blocks → treat as
     EXPLANATION/DISMISSAL, never CORRECTION.
   - Require actionable imperative standards; land new rules as SUGGESTED and
     auto-activate only after repeat evidence or dashboard approval.
2. **Grounding/verification pass** before posting findings
   - For each cited file:line, fetch the full file (or the file at head SHA)
     and/or run deterministic checks (unused var via AST/grep, prop declaration
     presence, header presence). Unverifiable claims → downgrade or drop.
3. **Deterministic severity caps** — cosmetic families (add-comment, rename,
   extract-function, document-more) mapped to LOW or omitted by pattern match.
4. **Extend `BUILTIN_SUPPRESSED_PATTERNS`** with the cosmetic + "used without
   validation"/"could be more descriptive" families.
5. **Stricter intent disambiguation** — explanatory rebuttals default to
   EXPLANATION/DISMISSAL unless a genuinely new imperative standard is present;
   never learn bot-directed meta-instructions ("verify before reporting") as
   repo standards.
6. **Junk-rule sweep** — audit the 19 production rules; demote the two
   "remember this" rebuttals, the hex rule, and convention rules to INACTIVE;
   start logging dropped-finding stats to measure noise.

## Verification of the diagnosis

- `git grep -n fullRepo worker/src/jobs/correction.ts` → used at lines 87, 98.
- `git grep -ni hex worker/src` → only `webhook/verify.ts` (signature hex).
- `git show fb6f9e8 --stat` → reviewed "range" maps to the full 7-commit PR;
  range labeling is honest; findings are the problem, not the range.
- `shared/src/scoring.ts` `computeScore` reproduces 3.8 exactly from the
  finding counts (arithmetic verified).
- Production `rules` table queried read-only (bodies printed, credentials
  never logged).