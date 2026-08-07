# Greptile Architectural Audit: Knowledge Representation, Memory, and Evolving Coding Standards

**Method note:** This audit is based entirely on public sources — Greptile's documentation (docs.greptile.com / greptile.com/docs), blog, changelog, an Anthropic customer case study, and public discussion (X/Twitter, Hacker News). No private source code, internal design docs, or Greptile engineers were consulted. Every claim below is labeled **[Confirmed]** (stated in a primary Greptile source), **[Inferred]** (a reasonable but unstated conclusion from confirmed facts), or **[Speculation]** (plausible but unsupported). Where documentation is silent, that is stated explicitly rather than filled in.

---

## Part 1 — Executive Summary

Greptile represents "learned" coding standards as **discrete, typed database entities** — not as a knowledge graph, not as raw vector embeddings the user can inspect, and not as free-floating text buried in a prompt. The public MCP API schema is explicit: each learned standard is a `customContext` row with a `type` (`CUSTOM_INSTRUCTION` or `PATTERN`), a `status` (`ACTIVE`, `INACTIVE`, or `SUGGESTED`), a `body` string, `scopes`, `metadata`, and counters (`evidenceCount`, `commentsCount`). This sits alongside a **separate, unrelated** code-structure graph (files/functions/dependencies) used for review context, which Greptile also calls "graph-based" — the two systems should not be conflated, and Greptile's public materials do not describe the rules store itself as a graph.

**Updating** a standard happens through observed signal accumulation (repeated PR comments, 👍/👎 reactions, whether a suggestion was addressed by the next commit) or through explicit CRUD via the dashboard, `.greptile/` config files, `greptile.json`, or the `create_custom_context` MCP tool. There is **no `update_custom_context` tool** and **no `delete_custom_context` tool** documented — only creation and a status flip to `INACTIVE`.

On the **primary question** — does Greptile stop recommending an obsolete convention once the team's practice changes — the public documentation **does not describe a supersession, versioning, or conflict-resolution mechanism**. The system's confirmed behavior is a *suppression* mechanism (stop commenting on a rule type after ~3 ignored instances or a 👎), not a *replacement* mechanism (recognize that Rule B has superseded Rule A and retrieve B instead of A). The `.greptile/` config documentation confirms explicit rules **combine/accumulate by default** across cascading config files and must be manually disabled by ID — the opposite of automatic conflict resolution. No document describes rule ranking when two memories conflict, temporal/recency weighting, freshness decay, or a "supersedes" relationship between rule entities.

This is a real, evidenced gap. A system explicitly designed around versioned memory, rule lifecycle states (proposed → active → deprecated → superseded), and automatic conflict resolution between an old and new standard would be addressing something Greptile has not publicly documented as solved. Whether Greptile solves it *privately* (undocumented internal logic) cannot be determined from public sources — this is called out as unknown throughout, not assumed either way.

---

## Part 2 — Evidence Table

