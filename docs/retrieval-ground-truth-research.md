# Retrieval and Ground Truth Research

Research date: 2026-09-06

## Scope

The target is a small evaluation corpus of 15 to 100 GitHub pull requests that provides:

- changed files and review-time commit boundaries;
- related unchanged repository context files, ideally retrievable from pinned snapshots;
- localized, defensible gold defects rather than only generic review comments;
- clear licensing and provenance suitable for use in this repository.

The repository is primarily TypeScript, with a Cloudflare Worker, shared TypeScript packages, database code, and a Next.js evaluation dashboard. A multilingual corpus with strong JavaScript or TypeScript coverage is therefore preferable, but repository-level context is more important than language breadth alone.

## Comparison

| Dataset or benchmark | Evidence and context | Gold-defect quality | Small-corpus suitability | Licensing and provenance | Assessment |
|---|---|---|---|---|---|
| [Code Review Bench](https://github.com/withmartian/code-review-benchmark) | 50 fixed PRs from Sentry, Grafana, Cal.com, Discourse, and Keycloak. The benchmark publishes PRs, commits, evaluation code, and golden comments. The pinned repositories and commit pairs can be used to retrieve changed files and any related unchanged files. | 173 human-verified golden comments with severity and category labels. The benchmark uses semantic matching against curated comments. | Excellent. It is already the target size for a 50-case eval and can be reduced to 15 to 30 cases by repository or language. | Benchmark repository is MIT. The reviewed source comes from separate upstream repositories, so each upstream license and notice must be preserved. | Best default for this repository because it includes TypeScript through Cal.com and has a practical 50-PR harness. |
| [SWE-CARE / CodeFuse-CR-Bench](https://github.com/inclusionAI/SWE-CARE) | Repository-level Python benchmark. The pipeline supports no context, oracle files, BM25-retrieved files, or all files. The paper reports 601 instances from 70 Python projects with issue, PR, and repository-state information. | Reference defects and review classifications are available through the dataset and evaluation harness. Some metadata is produced with LLM assistance, so defect labels should be audited before treating them as strict gold. | Good if a Python-only slice is acceptable. Sampling 15 to 100 is straightforward. | The GitHub repository and harness are Apache-2.0. The dataset and every upstream project need separate license review before copying source snapshots. | Strong methodology for testing retrieval of unchanged context, but a poor primary fit for this TypeScript-heavy repository. |
| [AACR-Bench](https://github.com/alibaba/aacr-bench) | 200 real PRs from 50 open-source projects across 10 languages. It explicitly preserves complete repository context, PR metadata, cross-file references, and line-level comment locations. | 2,145 review comments, with defect, security, maintainability, and performance categories. Annotation combines human review, LLM enhancement, and three rounds of expert cross-validation. | Excellent. The repository includes conversion and evaluation code, and its data can be sampled to 15 to 100 cases with a fixed seed. | Repository is Apache-2.0. The source repositories remain independently licensed and may include attribution or redistribution restrictions. | Best multilingual source for a new repo-specific subset, provided the selected cases have suitable JavaScript or TypeScript coverage. |
| [CloudAEye C/C++ Code Review Benchmark](https://github.com/CloudAEye/c_cpp_benchmark) | 16 commit-pinned PRs from C and C++ projects. Each case records exact base and head SHAs, allowing retrieval of the full repository state and unchanged context. | 20 localized, human-verified defects, mostly issues raised and fixed during human review. | Excellent for a tiny focused supplement, but too narrow and too small as the main corpus for this repository. | Benchmark repository is MIT. Each upstream C or C++ project has its own license. | Useful only as a systems-language stress set, not a primary dataset for this TypeScript codebase. |

## Related but weaker alternatives

### Microsoft CodeReviewer

[CodeReviewer repository](https://github.com/microsoft/CodeBERT/tree/master/CodeReviewer) and its [Zenodo dataset](https://zenodo.org/)

This is a large, established code-review corpus for quality estimation, comment generation, and code refinement. Its core examples contain an old file, a diff hunk, a review comment, and a refinement target. That makes it useful for training or format experiments, but it is not the strongest choice for this request because it does not natively provide repository-level unchanged context files or a curated set of localized gold defects.

### BugDetectionBench

[BugDetectionBench](https://github.com/moritzWa/BugDetectionBench)

This repository provides scripts and data for scraping GitHub review comments, filtering potential bug reports, and assigning difficulty. It can generate a custom corpus, but the workflow relies on LLM-based filtering and the repository does not present the same mature, reproducible benchmark protocol or explicit licensing clarity as the leading options above. Treat it as a mining starting point, not as ready-made ground truth.

## Licensing caveats

The license on a benchmark repository usually covers its scripts, schemas, and annotations. It does not automatically relicense the source code copied or checked out from the underlying GitHub projects.

For any selected case:

1. Preserve the upstream repository URL, commit SHA, license files, and attribution notices.
2. Prefer storing immutable commit references and fetching source on demand instead of redistributing complete source snapshots.
3. Record the benchmark license separately from every upstream repository license.
4. Check whether review comments, issue text, and generated annotations have separate terms or privacy concerns.
5. Do not assume that Apache-2.0 or MIT on the benchmark wrapper covers third-party source files.

## Recommendation for this repository

Use Code Review Bench as the initial 50-case baseline. Select cases from Cal.com for TypeScript coverage, then add a small number from the other repositories to test language and architecture variation. Store each case as a manifest containing the repository, base SHA, head SHA, changed-file list, gold findings, and retrieval policy. At evaluation time, check out the pinned head commit and allow retrieval of unchanged files from that exact snapshot. This prevents context drift and makes false positives from pre-existing code measurable.

Use AACR-Bench as the second source when broader multilingual and cross-file coverage is needed. Sample only cases whose project language, build setup, and license are compatible with the intended evaluation. Its complete repository context is especially useful for measuring whether retrieval finds relevant unchanged files rather than blindly exposing the entire repository.

Do not use Microsoft CodeReviewer as the primary ground-truth set. Use it only for auxiliary training or smoke tests. Keep CloudAEye as an optional C/C++ supplement if the evaluation later expands beyond the current TypeScript and JavaScript-oriented scope.

### Suggested initial split

| Purpose | Source | Cases |
|---|---|---:|
| Main baseline | Code Review Bench, with Cal.com represented | 30 to 40 |
| Cross-file and multilingual extension | AACR-Bench | 15 to 30 |
| Optional systems stress set | CloudAEye | 0 to 16 |

This produces a practical 45 to 70 case corpus while keeping the gold-label review burden manageable. Before committing to a final benchmark, manually audit every selected finding against the pinned diff and repository state, especially annotations produced with LLM assistance.

## Primary sources

- [Code Review Bench repository](https://github.com/withmartian/code-review-benchmark)
- [Code Review Bench methodology](https://github.com/withmartian/code-review-benchmark/blob/main/methodology/full.md)
- [AACR-Bench repository](https://github.com/alibaba/aacr-bench)
- [AACR-Bench paper](https://arxiv.org/abs/2601.19494)
- [SWE-CARE repository](https://github.com/inclusionAI/SWE-CARE)
- [CodeFuse-CR-Bench paper](https://arxiv.org/abs/2509.14856)
- [CloudAEye C/C++ benchmark](https://github.com/CloudAEye/c_cpp_benchmark)
- [Microsoft CodeReviewer repository](https://github.com/microsoft/CodeBERT/tree/master/CodeReviewer)
- [BugDetectionBench repository](https://github.com/moritzWa/BugDetectionBench)
