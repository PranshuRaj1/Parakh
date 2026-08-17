# PR #24 Review — Memory Replies for False Positives

Paste each draft as a reply to the corresponding @parakh review comment on PR #24. The bot learns from these corrections and stops re-reporting the same false positives.

## Drafts

### 1. HIGH — `FailureDetail` passed unknown `canManage` prop (pulls page)
> @parakh this finding is a false positive. FailureDetail declares the prop: `export function FailureDetail({ reviewId, canManage = true }: { reviewId: string; canManage?: boolean })` at `dashboard/src/components/FailureDetail.tsx`. No type or runtime error. Check the props interface before reporting a type error.

### 2. MEDIUM — `retry/route.ts` env vars read without validation
> @parakh false positive. `dashboard/src/app/api/reviews/[id]/retry/route.ts` already validates both WORKER_API_URL and WORKER_API_SECRET and returns 500 with a clear error when missing. Verify the code at the head commit before reporting.

### 3. MEDIUM — `retry/route.ts` response not inspected
> @parakh false positive. The retry route already checks `response.ok` and passes through non-2xx statuses: `if (!response.ok) { return NextResponse.json(data, { status: response.status }) }`. The review snapshot did not reflect the head commit.

### 4. MEDIUM — `rules/route.ts` missing Content-Type header
> @parakh false positive. The proxy fetch at `dashboard/src/app/api/rules/route.ts` already sends `Content-Type: application/json` alongside the Bearer token. Review the file at the head commit.

### 5. MEDIUM — `CreateRuleForm` never renders error state
> @parakh false positive. CreateRuleForm renders the error banner when set: `{error && <div className="mb-4 text-sm text-[#ffdad6] bg-[#93000a]/20 ...">{error}</div>}`. The catch block sets it and the UI shows it. 

### 6. LOW — `await params` is unnecessary in retry route
> @parakh false positive. In Next.js App Router the route handler signature is `{ params }: { params: Promise<{ id: string }> }` — params is a Promise and must be awaited. Removing it would be a type error.

### 7. HIGH ×2 — `memory/page.tsx` unguarded `getUserRepos` / `requireRepoPermission`
> @parakh stale. `githubFetch` in `dashboard/src/lib/repo-auth.ts` already catches network and parse errors and returns `{ ok: false, data: null }`, so `getUserRepos` and `requireRepoPermission` cannot reject. The page also wraps both calls in try/catch as belt-and-braces now. Don't flag missing try/catch around functions that provably don't throw.

## Fixed in this round (no reply needed)

- CRITICAL `auth.ts` open sign-in when `DASHBOARD_ALLOWED_LOGINS` unset → now fail-closed
- MEDIUM `auth.ts` empty-string client credentials → fail-fast at module load
- MEDIUM `repo-auth.ts` cache can exceed `CACHE_MAX_ENTRIES` → prune expired, then oldest
- LOW `ReviewStepper.tsx` array index key → stable `log.at:log.code` key
- MEDIUM `page.tsx` load errors silent → error banner rendered