| # | Source | URL | Section | Finding (paraphrased) | Confidence |
|---|--------|-----|---------|------------------------|------------|
| 1 | Greptile Docs | greptile.com/docs/how-greptile-works/memory-and-learning | "How Greptile Learns From Your Team" | Memory is built from patterns in PR comments, replies to Greptile, and 👍/👎 reactions; suggestions evolve from generic to team-specific over a stated multi-week timeline. | Confirmed |
| 2 | Greptile Docs | greptile.com/docs/how-greptile-works/memory-and-learning | "Learning Nitpickiness Levels" | Greptile tracks per-comment-type counters (made/addressed/reactions) and stops making a comment type after it is consistently ignored or downvoted; security/logic issues are never suppressed. | Confirmed |
| 3 | Greptile Docs | greptile.com/docs/how-greptile-works/nitpicks | "Learning Thresholds" | A style comment is suppressed after roughly 3 ignored instances or an explicit 👎; this is described as a diagram/flow, not a numeric guarantee. | Confirmed |
| 4 | Greptile Docs | greptile.com/docs/mcp-v2/custom-context | "Field Reference", "Disable a Pattern" | Learned/explicit standards are typed entities (`CUSTOM_INSTRUCTION` or `PATTERN`) with a `status` field (`ACTIVE`/`INACTIVE`/`SUGGESTED`). There is no delete — only a status change to inactive. | Confirmed |
| 5 | Greptile Docs | greptile.com/docs/mcp-v2/tools | "Custom Context Tools" | Full schema for `list_custom_context`, `get_custom_context`, `search_custom_context`, `create_custom_context`. No `update_custom_context` or `delete_custom_context` tool exists. `search_custom_context` is keyword/text search (`query` string in, matching contexts out) — no documented ranking or recency parameter. | Confirmed |
| 6 | Greptile Docs | greptile.com/docs/mcp-v2/tools | Custom Context response example | Each entity carries `evidenceCount` and `commentsCount` counters and a `createdAt` timestamp; no `updatedAt`, `version`, `supersedes`, or `deprecatedAt` field appears in any documented schema. | Confirmed |
| 7 | Greptile Docs | greptile.com/docs/code-review/custom-standards | "Method 1: Dashboard" | Dashboard rules can be created and deleted by org/team admins (a UI-level delete exists here, distinct from the MCP API which has none). | Confirmed |
| 8 | Greptile Docs | greptile.com/docs/code-review/custom-standards | "Suggested Rules (Auto-Learning)" | After ~10 PRs Greptile auto-suggests rules from detected patterns for human approval; duplicate suggestions are a known, unresolved issue the docs tell users to ignore. | Confirmed |
| 9 | Greptile Docs | greptile.com/docs/code-review/greptile-config | "How Settings Merge" | Explicit, per-config-file rules **accumulate**: "parent rules + child rules all apply." Rules are combined, not replaced, when multiple config layers define related content. | Confirmed |
| 10 | Greptile Docs | greptile.com/docs/code-review/greptile-config | "Disabling Inherited Rules" | Removing/overriding an inherited rule requires the parent rule to have an explicit `id`, and the child to list that `id` in `disabledRules`. Rules without an `id` "cannot be selectively disabled." This is a manual, ID-based override mechanism — not automatic contradiction detection. | Confirmed |
| 11 | Greptile Docs | greptile.com/docs/code-review/greptile-config | "Precedence" | Documented precedence order: dashboard defaults → org default rules → root `.greptile/` → intermediate → most specific `.greptile/` → org-enforced rules (which can never be overridden). This governs *config-file* precedence, not *learned-memory* precedence. | Confirmed |
| 12 | Greptile Docs | greptile.com/docs/code-review/custom-standards | Warning box | Dashboard rules and repo-level config (`.greptile/`/`greptile.json`) are stated to be **separate systems** that don't sync; when both exist, repo-level config wins, and within repo-level config `.greptile/` beats `greptile.json`. | Confirmed |
| 13 | Greptile Docs | greptile.com/docs/how-greptile-works/graph-based-codebase-context | Full page | The "graph" Greptile builds is a **code-structure graph** — files, functions, imports, call relationships — used for review context (impact analysis, pattern consistency across similar functions). It is not described anywhere as storing or versioning coding-standard rules. | Confirmed |
| 14 | Greptile Docs | greptile.com/docs/system-architecture | "Storage" | Self-hosted architecture stores repository metadata/summaries, code embeddings (via pgvector), review history, and settings all in one PostgreSQL instance. No separate graph database (e.g., Neo4j) or dedicated "rules graph" service is listed among the documented services. | Confirmed |
| 15 | Greptile Docs | greptile.com/docs/system-architecture | "Core Services" / "Background Workers" | Named services include `greptile-indexer-chunker`, `greptile-indexer-summarizer`, `greptile-reviews`, `greptile-llmproxy`, `greptile-jobs`. No service is named for rule lifecycle, memory versioning, or conflict resolution. | Confirmed |
| 16 | Greptile Blog | greptile.com/blog/semantic-codebase-search (also mirrored at /blog/semantic) | Full post | Describes Greptile's code-search retrieval research: chunking granularity (function-level beats file-level), translating code to natural language before embedding, and cosine-similarity retrieval. This addresses **code** retrieval quality, not standards/rule retrieval or conflict handling. | Confirmed |
| 17 | Greptile Blog | greptile.com/blog/greptile-v3-agentic-code-review | Architecture narrative | Describes the shift from a fixed v2 review flowchart to an agentic v3/v4 workflow that can act on new information mid-review, addressing rigidity in the *review* pipeline — not the memory-conflict problem. | Confirmed |
| 18 | Greptile Blog | greptile.com/blog/greptile-update (Daksh Gupta, 2025-05-30) | "1. Long-term memory" | Original launch announcement of the memory system; example given is purely additive ("if many team members comment X, Greptile learns X and starts commenting it too"). No example or mention of a standard being *replaced*. | Confirmed |
| 19 | Anthropic/Claude Customer Case Study | claude.com/customers/greptile | "Greptile uses Claude for multi-hop code investigation" | A dedicated Claude Agent SDK sub-agent handles "memory retrieval," pulling from a bank including expressed coding standards, learned codebase idiosyncrasies, and doc/CLAUDE.md/cursor-rules context. Confirms memory retrieval is agentic/tool-based, not a single vector lookup. No mention of conflict resolution, versioning, or recency logic in retrieval. | Confirmed |
| 20 | Greptile Docs | greptile.com/docs/code-review/training-the-learning-system | "Using Reactions" table | 👍 = "make more like this," 👎 = "stop making these," no reaction = "neutral, lower priority over time" — the only documented recency-adjacent signal (decay of *un-reacted* comments), and it applies to comment types/style preferences, not to standards contradiction. | Confirmed |
| 21 | Greptile Changelog | greptile.com/docs/changelog | Nov 24, 2025 entry | "Rule Optimization" — rules can be AI-generated/refined from the custom-context dashboard. No changelog entry (current or historical, as far as searched) announces rule versioning, supersession, or conflict resolution as a feature. | Confirmed (absence noted) |
| 22 | Hacker News discussion | news.ycombinator.com/item?id=46777079 | User comment, Jan 2026 | An external user reports Greptile felt like "pure noise" over 3 PRs and unfavorably compares it to a competitor's "learnings" feature for not repeating comments on intentional patterns. This is anecdotal, third-party, and does not specifically describe a standard-supersession failure — but it is evidence that noise/relevance complaints exist post-launch of the memory system. | Confirmed (as an anecdote) — the underlying cause is Speculation |

