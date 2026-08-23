import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

export const rules = pgTable(
  'rules',
  {
    id: uuid().defaultRandom().primaryKey(),
    repo: text().notNull(),
    body: text().notNull(),
    embedding: vector({ dimensions: 768 }),
    status: text().notNull(),
    scope: jsonb().default({}),
    priority: text().notNull().default('normal'),
    supersedes: uuid(),
    supersededBy: uuid('superseded_by'),
    sourcePr: integer('source_pr'),
    evidenceCount: integer('evidence_count').default(0),
    reinforcementCount: integer('reinforcement_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    kind: text().notNull().default('standard'),
    createdBy: text('created_by'),
    mode: text().notNull().default('enforce'),
    patterns: jsonb().notNull().default([]),
  },
  (table) => [
    check('rules_status_check', sql`${table.status} in ('ACTIVE', 'SUPERSEDED', 'INACTIVE', 'PENDING')`),
    check('rules_priority_check', sql`${table.priority} in ('high', 'normal')`),
    check('rules_kind_check', sql`${table.kind} in ('standard', 'instruction')`),
    check('rules_mode_check', sql`${table.mode} in ('enforce', 'suppress')`),
    foreignKey({ name: 'rules_supersedes_fkey', columns: [table.supersedes], foreignColumns: [rules.id] }),
    foreignKey({ name: 'rules_superseded_by_fkey', columns: [table.supersededBy], foreignColumns: [rules.id] }),
    index('idx_rules_repo_status').on(table.repo, table.status),
    index('idx_rules_embedding')
      .using('ivfflat', table.embedding.op('vector_cosine_ops'))
      .with({ lists: 100 }),
    index('idx_rules_kind').on(table.kind).where(sql`${table.kind} = 'instruction'`),
    index('idx_rules_status').on(table.status).where(sql`${table.status} = 'PENDING'`),
  ]
);

export const ruleRelationships = pgTable(
  'rule_relationships',
  {
    id: uuid().defaultRandom().primaryKey(),
    fromRuleId: uuid('from_rule_id').notNull(),
    toRuleId: uuid('to_rule_id').notNull(),
    relationship: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    check('rule_relationships_relationship_check', sql`${table.relationship} in ('DUPLICATE', 'REFINEMENT')`),
    unique('rule_relationships_from_rule_id_to_rule_id_key').on(table.fromRuleId, table.toRuleId),
    foreignKey({ name: 'rule_relationships_from_rule_id_fkey', columns: [table.fromRuleId], foreignColumns: [rules.id] }),
    foreignKey({ name: 'rule_relationships_to_rule_id_fkey', columns: [table.toRuleId], foreignColumns: [rules.id] }),
    index('idx_rule_relationships_from').on(table.fromRuleId),
    index('idx_rule_relationships_to').on(table.toRuleId),
  ]
);

export const codeIndexFiles = pgTable(
  'code_index_files',
  {
    id: uuid().defaultRandom().primaryKey(),
    repo: text().notNull(),
    commitSha: text('commit_sha').notNull(),
    path: text().notNull(),
    contentHash: text('content_hash').notNull(),
    language: text().notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex('idx_code_index_files_identity').on(table.repo, table.commitSha, table.path)]
);

export const codeIndexSymbols = pgTable(
  'code_index_symbols',
  {
    id: uuid().defaultRandom().primaryKey(),
    repo: text().notNull(),
    commitSha: text('commit_sha').notNull(),
    fileId: uuid('file_id').notNull(),
    qualifiedName: text('qualified_name').notNull(),
    kind: text().notNull(),
    signature: text().notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    exported: boolean().notNull().default(false),
    normalizedBody: text('normalized_body').notNull(),
    bodyHash: text('body_hash').notNull(),
  },
  (table) => [
    foreignKey({ name: 'code_index_symbols_file_id_fkey', columns: [table.fileId], foreignColumns: [codeIndexFiles.id] }),
    index('idx_code_index_symbols_lookup').on(table.repo, table.commitSha, table.qualifiedName),
    index('idx_code_index_symbols_body_hash').on(table.repo, table.bodyHash),
  ]
);

export const codeIndexEdges = pgTable(
  'code_index_edges',
  {
    id: uuid().defaultRandom().primaryKey(),
    repo: text().notNull(),
    commitSha: text('commit_sha').notNull(),
    fromSymbolId: uuid('from_symbol_id').notNull(),
    toSymbolId: uuid('to_symbol_id').notNull(),
    edgeType: text('edge_type').notNull(),
  },
  (table) => [
    foreignKey({ name: 'code_index_edges_from_fkey', columns: [table.fromSymbolId], foreignColumns: [codeIndexSymbols.id] }),
    foreignKey({ name: 'code_index_edges_to_fkey', columns: [table.toSymbolId], foreignColumns: [codeIndexSymbols.id] }),
    index('idx_code_index_edges_from').on(table.fromSymbolId),
    index('idx_code_index_edges_to').on(table.toSymbolId),
  ]
);

export const codeIndexRuns = pgTable(
  'code_index_runs',
  {
    id: uuid().defaultRandom().primaryKey(),
    repo: text().notNull(),
    commitSha: text('commit_sha').notNull(),
    status: text().notNull(),
    filesIndexed: integer('files_indexed').notNull().default(0),
    symbolsIndexed: integer('symbols_indexed').notNull().default(0),
    parserVersion: text('parser_version').notNull(),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('idx_code_index_runs_repo_commit').on(table.repo, table.commitSha)]
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid().defaultRandom().primaryKey(),
    repo: text().notNull(),
    prNumber: integer('pr_number').notNull(),
    score: numeric({ precision: 2, scale: 1 }),
    findings: jsonb(),
    seenReactionId: bigint('seen_reaction_id', { mode: 'bigint' }),
    verdictReactionId: bigint('verdict_reaction_id', { mode: 'bigint' }),
    status: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    triggerReason: text('trigger_reason').default('opened'),
    installationId: integer('installation_id'),
    retryCount: integer('retry_count').default(0),
    currentStep: text('current_step'),
    stepDetail: jsonb('step_detail'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    errorStep: text('error_step'),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    githubDeliveryId: text('github_delivery_id'),
    currentStage: text('current_stage'),
    stageStartedAt: timestamp('stage_started_at', { withTimezone: true }),
    stageAttempt: integer('stage_attempt').default(1),
    stageReasonCode: text('stage_reason_code'),
    stageReasonDetail: text('stage_reason_detail'),
    workerHeartbeatAt: timestamp('worker_heartbeat_at', { withTimezone: true }),
    triggerCommentId: bigint('trigger_comment_id', { mode: 'bigint' }),
    triggerCommentType: text('trigger_comment_type'),
    triggerCommentReactionId: bigint('trigger_comment_reaction_id', { mode: 'bigint' }),
    headSha: text('head_sha'),
    baseSha: text('base_sha'),
    dailyQuotaResumeAt: timestamp('daily_quota_resume_at', { withTimezone: true }),
    reconciliationSummary: jsonb('reconciliation_summary'),
    provisionalScore: numeric('provisional_score', { precision: 3, scale: 1 }),
    stageDeadlineAt: timestamp('stage_deadline_at', { withTimezone: true }),
    overviewCommentId: bigint('overview_comment_id', { mode: 'bigint' }),
    requestedReviewMode: text('requested_review_mode').notNull().default('full'),
    effectiveReviewMode: text('effective_review_mode').notNull().default('full'),
    parentReviewId: uuid('parent_review_id'),
    comparisonBaseSha: text('comparison_base_sha'),
    fallbackReason: text('fallback_reason'),
    activeRulesHash: text('active_rules_hash'),
    pipelineVersion: text('pipeline_version').notNull().default('1'),
  },
  (table) => [
    check('reviews_status_check', sql`${table.status} in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED_DAILY_QUOTA')`),
    check('reviews_trigger_reason_check', sql`${table.triggerReason} in ('opened', 'synchronize', 'manual_mention', 'auto_retry')`),
    check('reviews_trigger_comment_type_check', sql`${table.triggerCommentType} in ('issue_comment', 'pull_request_review_comment')`),
    check('reviews_requested_review_mode_check', sql`${table.requestedReviewMode} in ('incremental', 'full')`),
    check('reviews_effective_review_mode_check', sql`${table.effectiveReviewMode} in ('incremental', 'full')`),
    foreignKey({ name: 'reviews_parent_review_id_fkey', columns: [table.parentReviewId], foreignColumns: [reviews.id] }).onDelete('set null'),
    index('idx_reviews_repo_pr').on(table.repo, table.prNumber),
    index('idx_reviews_completed_parent')
      .on(table.repo, table.prNumber, table.createdAt.desc())
      .where(sql`${table.status} = 'COMPLETED'`),
    index('idx_reviews_trigger_comment_id').on(table.triggerCommentId).where(sql`${table.triggerCommentId} is not null`),
    index('idx_reviews_daily_quota_resume').on(table.status, table.dailyQuotaResumeAt).where(sql`${table.status} = 'PAUSED_DAILY_QUOTA'`),
    index('idx_reviews_stage_deadline').on(table.stageDeadlineAt).where(sql`${table.status} = 'RUNNING'`),
    index('idx_reviews_overview_comment')
      .on(table.repo, table.prNumber, table.createdAt.desc())
      .where(sql`${table.overviewCommentId} is not null`),
  ]
);

export const repoSettings = pgTable(
  'repo_settings',
  {
    repo: text().primaryKey(),
    replyMode: text('reply_mode').default('mentioned_only'),
    stuckTimeoutSeconds: integer('stuck_timeout_seconds').default(30),
  },
  (table) => [
    check('repo_settings_reply_mode_check', sql`${table.replyMode} in ('mentioned_only', 'all_comments')`),
  ]
);

export const reviewStepEvents = pgTable(
  'review_step_events',
  {
    id: uuid().defaultRandom().primaryKey(),
    reviewId: uuid('review_id').notNull(),
    stage: text().notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    outcome: text(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    reasonTransitions: jsonb('reason_transitions').notNull().default([]),
    detail: jsonb(),
  },
  (table) => [
    check('review_step_events_outcome_check', sql`${table.outcome} in ('COMPLETED', 'FAILED', 'TIMED_OUT')`),
    foreignKey({ name: 'review_step_events_review_id_fkey', columns: [table.reviewId], foreignColumns: [reviews.id] }).onDelete('cascade'),
    index('idx_step_events_review').on(table.reviewId, table.startedAt),
    uniqueIndex('one_open_stage_attempt_per_review')
      .on(table.reviewId, table.stage, table.attemptNumber)
      .where(sql`${table.endedAt} is null`),
  ]
);

export const reviewReasoning = pgTable(
  'review_reasoning',
  {
    id: uuid().defaultRandom().primaryKey(),
    reviewId: uuid('review_id').notNull(),
    file: text().notNull(),
    model: text(),
    thinking: text(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`now() + interval '14 days'`),
  },
  (table) => [
    foreignKey({ name: 'review_reasoning_review_id_fkey', columns: [table.reviewId], foreignColumns: [reviews.id] }).onDelete('cascade'),
    uniqueIndex('idx_review_reasoning_review_file').on(table.reviewId, table.file),
    index('idx_review_reasoning_review').on(table.reviewId, table.createdAt),
    index('idx_review_reasoning_expires').on(table.expiresAt),
  ]
);

export const reviewFileEvents = pgTable(
  'review_file_events',
  {
    id: uuid().defaultRandom().primaryKey(),
    reviewId: uuid('review_id').notNull(),
    file: text().notNull(),
    status: text().notNull(),
    provider: text(),
    model: text(),
    findingsCount: integer('findings_count').notNull().default(0),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    check('review_file_events_status_check', sql`${table.status} in ('COMPLETED', 'FAILED')`),
    foreignKey({ name: 'review_file_events_review_id_fkey', columns: [table.reviewId], foreignColumns: [reviews.id] }).onDelete('cascade'),
    index('idx_review_file_events_review').on(table.reviewId, table.startedAt),
  ]
);

export const incrementalReviewShadowRuns = pgTable(
  'incremental_review_shadow_runs',
  {
    reviewId: uuid('review_id').primaryKey(),
    parentReviewId: uuid('parent_review_id'),
    decision: text().notNull(),
    fallbackReason: text('fallback_reason'),
    parentHeadSha: text('parent_head_sha'),
    currentHeadSha: text('current_head_sha').notNull(),
    fullInputCharacters: integer('full_input_characters').notNull(),
    incrementalInputCharacters: integer('incremental_input_characters'),
    fullEstimatedTokens: integer('full_estimated_tokens').notNull(),
    incrementalEstimatedTokens: integer('incremental_estimated_tokens'),
    fullFileCount: integer('full_file_count').notNull(),
    incrementalFileCount: integer('incremental_file_count'),
    inputRatio: doublePrecision('input_ratio'),
    executionDiffHash: text('execution_diff_hash').notNull(),
    fullDiffHash: text('full_diff_hash').notNull(),
    executionMatchesFull: boolean('execution_matches_full').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('incremental_review_shadow_runs_decision_check', sql`${table.decision} in ('eligible', 'fallback', 'not_requested', 'disabled')`),
    foreignKey({ name: 'incremental_review_shadow_runs_review_id_fkey', columns: [table.reviewId], foreignColumns: [reviews.id] }).onDelete('cascade'),
    foreignKey({ name: 'incremental_review_shadow_runs_parent_review_id_fkey', columns: [table.parentReviewId], foreignColumns: [reviews.id] }).onDelete('set null'),
    index('idx_incremental_shadow_runs_created').on(table.createdAt.desc()),
  ]
);

export const reviewFindingReconciliations = pgTable(
  'review_finding_reconciliations',
  {
    reviewId: uuid('review_id').notNull(),
    findingId: text('finding_id').notNull(),
    status: text().notNull(),
    previousPath: text('previous_path').notNull(),
    currentPath: text('current_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'review_finding_reconciliations_pkey', columns: [table.reviewId, table.findingId] }),
    check('review_finding_reconciliations_status_check', sql`${table.status} in ('CARRIED', 'RENAMED', 'RESOLVED_FILE_DELETED', 'STILL_PRESENT', 'RESOLVED', 'UNCERTAIN', 'MODEL_RESULT_MISSING', 'MODEL_RESULT_MALFORMED', 'PROVIDER_FAILURE')`),
    foreignKey({ name: 'review_finding_reconciliations_review_id_fkey', columns: [table.reviewId], foreignColumns: [reviews.id] }).onDelete('cascade'),
    index('idx_review_finding_reconciliations_status').on(table.reviewId, table.status),
  ]
);

export const providerInstallations = pgTable(
  'provider_installations',
  {
    provider: text().notNull().default('github'),
    owner: text().notNull(),
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    repos: jsonb().notNull().default([]),
    status: text().notNull().default('active'),
    installedBy: text('installed_by'),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'provider_installations_pkey', columns: [table.provider, table.owner] }),
    index('idx_provider_installations_status').on(table.provider, table.status),
  ]
);

export const dashboardUsers = pgTable(
  'dashboard_users',
  {
    githubId: bigint('github_id', { mode: 'bigint' }).primaryKey(),
    githubLogin: text('github_login').notNull(),
    email: text(),
    status: text().notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
  },
  (table) => [
    check('dashboard_users_status_check', sql`${table.status} in ('pending', 'approved', 'declined')`),
    unique('dashboard_users_github_login_key').on(table.githubLogin),
    index('idx_dashboard_users_status_requested').on(table.status, table.requestedAt.desc()),
  ]
);

export const userLlmKeys = pgTable(
  'user_llm_keys',
  {
    githubId: bigint('github_id', { mode: 'bigint' }).primaryKey(),
    geminiKeys: jsonb('gemini_keys').notNull().default([]),
    groqKeys: jsonb('groq_keys').notNull().default([]),
    cfaiKeys: jsonb('cfai_keys').notNull().default([]),
    cfaiAccountId: text('cfai_account_id'),
    openrouterKeys: jsonb('openrouter_keys').notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ name: 'user_llm_keys_github_id_fkey', columns: [table.githubId], foreignColumns: [dashboardUsers.githubId] }).onDelete('cascade'),
    index('idx_user_llm_keys_updated').on(table.updatedAt.desc()),
  ]
);

export const schemaMigrations = pgTable('schema_migrations', {
  filename: text().primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow(),
});
