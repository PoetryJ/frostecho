/** Independently audit captured envelopes; no generation, model calls or writes. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { renderRequest, renderCandidateText } = require('../../../dist/src/r7/jev/render.js');
const { validateChoiceRequest } = require('../../../dist/src/decision/contracts.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const normalize = value => value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
export function invariantInputHash(request) {
  const rendered = renderRequest(request);
  return sha(normalize(JSON.stringify({
    context: rendered.segments.filter(segment => segment.kind !== 'candidate').map(segment => segment.text),
    candidates: request.candidates.map(renderCandidateText).sort(),
  })));
}
export function validateCorpus(rows, episodes) {
  const exact = new Set(), semantic = new Set(), ids = new Set(), families = new Map();
  const episodeMap = new Map(episodes.map(episode => [episode.episodeSeed, episode]));
  const counts = {};
  for (const row of rows) {
    validateChoiceRequest(row.request);
    if (row.schema !== 'frostecho.joint-encoding-request/1') fail('schema');
    if (ids.has(row.caseId)) fail('duplicate caseId');
    ids.add(row.caseId);
    if (row.inputSha256 !== sha(row.requestJson)
      || JSON.stringify(JSON.parse(row.requestJson)) !== JSON.stringify(row.request)) fail('request bytes');
    const rendered = renderRequest(row.request);
    if (rendered.text !== row.rendered.text || sha(rendered.text) !== row.renderedTextSha256
      || JSON.stringify(rendered.candidateSpans) !== JSON.stringify(row.rendered.candidateSpans)
      || row.rendered.spanUnit !== 'utf16-code-unit') fail('rendered input mismatch');
    if (row.labelSource !== 'reference-imitation' || row.independentReviews !== 0
      || row.researchTrainReady !== false || row.realModel !== false) fail('misclassified evidence');
    if (row.acceptableIds.length !== 1 || row.acceptableIds[0] !== row.selectedId
      || !row.request.candidates.some(candidate => candidate.id === row.selectedId)) fail('label mapping');
    if (row.request.candidates.length < 2 || row.request.candidates.length > 8) fail('candidate count');
    const previousSplit = families.get(row.sourceFamily);
    if (previousSplit && previousSplit !== row.split) fail('source family split leak');
    families.set(row.sourceFamily, row.split);
    if (row.sourceFamily !== row.episodeSeed) fail('source family not episode root');
    const episode = episodeMap.get(row.episodeSeed);
    if (!episode || episode.split !== row.split || !episode.caseIds.includes(row.caseId)) fail('episode identity');
    if (exact.has(row.renderedTextSha256)) fail('duplicate model-visible input');
    exact.add(row.renderedTextSha256);
    const normalized = invariantInputHash(row.request);
    if (semantic.has(normalized)) fail('duplicate order-invariant semantic input');
    semantic.add(normalized);
    if (normalized !== row.permutationInvariantSha256) fail('semantic key mismatch');
    const execution = row.execution;
    if (execution.record.executionStatus !== 'applied'
      || execution.record.selectedId !== row.selectedId
      || execution.afterVersion <= execution.beforeVersion
      || !execution.record.eventIds.length) fail('no applied action');
    const committed = new Map(episode.committedEvents.map(receipt => [receipt.eventId, receipt]));
    if (execution.committedReceipts.length !== execution.record.eventIds.length) fail('receipt count');
    for (const [index, eventId] of execution.record.eventIds.entries()) {
      if (!committed.has(eventId) || JSON.stringify(committed.get(eventId))
        !== JSON.stringify(execution.committedReceipts[index])) fail('uncommitted receipt');
    }
    counts[row.split] = (counts[row.split] ?? 0) + 1;
  }
  return { ok: true, cases: rows.length, counts, sourceFamilies: families.size,
    uniqueVisibleInputs: exact.size, uniquePermutationInvariantInputs: semantic.size,
    labelSource: 'reference-imitation', independentReviews: 0, researchTrainReady: false };
}
export const readJsonl = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) fail('Usage: node scripts/r8/data/corpus-integrity.mjs <corpusDirectory>');
  console.log(JSON.stringify(validateCorpus(readJsonl(resolve(directory, 'cases.jsonl')),
    readJsonl(resolve(directory, 'episodes.jsonl')))));
}