---

## Part 3 — Architecture Reconstruction

**Confirmed components:**
- A code-structure graph (nodes: directories/files/functions/classes/variables; edges: calls, imports, dependency, usage) built at indexing time and queried during review for impact analysis and pattern consistency. [Doc 13]
- A separate `customContext` entity store (coding standards / patterns), reachable via REST-backed MCP tools, with fields `id`, `type`, `body`, `status`, `scopes`, `metadata`, `evidenceCount`, `commentsCount`, `createdAt`. [Doc 4, 5, 6]
- A signal-aggregation layer that watches PR comment threads, developer replies to Greptile, thumbs reactions, and first/last-commit diffs to infer whether a suggestion "landed," feeding counters that gate whether a comment type keeps firing. [Doc 1, 2, 3]
- An agentic review pipeline (v3/v4, rebuilt on the Claude Agent SDK) with a dedicated memory-retrieval sub-agent, distinct sub-agents/tools for codebase investigation (git history, similar-function search), and hook-based determinism guarantees (e.g., every changed file gets examined). [Doc 17, 19]
- Storage: PostgreSQL with pgvector for embeddings; no separate graph database is named. [Doc 14, 15]
- Explicit-rule configuration with a documented, deterministic precedence/merge model across dashboard, org defaults, and cascading `.greptile/`/`greptile.json` files, including manual ID-based rule disabling. [Doc 9, 10, 11, 12]

