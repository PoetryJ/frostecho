#!/usr/bin/env node
/**
 * R11 C line: join captures with the common-deadline labels into the two
 * training corpora the /2 recipes consume.
 *
 *   node research/decision-choice/r11/build-deadline-corpus.mjs \
 *     --cases <capture/cases.jsonl> --labels <labels/labels.jsonl> --out <dir>
 *
 * Both families use the same states, candidates, features and episode split:
 *   base         the R10 executable/survival label (comparable to the old head)
 *   fulfillment  the pre-registered deadline label; only states where the actor
 *                believes it owes a commitment enter this family.  Empty
 *                acceptable sets stay in the file as evidence (abstention
 *                cases) and are excluded from the set-loss, never filled in.
 *
 * The source episode is the split unit.  Visible text may not cross splits.
 * The manifest reports the natural distribution, all/none/discriminative
 * counts with explicit denominators, per-story outcomes and whether the frozen
 * volume targets were actually met (``informationSufficient: false`` otherwise).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
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
const splitSeed = option('--split-seed', 'r11c-split-1');
const trainRatio = Number(option('--train-ratio', '0.6'));
const devRatio = Number(option('--dev-ratio', '0.2'));
const outDir = resolve(out);
if (existsSync(outDir)) throw new Error(`${outDir} exists; a corpus build is a new directory`);
mkdirSync(outDir, { recursive: true });

const cases = readFileSync(casesPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const labelRows = readFileSync(labelsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const labels = new Map(labelRows.map(label => [label.caseId, label]));
if (labels.size !== labelRows.length) throw new Error('duplicate caseId in labels');
if (cases.length !== labelRows.length) {
  throw new Error(`capture has ${cases.length} cases but labels have ${labelRows.length}`);
}

const episodes = [...new Set(cases.map(row => row.sourceEpisodeId))]
  .sort((left, right) => sha(`${splitSeed}|${left}`).localeCompare(sha(`${splitSeed}|${right}`)));
if (episodes.length < 3) throw new Error('at least three source episodes are required for train/dev/test');
// Every split must own at least one episode; the last episode is always test.
const trainEnd = Math.max(1, Math.min(episodes.length - 2,
  Math.round(episodes.length * trainRatio)));
const devEnd = Math.max(trainEnd + 1, Math.min(episodes.length - 1,
  Math.round(episodes.length * (trainRatio + devRatio))));
const assignment = new Map();
episodes.forEach((episode, index) => assignment.set(episode,
  index < trainEnd ? 'train' : index < devEnd ? 'dev' : 'test'));

const textOwners = new Map();
const report = { crossSplitTextMoves: 0, missingLabels: 0 };
const rows = [];
for (const row of cases) {
  const label = labels.get(row.caseId);
  if (!label) { report.missingLabels += 1; continue; }
  const split = assignment.get(row.sourceEpisodeId);
  const text = row.renderedTextSha256;
  const owner = textOwners.get(text);
  if (owner === undefined) textOwners.set(text, split);
  else if (owner !== split) {
    report.crossSplitTextMoves += 1;
    report.crossSplitTextExamples ??= [];
    if (report.crossSplitTextExamples.length < 5) {
      report.crossSplitTextExamples.push({ caseId: row.caseId, episode: row.sourceEpisodeId,
        firstSplit: owner, thisSplit: split });
    }
  }
  const candidateIds = row.request.candidates.map(candidate => candidate.id);
  const keep = ids => ids.filter(id => candidateIds.includes(id));
  const base = keep(label.acceptableIds ?? []);
  const fulfillment = keep(label.acceptableFulfillmentIds ?? []);
  rows.push({
    caseId: row.caseId, split, sourceEpisodeId: row.sourceEpisodeId,
    sourceFamily: row.sourceEpisodeId, episode: row.sourceEpisodeId,
    story: row.story, actorId: row.actorId,
    accessState: row.accessState, policyRun: row.policyRun,
    deadline: { t0: label.t0, tStar: label.tStar, basis: label.deadlineBasis,
      horizonMinutes: label.horizonMinutes },
    obligation: label.obligation,
    acceptableIds: base,
    acceptableFulfillmentIds: fulfillment,
    fulfillmentDefined: Boolean(label.fulfillmentDefined),
    labelSource: 'same-snapshot-branch-rollout',
    labelRuleBase: label.labelRuleBase,
    labelRuleFulfillment: label.labelRuleFulfillment,
    labelStatus: base.length === 0 ? 'none-acceptable'
      : base.length === candidateIds.length ? 'all-acceptable' : 'partial',
    labelStatusFulfillment: !label.fulfillmentDefined ? 'undefined'
      : fulfillment.length === 0 ? 'none-acceptable'
        : fulfillment.length === candidateIds.length ? 'all-acceptable' : 'partial',
    researchTrainReady: false, countsAsAdmitted: false,
    envelope: {
      schema: row.schema, sourceHEAD: row.sourceHEAD, seed: row.seed,
      npcCount: row.npcCount, request: row.request, requestJson: row.requestJson,
      inputSha256: row.inputSha256, rendered: row.rendered,
      rendererSourceSha256: row.rendererSourceSha256,
      rendererBuildSha256: row.rendererBuildSha256,
      renderedTextSha256: row.renderedTextSha256,
      freezeSha256: row.freezeSha256, modelCalls: 0, worldCommits: 0,
      realModel: row.accessState === 'real-jev',
    },
  });
}
if (report.crossSplitTextMoves > 0) {
  const failure = { schema: 'frostecho.r11c.corpus/1', refused: true,
    code: 'split-text-leak',
    detail: 'the same rendered input appears in two splits; capture new episodes instead '
      + 'of reassigning them', ...report };
  writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(failure, null, 2)}\n`);
  console.log(JSON.stringify(failure, null, 2));
  process.exit(2);
}
for (const split of ['train', 'dev', 'test']) {
  if (!rows.some(row => row.split === split)) {
    throw new Error(`split ${split} is empty; ${episodes.length} episodes cannot be cut 60/20/20`);
  }
}

function stats(list, acceptableOf) {
  const statuses = list.map(row => acceptableOf(row).length === 0 ? 'none'
    : acceptableOf(row).length === row.envelope.request.candidates.length ? 'all' : 'partial');
  const discriminative = statuses.filter(status => status === 'partial').length;
  return {
    cases: list.length,
    allAcceptable: statuses.filter(status => status === 'all').length,
    noneAcceptable: statuses.filter(status => status === 'none').length,
    discriminative,
    labelledCases: statuses.filter(status => status !== 'none').length,
    meanAcceptableSet: list.length ? Number((list.reduce((sum, row) =>
      sum + acceptableOf(row).length, 0) / list.length).toFixed(4)) : null,
  };
}

function family(name, acceptableOf, definedOf, labelRule) {
  const defined = rows.filter(definedOf);
  const bySplit = Object.fromEntries(['train', 'dev', 'test'].map(split => {
    const list = defined.filter(row => row.split === split);
    return [split, stats(list, acceptableOf)];
  }));
  const byStory = {};
  for (const row of defined) {
    byStory[row.story] ??= [];
    byStory[row.story].push(row);
  }
  const storyReport = Object.fromEntries(Object.entries(byStory).map(([story, list]) => {
    const signatures = new Set(list.map(row => acceptableOf(row).slice().sort().join(',')));
    return [story, { cases: list.length, distinctAcceptableSets: signatures.size,
      ...stats(list, acceptableOf) }];
  }));
  const fileRows = defined.map(row => ({
    caseId: row.caseId, split: row.split, sourceEpisodeId: row.sourceEpisodeId,
    sourceFamily: row.sourceFamily, episode: row.episode, story: row.story,
    actorId: row.actorId, accessState: row.accessState, policyRun: row.policyRun,
    deadline: row.deadline, obligation: row.obligation,
    acceptableIds: acceptableOf(row),
    fulfillmentDefined: name === 'fulfillment',
    labelSource: row.labelSource, labelRule: labelRule(row),
    labelStatus: acceptableOf(row).length === 0 ? 'none-acceptable'
      : acceptableOf(row).length === row.envelope.request.candidates.length
        ? 'all-acceptable' : 'partial',
    researchTrainReady: false, countsAsAdmitted: false,
    envelope: row.envelope,
  }));
  for (const split of ['train', 'dev', 'test']) {
    writeFileSync(`${outDir}/${name}-${split}.jsonl`,
      `${fileRows.filter(row => row.split === split).map(row => canonical(row)).join('\n')}\n`);
  }
  writeFileSync(`${outDir}/${name}.jsonl`, `${fileRows.map(row => canonical(row)).join('\n')}\n`);
  return {
    family: name, labelRule, cases: fileRows.length,
    bySplit, byStory: storyReport,
    storiesPresent: Object.keys(storyReport).length,
    storiesWithDifferentOutcomes: Object.values(storyReport)
      .filter(entry => entry.distinctAcceptableSets > 1).length,
    corpusSha256: sha(fileRows.map(row => canonical(row)).join('\n')),
  };
}

const base = family('base', row => row.acceptableIds,
  () => true, row => row.labelRuleBase);
const fulfillment = family('fulfillment', row => row.acceptableFulfillmentIds,
  row => row.fulfillmentDefined, row => row.labelRuleFulfillment);
const targets = {
  devPoolStates: 48, devPoolEpisodes: 12, discriminativeStates: 24,
  devDiscriminative: 32, testDiscriminative: 32,
};
const developmentEpisodes = episodes.filter(episode => assignment.get(episode) !== 'test').length;
const manifest = {
  schema: 'frostecho.r11c.corpus/1',
  cases: rows.length,
  episodes: Object.fromEntries(assignment),
  episodeCount: episodes.length,
  developmentEpisodes,
  splitSeed, splitUnit: 'sourceEpisodeId',
  trainRatio, devRatio,
  labelSource: 'same-snapshot-branch-rollout',
  labelFamilies: { base, fulfillment },
  targets,
  targetReport: {
    devPoolStates: { target: targets.devPoolStates, actual: rows.length,
      met: rows.length >= targets.devPoolStates },
    devPoolEpisodes: { target: targets.devPoolEpisodes, actual: episodes.length,
      met: episodes.length >= targets.devPoolEpisodes },
    discriminativeStates: { target: targets.discriminativeStates,
      actual: base.bySplit.train.discriminative + base.bySplit.dev.discriminative
        + base.bySplit.test.discriminative,
      met: base.bySplit.train.discriminative + base.bySplit.dev.discriminative
        + base.bySplit.test.discriminative >= targets.discriminativeStates },
    devDiscriminative: { target: targets.devDiscriminative,
      actual: base.bySplit.dev.discriminative, met: base.bySplit.dev.discriminative >= targets.devDiscriminative },
    testDiscriminative: { target: targets.testDiscriminative,
      actual: base.bySplit.test.discriminative, met: base.bySplit.test.discriminative >= targets.testDiscriminative },
  },
  missingLabels: report.missingLabels,
  crossSplitTextMoves: report.crossSplitTextMoves,
  casesSha256: sha(readFileSync(casesPath, 'utf8')),
  labelsSha256: sha(readFileSync(labelsPath, 'utf8')),
  rendererSourceSha256: cases[0]?.rendererSourceSha256 ?? null,
  freezeSha256: cases[0]?.freezeSha256 ?? null,
  informationSufficient: rows.length >= targets.devPoolStates
    && episodes.length >= targets.devPoolEpisodes
    && (base.bySplit.dev.discriminative >= targets.devDiscriminative
      && base.bySplit.test.discriminative >= targets.testDiscriminative),
  note: 'Empty acceptable sets stay in the corpus as evidence and are excluded from every loss; '
    + 'they are never replaced by a made-up correct candidate.',
};
writeFileSync(`${outDir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, ...manifest }, null, 2));
