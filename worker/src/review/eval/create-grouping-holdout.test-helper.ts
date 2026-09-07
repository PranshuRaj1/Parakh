import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EvalCorpus } from './types.js';

const root = process.cwd();
const selected: Array<[string, string]> = [
  ['martian-sentry.json', 'martian-sentry-94376-feat-upsampling-support-upsampled-error-count-with-performan'],
  ['martian-sentry.json', 'martian-sentry-77754-feat-ecosystem-implement-cross-system-issue-synchronization'],
  ['martian-grafana.json', 'martian-grafana-106778-notification-rule-processing-engine'],
  ['martian-cal_dot_com.json', 'martian-cal.com-10967-fix-handle-collective-multiple-host-on-destinationcalendar'],
  ['martian-keycloak.json', 'martian-keycloak-37038-add-groups-resource-type-and-scopes-to-authorization-schema'],
];

const corpora = new Map<string, EvalCorpus>();
for (const file of new Set(selected.map(([file]) => file))) {
  corpora.set(file, JSON.parse(await readFile(resolve(root, 'worker/src/review/eval/fixtures', file), 'utf8')) as EvalCorpus);
}

const cases = selected.map(([file, id]) => {
  const testCase = corpora.get(file)!.cases.find((item) => item.id === id);
  if (!testCase) throw new Error(`Case not found: ${id}`);
  return testCase;
});
const caseIds = new Set(cases.map((testCase) => testCase.id));
const defects = [...corpora.values()].flatMap((corpus) => corpus.defects.filter((defect) => caseIds.has(defect.caseId)));
const corpus: EvalCorpus = {
  schemaVersion: 1,
  goldSetVersion: 'martian-grouping-holdout-v1',
  cases,
  defects,
};

const output = resolve(root, 'worker/src/review/eval/fixtures/martian-grouping-holdout-v1.json');
await writeFile(output, JSON.stringify(corpus, null, 2));
process.stdout.write(`Wrote ${cases.length} grouping holdout cases and ${defects.length} defects to ${output}\n`);