**Inferred (not directly stated, but a reasonable reading of confirmed facts):**
- The `customContext` "search" is most likely keyword/full-text search rather than semantic-vector search, since the documented tool signature is `search_custom_context(query, limit)` with no embedding or similarity-score field in the response — contrast this with the code-search blog posts, which are explicitly about vector embeddings. **[Inferred]**
- Because there is no `update_custom_context` tool, if the auto-learning system needs to "correct" a standard (e.g., raise/lower confidence, change scope), it most likely does so by writing a **new** `customContext` row and/or mutating `status`/`evidenceCount` via an internal (non-MCP-exposed) path, rather than an atomic update. **[Inferred]**
- The 👎-driven suppression counters described for nitpicks (semicolons, import order) are likely implemented as the same counter mechanism (`evidenceCount`/`commentsCount` plus reaction logs) that backs `customContext`, since both are described adjacent to each other in the docs and both gate whether a comment type fires — but the docs never explicitly state they share a table. **[Inferred]**

**Unknown / cannot be determined from public information:**
- Whether contradictory `CUSTOM_INSTRUCTION` entities (e.g., one body text saying "use Redux," another saying "use Zustand") can coexist as two `ACTIVE` rows, and if so, what happens at retrieval/prompt-assembly time when both match the same file scope. **[Unknown]**
- Whether the memory-retrieval sub-agent described in the Claude case study applies any recency weighting, decay function, or LLM-based "is this still true?" check before including a memory in context. **[Unknown]**
- Exact retrieval algorithm for `search_custom_context` (BM25? substring? embedding?) and whether `list_custom_context`/retrieval at review time is scoped-filter-only or also similarity-ranked. **[Unknown]**
- Whether `evidenceCount` incrementing over time functions as an implicit "confidence" score that could, in principle, be used to deprioritize a rule whose supporting PR comments have gone stale — no documentation describes this counter being used for anything beyond display. **[Unknown]**

---

## Part 4 — Memory Lifecycle Analysis

| Lifecycle stage | What is documented | Confidence |
|---|---|---|
| **Creation** | Three paths: (1) automatic inference from repeated PR comment patterns, surfaced as a `SUGGESTED` status entity after ~10 PRs for human approval [Doc 8]; (2) explicit human authoring via dashboard "Add Context," `.greptile/rules.md`/`config.json`, or `greptile.json` [Doc 7, 9]; (3) explicit creation via the `create_custom_context` MCP tool, callable from an IDE/agent [Doc 4, 5]. | Confirmed |
| **Update** | For learned (implicit) preferences: counters (`made`, `addressed`, `reactions`) accumulate with each new signal, gradually shifting whether a comment type fires — this is a continuous, additive statistical update, not a discrete "edit." For explicit `customContext` rows: no update tool is documented; the only state transition exposed via MCP is `ACTIVE → INACTIVE`. Dashboard-created rules can presumably be edited in the UI (edit affordance implied by admin permissions table) but this is not walked through step-by-step in the docs. | Confirmed (learned); Inferred (explicit-rule editing via UI) |
| **Retrieval** | At review time, a dedicated memory-retrieval sub-agent (Agent SDK) pulls from the standards/idiosyncrasies/doc-file bank as one of several tools available to the review agent [Doc 19]. Scope matching (`AND`/`OR` conditions over fields like `repository`, `filepath`) determines which stored rules are eligible for a given file [Doc 5]. No ranking, similarity-scoring, or recency-weighting step is documented for this retrieval. | Confirmed (existence); Unknown (ranking/scoring logic) |
| **Conflict resolution** | Not documented for learned/implicit memory. For *explicit config* rules, the only documented conflict-handling is structural precedence (dashboard vs. repo-config vs. org-enforced) and manual ID-based disabling within cascading `.greptile/` folders — this resolves *scope* conflicts (which file wins) and *authority* conflicts (who can override whom), not *semantic* conflicts (rule A and rule B say opposite things about the same practice). | Confirmed (absent for semantic conflicts) |
| **Replacement / supersession** | No `supersedes`, `replaces`, `deprecatedBy`, or similar relationship field appears in any documented schema. No blog post, changelog entry, or doc page describes automatically retiring an old standard when a new, contradictory one is learned. | Confirmed (absent) |
| **Deletion** | Dashboard: admins can delete org- or team-scoped rules [Doc 7]. MCP API: explicitly no delete tool — disabling (`status: INACTIVE`) is the documented alternative [Doc 4, 5]. | Confirmed |
| **Expiration / staleness** | No TTL, decay function, or "last validated" timestamp is documented on any `customContext` entity. The closest analog is the *nitpick suppression* counter, which reduces a comment type's firing frequency after repeated non-engagement — but this measures developer disengagement with a *comment*, not the age or continued validity of the underlying *standard*. | Confirmed (absent) |
| **Versioning** | Not documented at the memory/rule level. Versioning language does appear, but only for (a) `.greptile/` **config files**, which are version-controlled because they live in the repo and go through normal git history/PR review [Doc "Configuration Methods" table], and (b) the product itself (`greptile.json v3`, "Greptile v4" review engine) [Changelog]. Neither is rule/standard versioning in the sense of "track how this specific standard changed over time." | Confirmed (absent at the rule-entity level) |

