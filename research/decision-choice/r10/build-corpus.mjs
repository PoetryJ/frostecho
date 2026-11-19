#!/usr/bin/env node
/**
 * Join captures with same-snapshot branch labels into the training corpus the
 * Python encoder consumes (`frostecho.joint-encoding-request/1` rows).
 *
 *   node research/decision-choice/r10/build-corpus.mjs \
 *     --cases <capture/cases.jsonl> --labels <labels/labels.jsonl> --out <corpus dir>
 *
 * Split rule: the SOURCE EPISODE is the unit. Episodes are hash-ranked and cut
 * 60/20/20; a case can never straddle two splits and no visible input text may
 * appear in two splits. Cases whose branch rollouts produced an empty
 * acceptable set are kept in the file (that is evidence) but marked
 * `labelStatus: none-acceptable`, which every trainer excludes from the loss.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const casesPath = option('--cases');
const labelsPath = option('--labels');
const out = option('--out');
if (!casesPath || !labelsPath || !out) {
  throw new Error('Usage: --cases <cases.jsonl> --labels <labels.jsonl> --out <newDir>');
}
const splitSeed = option('--split-seed', 'r10c-split-1');
/**
 * Label-independent trimming for the encoder budget: inside every episode the
 * cases are sorted by caseId (capture order = clock order) and every Nth one is
 * kept. The rule never looks at a label, so the trimmed corpus keeps the same
 * label mix as the full one; `--sample-every 1` keeps everything.
 */
const sampleEvery = Math.max(1, Number(option('--sample-every', '1')));
const outDir = resolve(out);
mkdirSync(outDir, { recursive: true });

