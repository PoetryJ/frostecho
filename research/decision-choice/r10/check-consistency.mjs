#!/usr/bin/env node
/**
 * Cross-artifact consistency gate for the R10 C line.
 *
 *   node research/decision-choice/r10/check-consistency.mjs --root <artifacts/r10/c>
 *
 * Checks, in order (exit 1 on the first structural problem, exit 2 on a leak):
 *   1. every corpus case exists in the capture with the same request bytes;
 *   2. every label row covers exactly the captured case set;
 *   3. acceptableIds is a subset of the actual candidates in every corpus row;
 *   4. the label rule recorded in the corpus equals the one in the labels;
 *   5. every case has its restorable snapshot on disk;
 *   6. no source episode and no rendered text crosses a split;
 *   7. the encoded cache (if present) binds the same caseIds and candidate order.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const readLines = path => (existsSync(path)
  ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : null);
const args = process.argv.slice(2);
const root = resolve(args[args.indexOf('--root') + 1] ?? '.');
const corpusDir = args.includes('--corpus') ? resolve(args[args.indexOf('--corpus') + 1])
  : join(root, 'corpus-base-e2');
const labelDir = args.includes('--labels') ? resolve(args[args.indexOf('--labels') + 1])
  : join(root, 'labels-base');

const problems = [];
const notes = {};
const fail = (code, detail) => { problems.push({ code, detail }); };

const cases = readLines(join(root, 'capture/cases.jsonl')) ?? [];
const labels = readLines(join(labelDir, 'labels.jsonl')) ?? [];
const corpus = readLines(join(corpusDir, 'corpus.jsonl')) ?? [];
if (!cases.length) fail('capture-empty', 'no capture cases');
if (!corpus.length) fail('corpus-empty', 'no corpus rows');

const byId = new Map(cases.map(row => [row.caseId, row]));
for (const row of corpus) {
  const source = byId.get(row.caseId);
  if (!source) { fail('corpus-not-captured', row.caseId); continue; }
  const request = row.envelope.request;
  if (JSON.stringify(request) !== source.requestJson) {
    fail('corpus-request-bytes', `${row.caseId} request differs from the capture`);
  }
  if (sha(source.requestJson) !== row.envelope.inputSha256) {
    fail('corpus-input-sha', `${row.caseId} inputSha256 does not hash requestJson`);
  }
  const ids = request.candidates.map(candidate => candidate.id);
  if ((row.acceptableIds ?? []).some(id => !ids.includes(id))) {
    fail('corpus-labels', `${row.caseId} acceptableIds are not candidates`);
  }
  // The stored `snapshotBase` is the run-time path; the portable location is
  // `<capture>/snapshots/<caseId>` (the labeller copies it per branch).
  const snapshot = join(root, 'capture/snapshots', source.caseId);
  if (!existsSync(snapshot) || !existsSync(`${snapshot}.r8.json`)) {
    fail('snapshot-missing', source.caseId);
  }
}

const labelById = new Map(labels.map(row => [row.caseId, row]));
if (labelById.size !== cases.length) {
  fail('label-count', `labels ${labelById.size} != capture ${cases.length}`);
}
for (const row of corpus) {
  const label = labelById.get(row.caseId);
  if (!label) { fail('label-missing', row.caseId); continue; }
  if (JSON.stringify(label.acceptableIds) !== JSON.stringify(row.acceptableIds)) {
    fail('label-drift', `${row.caseId} corpus labels differ from the label file`);
  }
  if (label.labelRule !== row.labelRule) {
    fail('label-rule-drift', `${row.caseId} rule differs between corpus and labels`);
  }
}

const episodeOwner = new Map();
const textOwner = new Map();
for (const row of corpus) {
  const owner = episodeOwner.get(row.sourceEpisodeId);
  if (owner !== undefined && owner !== row.split) fail('episode-leak', row.sourceEpisodeId);
  episodeOwner.set(row.sourceEpisodeId, row.split);
  const textHash = row.envelope.renderedTextSha256;
  const textSplit = textOwner.get(textHash);
  if (textSplit !== undefined && textSplit !== row.split) fail('text-leak', row.caseId);
  textOwner.set(textHash, row.split);
}

const cacheDir = join(root, 'enc');
let cache = null;
if (existsSync(join(cacheDir, 'metadata.json')) && existsSync(join(cacheDir, 'records.jsonl'))) {
  const metadata = JSON.parse(readFileSync(join(cacheDir, 'metadata.json'), 'utf8'));
  const records = readLines(join(cacheDir, 'records.jsonl')) ?? [];
  const recordById = new Map(records.map(record => [record.caseId, record]));
  cache = { cases: records.length, identityHash: metadata.featureIdentityHash,
    forwards: metadata.encoderForwardCalls };
  for (const row of corpus) {
    const record = recordById.get(row.caseId);
    if (!record) { fail('cache-missing-case', row.caseId); continue; }
    const ids = row.envelope.request.candidates.map(candidate => candidate.id);
    if (JSON.stringify(record.candidateIds) !== JSON.stringify(ids)) {
      fail('cache-candidate-order', row.caseId);
    }
    if (record.inputSha256 !== row.envelope.inputSha256) fail('cache-input-sha', row.caseId);
    if (record.split !== row.split) fail('cache-split', row.caseId);
    if (record.featureIdentityHash !== metadata.featureIdentityHash) {
      fail('cache-identity-mixed', row.caseId);
    }
  }
}

notes.cases = cases.length;
notes.corpus = corpus.length;
notes.labels = labels.length;
notes.splits = corpus.reduce((acc, row) => {
  acc[row.split] = (acc[row.split] ?? 0) + 1;
  return acc;
}, {});
notes.episodes = Object.fromEntries(episodeOwner);
notes.distinctTexts = textOwner.size;
notes.cache = cache;
notes.labelRule = corpus[0]?.labelRule ?? null;
notes.renderer = corpus[0]?.envelope.rendered.rendererId ?? null;
const report = { schema: 'frostecho.r10c.consistency/1', ok: problems.length === 0,
  problems, notes };
console.log(JSON.stringify(report, null, 2));
if (problems.some(problem => ['episode-leak', 'text-leak'].includes(problem.code))) process.exit(2);
if (problems.length > 0) process.exit(1);