---

## Part 5 — Gaps (documentation silence = research opportunity)

1. **Semantic contradiction detection.** No mechanism described for recognizing that two stored standards (or a stored standard vs. a new pattern of PR comments) are mutually exclusive rather than merely unrelated.
2. **Update semantics for learned memory.** The docs describe counters going up; they never describe a counter (or a rule) going down, being corrected, or being merged with a newer, more specific rule.
3. **Retrieval ranking algorithm.** `search_custom_context` and in-review retrieval have no documented scoring function — unclear if it's keyword match, embedding similarity, recency, evidence count, or some hybrid.
4. **Confidence/evidence semantics.** `evidenceCount` and `commentsCount` exist and are returned by the API, but no documentation explains how (or whether) they influence which rule wins when two apply, or whether they decay.
5. **Cross-repo / pattern-repository memory conflicts.** `patternRepositories` (cross-repo context) is documented as a config option, but not how conflicting standards from a shared pattern repo vs. a local repo are reconciled.
6. **Suggested-rule deduplication.** The docs openly admit duplicate suggested rules are "a known issue" users must manually ignore — implying no automated dedup/merge/supersession logic exists yet, but the docs don't explain the underlying cause or a roadmap.
7. **Relationship between the code-structure graph and the standards store.** Both are called "graph-based" or graph-adjacent in marketing copy, but the docs describe them as architecturally separate; no page explains whether the review agent ever cross-references the code graph (e.g., "80% of functions now use pattern B") to infer a standard has changed.
8. **Self-hosted vs. cloud parity.** The system architecture page describes only the storage/services layer, not whether memory-related logic (suppression thresholds, suggestion generation) differs between self-hosted and cloud deployments.
9. **Audit trail.** No documented way to see *why* a given standard is active, when it was last triggered, or its edit history (aside from `linkedComments`, which shows PRs where it fired, not how the rule's text/scope changed over time).

---

## Part 6 — Comparison: Greptile vs. a Proposed Versioned Organizational Memory / Rule Lifecycle Engine

| Dimension | Greptile (as documented) | Versioned Organizational Memory (proposed) |
|---|---|---|
| Rule representation | Typed entity (`CUSTOM_INSTRUCTION`/`PATTERN`) with status, scope, free-text body | Presumably a first-class entity with explicit versioning fields |
| Update model | Counter accumulation (learned) or create/disable (explicit); no update-in-place API | Explicit update with history, per the proposal's framing |
| Conflict handling | Structural precedence for config *sources* only; no semantic conflict detection between rule *contents* | Rule supersession / lifecycle states, per the proposal's framing |
| Temporal reasoning | None documented (no recency weighting, no staleness decay on standards) | Presumably time-aware, per the proposal's framing |
| Deletion/archival | Soft-disable only (no delete via API; dashboard delete exists) | Presumably explicit archival/versioning, per the proposal's framing |

**Advantages of Greptile's current (documented) approach:** simplicity of the data model, low friction for teams that mostly *add* standards rather than reverse them, and a working, shipped auto-suggestion loop from real PR behavior — something a purely-manual rule engine would lack unless it also built comment-mining.

**Disadvantages / risk exposed by this audit:** if a team's convention genuinely reverses (the prompt's per-test-cleanup → global-cleanup example), the additive/counter-based design has no documented path to make the old convention stop surfacing other than a human noticing and manually disabling it by ID (which only works for explicit `.greptile/` rules that were given an `id` up front) or manually setting a learned/dashboard entity to `INACTIVE`. For auto-learned patterns inferred purely from comment history, there is no documented user-facing control to invalidate a specific inferred pattern at all beyond the general nitpick-suppression counters, which are about *comment fatigue*, not *standard correctness*.

