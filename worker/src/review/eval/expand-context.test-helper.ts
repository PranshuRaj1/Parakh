import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { loadEvalCorpus } from './corpus.test-helper.js';
import { expandSnapshotContext } from './github-snapshot.js';

const [input, output, caseId] = process.argv.slice(2).filter(arg => arg !== '--');
if (!input || !output) throw new Error('Usage: expand-context <corpus.json> <output.json> [case-id]');
const corpus = await loadEvalCorpus(input);
if (caseId) corpus.cases = corpus.cases.filter(testCase => testCase.id === caseId);
if (!corpus.cases.length) throw new Error('No matching eval cases');
corpus.defects = corpus.defects.filter(defect => corpus.cases.some(testCase => testCase.id === defect.caseId));
for (const testCase of corpus.cases) {
  if (!/^[a-f0-9]{40}$/i.test(testCase.baseSha) || !/^[a-f0-9]{40}$/i.test(testCase.headSha)) throw new Error(`Unpinned case: ${testCase.id}`);
  const [owner, repo] = testCase.repo.split('/');
  const expanded = await expandSnapshotContext(owner, repo, testCase, process.env.GITHUB_TOKEN ?? '');
  Object.assign(testCase, expanded);
  process.stdout.write(`${testCase.id}: ${Object.keys(testCase.files).length} head files, ${Object.keys(testCase.baseFiles ?? {}).length} base files, limit=${expanded.contextTruncatedBy ?? 'none'}\n`);
}
await writeFile(output, JSON.stringify(corpus, null, 2));
