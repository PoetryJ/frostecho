#!/usr/bin/env node
/**
 * Join the two blind reviews.
 *
 *   node scripts/r8/join-blind-review.mjs --keymap <dir>/keymap.json \
 *     --a review-A.jsonl --b review-B.jsonl --corpus <cases.jsonl> --out <json>
 *
 * Validates every line against the private keymap (case id + input hash), checks
 * that every accepted id exists in that case's candidate list, then reports
 * agreement. Disagreements are quarantined for a third reviewer instead of
 * being averaged.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
for (const required of ['--keymap', '--a', '--b', '--out']) {
  if (!option(required)) throw new Error(`missing ${required}`);
}
const keymap = JSON.parse(readFileSync(resolve(option('--keymap')), 'utf8')).map;
const corpusPath = option('--corpus');
const candidatesById = {};
if (corpusPath) {
  for (const line of readFileSync(resolve(corpusPath), 'utf8').trim().split('\n')) {
    const row = JSON.parse(line);
    candidatesById[row.caseId] = new Set(
      row.request.candidates.map(candidate => candidate.id));
  }
}

const load = path => {
  const rows = new Map();
  for (const line of readFileSync(resolve(path), 'utf8').trim().split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    rows.set(row.caseId, row);
  }
  return rows;
};
const a = load(option('--a'));
const b = load(option('--b'));

const problems = [];
const joined = [];
let agreed = 0;
let quarantined = 0;

for (const [publicId, meta] of Object.entries(keymap)) {
  const left = a.get(publicId);
  const right = b.get(publicId);
  if (!left || !right) {
    problems.push(`${publicId}: missing from ${left ? 'B' : 'A'}`);
    continue;
  }
  for (const [label, row] of [['A', left], ['B', right]]) {
    if (row.inputSha256 !== meta.inputSha256) {
      problems.push(`${publicId}: ${label} inputSha256 mismatch`);
    }
    const allowed = candidatesById[meta.realCaseId];
    if (allowed) {
      for (const id of row.acceptableIds ?? []) {
        if (!allowed.has(id)) problems.push(`${publicId}: ${label} invented id ${id}`);
      }
    }
  }
  const leftSet = new Set(left.acceptableIds ?? []);
  const rightSet = new Set(right.acceptableIds ?? []);
  const intersection = [...leftSet].filter(id => rightSet.has(id));
  const union = new Set([...leftSet, ...rightSet]);
  const identical = leftSet.size === rightSet.size
    && [...leftSet].every(id => rightSet.has(id));
  if (identical) agreed += 1; else quarantined += 1;
  joined.push({
    publicId,
    realCaseId: meta.realCaseId,
    scenario: meta.scenario,
    split: meta.split,
    inputSha256: meta.inputSha256,
    reviewA: [...leftSet],
    reviewB: [...rightSet],
    identical,
    intersection,
    union: [...union],
    jaccard: union.size === 0 ? 1 : intersection.length / union.size,
    needsAdjudication: !identical,
    reasonA: left.reason ?? '',
    reasonB: right.reason ?? '',
    insufficientInfo: Boolean(left.insufficientInfo || right.insufficientInfo),
    originalWeakLabel: meta.acceptableIdsOriginal,
  });
}

const document = {
  schema: 'frostecho.r9.blind-review-joined/1',
  cases: joined.length,
  identical: agreed,
  quarantined,
  meanJaccard: joined.length
    ? Number((joined.reduce((sum, row) => sum + row.jaccard, 0) / joined.length).toFixed(4))
    : null,
  problems,
  aSha256: sha(readFileSync(resolve(option('--a')), 'utf8')),
  bSha256: sha(readFileSync(resolve(option('--b')), 'utf8')),
  rows: joined,
};
writeFileSync(resolve(option('--out')), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ cases: document.cases, identical: agreed, quarantined,
  meanJaccard: document.meanJaccard, problems: problems.length,
  out: option('--out') }, null, 2));
if (problems.length > 0) process.exitCode = 1;