**Is a Versioned Organizational Memory / Rule Lifecycle Engine genuinely novel relative to Greptile specifically?** Based on what Greptile has published, **yes, on the specific dimension of standard supersession, versioning, and semantic conflict resolution** — this is a documented gap, not an assumption. It would not be novel relative to the *general* software category (config-management systems, feature-flag lifecycle tools, and some competing AI-review products advertise "learnings" or memory features whose internals are equally undocumented; this audit did not evaluate competitors' public docs and makes no comparative claim about them). It is also worth being honest that "not publicly documented" is not proof of "does not exist" — Greptile could have unpublished internal logic for this exact problem, and the case-study description of an agentic memory-retrieval sub-agent leaves room for undocumented reasoning steps (an LLM sub-agent *could* in principle notice a contradiction at retrieval time even without an explicit versioning schema). That possibility is called out here rather than dismissed.

---

## Part 7 — Questions for Greptile Engineers

1. When `search_custom_context` or in-review memory retrieval returns multiple `ACTIVE` entries whose `body` text is semantically contradictory (not just overlapping in scope), what determines which one is surfaced in a review comment — most recent `createdAt`, highest `evidenceCount`, order of insertion, or does the review-time LLM see all of them and adjudicate itself?
2. Is there an internal (non-MCP-exposed) `update_custom_context` path, or does every correction to a learned standard require creating a net-new row and leaving the old row's status untouched?
3. Does `evidenceCount` ever decrease, decay, or get reset — and if so, on what trigger?
4. When the auto-learning pipeline infers a new `SUGGESTED` pattern that contradicts an existing `ACTIVE` `CUSTOM_INSTRUCTION`, is that contradiction detected before surfacing the suggestion, or does the human reviewer have to notice it during approval?
5. Is `search_custom_context` implemented as lexical (BM25/substring) search, embedding similarity, or a hybrid — and does it use the same pgvector infrastructure documented for code embeddings?
6. Does the memory-retrieval sub-agent described in the Claude Agent SDK case study perform any reasoning step equivalent to "is this stored standard still consistent with recent PR behavior?" before injecting it into review context, or is retrieval purely scope-filtered lookup?
7. For teams using both auto-learned memory and `.greptile/` explicit rules, is there any cross-check between the two systems, given the docs describe them as separate and non-syncing?
8. When a rule.md file (free-text markdown) is edited in a PR to explicitly reverse a prior convention, does that edit event feed back into the auto-learning signal store, or is `.greptile/`/`greptile.json` content treated as immutable ground truth uninformed by the same learning loop that processes PR comments?
9. Is there a `linkedMemory` back-reference from newly generated review comments to the specific `customContext` row(s) that triggered them in all cases, or only sometimes (the tools doc shows `linkedMemory: null` in its own example response)?
10. What happens to a `customContext` row's `scopes` when the underlying file/directory structure is refactored (e.g., a monorepo package is renamed or split) — is there any reconciliation, or does the rule silently stop matching?
11. Is nitpick-suppression state (the "ignored 3+ times" counter) stored per-organization, per-repository, or per-directory, and does it reset when a `.greptile/` config for that scope changes?
12. How does the system distinguish "the team stopped caring about this rule" (should suppress) from "the team is mid-migration and violations are expected temporarily" (should keep enforcing, perhaps with a grace period)?
13. Is there a documented or internal maximum on the number of `ACTIVE` `customContext` entities per scope, and if the count grows large, is there any automatic consolidation/summarization step before they're all passed into the review-agent's context?
14. Does the auto-suggestion pipeline (surfacing `SUGGESTED` rules after ~10 PRs) re-run periodically, or is pattern detection continuous — and if periodic, on what cadence?
15. When two `.greptile/` layers in a cascading monorepo define rules with the same semantic content but different wording (not using the `id`/`disabledRules` mechanism), are both passed to the reviewer as separate instructions, and does duplication measurably degrade review quality or cost (token budget)?
16. Is there an audit log of `status` transitions (e.g., who set a rule to `INACTIVE` and when), or does the "Last Applied" timestamp shown in the dashboard only track application, not lifecycle edits?
17. How does the confidence score shown on PR reviews (referenced in third-party discussion) relate, if at all, to `evidenceCount` on the memory entities that contributed to a given review's comments?
18. For self-hosted deployments, does the memory-and-learning subsystem (suggestion generation, suppression counters) run identically to the cloud product, or are any of these features cloud-only?
19. Does the system ever proactively flag to a human ("this rule hasn't matched any code in N months — still valid?") or is all staleness detection currently outsourced to human review of the dashboard?
20. When Jira/Notion/Google Docs context is pulled in via MCP alongside stored `customContext` rules, and the external document contradicts a stored rule (e.g., an updated style guide in Notion), is there any precedence between "context fetched live from an integration" and "context stored as a `customContext` row," or does the review-time LLM simply see both and decide?
21. Is `PATTERN` (vs. `CUSTOM_INSTRUCTION`) type distinguished anywhere in retrieval or ranking logic, or is it purely a categorical label for the dashboard UI?
22. What is the actual trigger condition and detection window for the "first and last commit" comparison used to infer whether a suggestion was addressed — does it account for PRs with many intermediate commits, force-pushes, or squash merges?

---

## Sources Consulted

- greptile.com/docs/how-greptile-works/memory-and-learning
- greptile.com/docs/how-greptile-works/nitpicks
- greptile.com/docs/how-greptile-works/graph-based-codebase-context
- greptile.com/docs/how-greptile-works/custom-rules
- greptile.com/docs/code-review/custom-standards
- greptile.com/docs/code-review/greptile-config
- greptile.com/docs/code-review/training-the-learning-system
- greptile.com/docs/mcp-v2/custom-context
- greptile.com/docs/mcp-v2/tools
- greptile.com/docs/system-architecture
- greptile.com/docs/changelog
- greptile.com/docs/llms.txt (documentation index)
- greptile.com/blog/greptile-update (Daksh Gupta, "Greptile's Biggest Update Yet," 2025-05-30)
- greptile.com/blog/semantic-codebase-search / greptile.com/blog/semantic
- greptile.com/blog/greptile-v3-agentic-code-review
- greptile.com/blog/greptile-2
- claude.com/customers/greptile (Anthropic Claude Agent SDK case study)
- news.ycombinator.com/item?id=46777079 (third-party user discussion)
- x.com/dakshgup (founder/CEO public posts, corroborating the memory launch)