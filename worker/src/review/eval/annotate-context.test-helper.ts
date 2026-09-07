import { readFile, writeFile } from 'node:fs/promises';

const path = process.argv.find((argument) => argument.endsWith('.json')) ?? 'worker/src/review/eval/fixtures/martian-selected-context-v1.json';
const labels: Record<string, string[]> = {
  'martian-sentry-92393-optimize-spans-buffer-insertion-with-eviction-during-insert': ['src/sentry/spans/consumers/process/flusher.py'],
  'martian-sentry-67876-github-oauth-security-enhancement': ['src/sentry/integrations/github/client.py', 'src/sentry/identity/github/__init__.py', 'src/sentry/tasks/integrations/github/constants.py'],
  'martian-sentry-93824-span-buffer-multiprocess-enhancement-with-health-monitoring': ['src/sentry/spans/buffer.py', 'src/sentry/utils/kafka_config.py', 'src/sentry/consumers/validate_schema.py'],
  'martian-sentry-95633-feat-uptime-add-ability-to-use-queues-to-manage-parallelism': ['src/sentry/remote_subscriptions/models.py', 'src/sentry/conf/types/uptime.py'],
  'martian-grafana-94942-advanced-sql-analytics-framework': ['pkg/expr/mathexp/exp.go', 'pkg/expr/mathexp/testing.go'],
  'martian-grafana-79265-anonymous-add-configurable-device-limit': ['pkg/services/anonymous/service.go', 'pkg/infra/localcache/cache.go', 'pkg/services/authn/authn.go'],
  'martian-grafana-97529-unified-storage-performance-optimizations': ['pkg/storage/unified/resource/document.go', 'pkg/storage/unified/resource/bleve_index_metrics.go', 'pkg/storage/unified/resource/access.go'],
  'martian-grafana-107534-advanced-query-processing-architecture': ['public/app/plugins/datasource/loki/types.ts', 'public/app/plugins/datasource/loki/datasource.ts', 'public/app/plugins/datasource/loki/logsTimeSplitting.ts'],
  'martian-grafana-80329-database-performance-optimizations': ['pkg/services/annotations/annotations.go', 'pkg/services/annotations/accesscontrol/models.go', 'pkg/services/sqlstore/migrator/migrator.go'],
  'martian-cal.com-14740-add-guest-management-functionality-to-existing-bookings': ['packages/trpc/server/trpc.ts', 'packages/trpc/server/procedures/authedProcedure.ts'],
  'martian-cal.com-10600-feat-2fa-backup-codes': ['packages/features/auth/lib/next-auth-custom-adapter.ts', 'packages/features/auth/lib/verifyPassword.ts'],
  'martian-cal.com-7232-comprehensive-workflow-reminder-management-for-booking-lifec': ['packages/features/ee/workflows/lib/constants.ts', 'packages/features/ee/workflows/lib/getOptions.ts', 'packages/features/ee/workflows/lib/reminders/templates/emailReminderTemplate.ts'],
  'martian-keycloak-40940-fix-concurrent-group-access-to-prevent-nullpointerexception': ['integration/admin-client/src/main/java/org/keycloak/admin/client/resource/GroupsResource.java', 'integration/admin-client/src/main/java/org/keycloak/admin/client/resource/GroupResource.java', 'test-framework/core/src/main/java/org/keycloak/testframework/realm/ManagedRealm.java'],
  'martian-keycloak-32918-add-caching-support-for-identityproviderstorageprovider-getf': ['model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/idp/IdentityProviderListQuery.java', 'model/infinispan/src/main/java/org/keycloak/models/cache/infinispan/RealmCacheManager.java', 'server-spi/src/main/java/org/keycloak/models/KeycloakSession.java'],
  'martian-keycloak-36880-add-client-resource-type-and-scopes-to-authorization-schema': ['core/src/main/java/org/keycloak/representations/idm/authorization/ClientPolicyRepresentation.java', 'integration/admin-client/src/main/java/org/keycloak/admin/client/resource/PermissionsResource.java', 'services/src/main/java/org/keycloak/authorization/common/ClientModelIdentity.java'],
};

const corpus = JSON.parse(await readFile(path, 'utf8')) as { goldSetVersion: string; cases: Array<{ id: string; expectedRelatedFiles?: string[] }> };
corpus.goldSetVersion = 'martian-selected-context-v1';
for (const testCase of corpus.cases) testCase.expectedRelatedFiles = labels[testCase.id] ?? [];
await writeFile(path, JSON.stringify(corpus, null, 2));
process.stdout.write(`Annotated ${corpus.cases.length} cases in ${path}\n`);