const cases = readFileSync(casesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const labels = new Map(readFileSync(labelsPath, 'utf8').trim().split('\n').filter(Boolean)
  .map(line => JSON.parse(line)).map(label => [label.caseId, label]));

const episodes = [...new Set(cases.map(row => row.sourceEpisodeId))]
  .sort((left, right) => sha(`${splitSeed}|${left}`).localeCompare(sha(`${splitSeed}|${right}`)));
const assignment = new Map();
const trainEnd = Math.max(1, Math.round(episodes.length * 0.6));
const devEnd = Math.max(trainEnd + 1, Math.round(episodes.length * 0.8));
episodes.forEach((episode, index) => {
  assignment.set(episode, index < trainEnd ? 'train' : index < devEnd ? 'dev' : 'test');
});

const textOwners = new Map();
const rows = [];
const groupedByEpisode = new Map();
for (const row of cases) {
  groupedByEpisode.set(row.sourceEpisodeId,
    [...(groupedByEpisode.get(row.sourceEpisodeId) ?? []), row]);
}
const keptIds = new Set();
for (const [episode, list] of groupedByEpisode) {
  const ordered = [...list].sort((left, right) => left.caseId.localeCompare(right.caseId));
  ordered.forEach((row, index) => {
    if (index % sampleEvery === 0 || sampleEvery === 1) keptIds.add(row.caseId);
  });
  void episode;
}
const report = { missingLabels: 0, emptyAcceptable: 0, crossSplitTextMoves: 0 };
for (const row of cases) {
  if (!keptIds.has(row.caseId)) continue;
  const label = labels.get(row.caseId);
  if (!label) { report.missingLabels += 1; continue; }
  const split = assignment.get(row.sourceEpisodeId);
  const textHash = row.renderedTextSha256;
  const owner = textOwners.get(textHash);
  if (owner === undefined) textOwners.set(textHash, split);
  const effective = split;
  if (owner !== undefined && owner !== split) {
    report.crossSplitTextMoves += 1;
    report.crossSplitTextExamples ??= [];
    if (report.crossSplitTextExamples.length < 5) {
      report.crossSplitTextExamples.push({ caseId: row.caseId, text: row.renderedTextSha256,
        firstSplit: owner, thisSplit: split, episode: row.sourceEpisodeId });
    }
  }
  const acceptableIds = label.acceptableIds.filter(id =>
    row.request.candidates.some(candidate => candidate.id === id));
  if (acceptableIds.length === 0) report.emptyAcceptable += 1;
  rows.push({
    caseId: row.caseId,
    split: effective,
    sourceEpisodeId: row.sourceEpisodeId,
    sourceFamily: row.sourceEpisodeId,
    episode: row.sourceEpisodeId,
    scenarioProfile: row.scenarioProfile,
    captureKind: row.captureKind,
    actorId: row.actorId,
    acceptableIds,
    labelSource: label.labelRule.includes('obligations-discharged')
      ? 'same-snapshot-branch-rollout+discharge' : 'same-snapshot-branch-rollout',
    labelStatus: acceptableIds.length === 0 ? 'none-acceptable'
      : acceptableIds.length === row.request.candidates.length ? 'all-acceptable' : 'partial',
    labelRule: label.labelRule,
    horizonMinutes: label.horizonMinutes,
    sliceMinutes: label.sliceMinutes,
    researchTrainReady: false,
    countsAsAdmitted: false,
    policyRun: row.policyRun,
    scenarioSetup: row.scenarioProfile,
    envelope: {
      schema: row.schema,
      sourceHEAD: row.sourceHEAD,
      seed: row.seed,
      npcCount: row.npcCount,
      request: row.request,
      requestJson: row.requestJson,
      inputSha256: row.inputSha256,
      rendered: row.rendered,
      rendererSourceSha256: row.rendererSourceSha256,
      rendererBuildSha256: row.rendererBuildSha256,
      renderedTextSha256: row.renderedTextSha256,
      modelCalls: 0,
      worldCommits: 0,
      realModel: false,
    },
  });
}

const bySplit = rows.reduce((acc, row) => {
  acc[row.split] = (acc[row.split] ?? 0) + 1;
  return acc;
}, {});
const byEpisode = rows.reduce((acc, row) => {
  acc[row.split] ??= {};
  acc[row.split][row.sourceEpisodeId] = (acc[row.split][row.sourceEpisodeId] ?? 0) + 1;
  return acc;
}, {});
if (report.crossSplitTextMoves > 0) {
  const failure = { schema: 'frostecho.r10c.corpus/1', refused: true,
    code: 'split-text-leak',
    detail: 'the same rendered input appears in two splits; the corpus must be re-captured '
      + 'with distinct episodes, not silently re-assigned', ...report };
  writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(failure, null, 2)}\n`);
  console.log(JSON.stringify(failure, null, 2));
  process.exit(2);
}
for (const split of ['train', 'dev', 'test']) {
  writeFileSync(`${outDir}/${split}.jsonl`,
    `${rows.filter(row => row.split === split).map(row => JSON.stringify(row)).join('\n')}\n`);
}
writeFileSync(`${outDir}/corpus.jsonl`, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
const manifest = {
  schema: 'frostecho.r10c.corpus/1',
  cases: rows.length,
  bySplit,
  byEpisode,
  episodes: Object.fromEntries(assignment),
  splitSeed,
  splitUnit: 'sourceEpisodeId',
  sampleEvery,
  sampledFrom: cases.length,
  labelFamily: rows[0]?.labelSource ?? null,
  labelRule: rows[0]?.labelRule ?? null,
  allAcceptableCases: rows.filter(row => row.labelStatus === 'all-acceptable').length,
  noneAcceptableCases: rows.filter(row => row.labelStatus === 'none-acceptable').length,
  partialCases: rows.filter(row => row.labelStatus === 'partial').length,
  ...report,
  corpusSha256: sha(rows.map(row => JSON.stringify(row)).join('\n')),
  rendererSourceSha256: rows[0]?.envelope.rendererSourceSha256 ?? null,
  rendererBuildSha256: rows[0]?.envelope.rendererBuildSha256 ?? null,
  rendererId: rows[0]?.envelope.rendered.rendererId ?? null,
  casesSha256: sha(readFileSync(casesPath, 'utf8')),
  labelsSha256: sha(readFileSync(labelsPath, 'utf8')),
  note: 'Cases with an empty acceptable set stay in the file as evidence and are excluded from every loss.',
};
writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...manifest }, null, 2));
