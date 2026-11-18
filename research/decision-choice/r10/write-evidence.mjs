#!/usr/bin/env node
/**
 * Collect the R10 C-line evidence index from the files that were actually
 * produced. Nothing here is typed by hand: every number is read back from a
 * JSON/JSONL artifact and every artifact carries its SHA256.
 *
 *   node research/decision-choice/r10/write-evidence.mjs --root <artifacts/r10/c>
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const root = resolve(process.argv[process.argv.indexOf('--root') + 1] ?? '.');
const repo = resolve(process.argv[process.argv.indexOf('--repo') + 1]
  ?? new URL('../../..', import.meta.url).pathname);

function git(args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

const files = {
  capture: join(root, 'capture/capture.json'),
  labelsPrimaryRollout: join(root, 'labels-primary/summary.json'),
  labelsBase: join(root, 'labels-base/summary.json'),
  labelsDischarge: join(root, 'labels-discharge/summary.json'),
  labelsStrictRollout: join(root, 'labels-strict/summary.json'),
  corpusBase: join(root, 'corpus-base/manifest.json'),
  corpusDischarge: join(root, 'corpus-discharge/manifest.json'),
  encoding: join(root, 'enc/metadata.json'),
  encodingTiming: join(root, 'enc-timing-auto2/metadata.json'),
  primaryTraining: join(root, 'train-primary/training-manifest.json'),
  primaryDev: join(root, 'train-primary/dev-decisions.json'),
  primaryTest: join(root, 'train-primary/test-eval.json'),
  dischargeTraining: join(root, 'train-discharge/training-manifest.json'),
  dischargeDev: join(root, 'train-discharge/dev-decisions.json'),
  dischargeTest: join(root, 'train-discharge/test-eval.json'),
};
const documents = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, read(path)]));
const caseRows = existsSync(join(root, 'capture/cases.jsonl'))
  ? readFileSync(join(root, 'capture/cases.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)) : [];
const episodeRows = existsSync(join(root, 'capture/episodes.jsonl'))
  ? readFileSync(join(root, 'capture/episodes.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line)) : [];
const count = key => caseRows.reduce((acc, row) => {
  const value = key(row);
  acc[value] = (acc[value] ?? 0) + 1;
  return acc;
}, {});
const shas = Object.fromEntries(Object.entries(files)
  .filter(([, path]) => existsSync(path)).map(([key, path]) => [key, sha(path)]));

// What is committed vs what stays in the large local archive (827 MB snapshots,
// 830 MB per-branch copies): the split is explicit so nothing is silently lost.
const TRACKED = new Set([
  'capture/cases.jsonl', 'capture/capture.json', 'capture/episodes.jsonl',
  'labels-primary/labels.jsonl', 'labels-primary/summary.json',
  'labels-base/labels.jsonl', 'labels-base/summary.json',
  'labels-discharge/summary.json', 'labels-strict/summary.json',
  'corpus-base-e2/corpus.jsonl', 'corpus-base-e2/manifest.json',
  'corpus-discharge-e2/corpus.jsonl', 'corpus-discharge-e2/manifest.json',
  'enc/features.npz', 'enc/records.jsonl', 'enc/metadata.json',
  'enc/qualification.json', 'enc/forward-events.jsonl',
  'EVIDENCE.json', 'consistency.json',
]);
const controls = existsSync(join(root, 'controls'))
  ? readdirSync(join(root, 'controls')).filter(name => statSync(join(root, 'controls', name)).isDirectory()
    && !name.startsWith('_')).sort().map(name => {
    const path = join(root, 'controls', name, 'refusal.json');
    return { name, refusal: existsSync(path) ? read(path) : null };
  }) : [];

function costOf(metadata, label) {
  if (!metadata) return null;
  const identity = metadata.featureIdentity ?? {};
  const devices = Object.keys(identity.actualParameterBytesByDevice ?? {});
  const gpuDevices = devices.filter(device => device.startsWith('cuda'));
  const wall = Number(metadata.wallSecondsThisInvocation ?? 0);
  const gpus = Number(identity.physicalGpus?.length ?? 0);
  return {
    label,
    forwards: metadata.encoderForwardCalls,
    wallSeconds: Math.round(wall),
    wallMinutes: Number((wall / 60).toFixed(1)),
    placement: metadata.execution?.placement,
    parameterDevices: devices,
    gpuResidentDevices: gpuDevices,
    cardHoursIfAllGpusHeld: Number((wall / 3600 * gpus).toFixed(3)),
    cardHoursActuallyResident: Number((wall / 3600 * (gpuDevices.includes('cuda:0')
      || gpuDevices.length > 0 ? gpus : 0)).toFixed(3)),
    secondsPerForward: metadata.encoderForwardCalls
      ? Number((wall / metadata.encoderForwardCalls).toFixed(2)) : null,
    identityHash: metadata.featureIdentityHash,
    loadSeconds: identity.loadSeconds,
  };
}

const evidence = {
  schema: 'frostecho.r10c.evidence/1',
  generatedAt: new Date().toISOString(),
  source: {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    base: '054cab0 (codex/r10-commitment)',
    dirty: (git(['status', '--short']) ?? '').split('\n').filter(Boolean),
  },
  renderer: {
    id: documents.capture?.rendererId ?? null,
    sourceSha256: documents.capture?.rendererSourceSha256 ?? null,
    buildSha256: documents.capture?.rendererBuildSha256 ?? null,
  },
  capture: documents.capture && {
    cases: documents.capture.cases,
    episodes: documents.capture.episodes,
    slices: documents.capture.slices,
    policy: documents.capture.policy,
    withMedicalCandidate: documents.capture.withMedicalCandidate,
    byKind: documents.capture.byKind,
    wallSeconds: documents.capture.wallSeconds,
  },
  captureDistribution: {
    byActor: count(row => row.actorId),
    byDay: count(row => `day${row.day}`),
    bySlice: count(row => `s${row.sliceIndex}`),
    byCaptureKind: count(row => row.captureKind),
    byScenarioProfile: count(row => row.scenarioProfile),
    withMedicalCandidate: caseRows.filter(row =>
      row.candidateActions.some(entry => entry.action === 'medical')).length,
    withAcceptedGoal: caseRows.filter(row => row.acceptedGoals.length > 0).length,
    distinctRenderedTexts: new Set(caseRows.map(row => row.renderedTextSha256)).size,
  },
  cancelAfterWork: episodeRows.filter(row => row.cancelled).map(row => ({
    episode: row.episodeSeed, ...row.cancelled,
  })),
  labels: {
    rolloutPrimary: documents.labelsPrimaryRollout && {
      rule: documents.labelsPrimaryRollout.labelRule,
      horizonMinutes: documents.labelsPrimaryRollout.horizonMinutes,
      allAcceptableCases: documents.labelsPrimaryRollout.allAcceptableCases,
      noneAcceptableCases: documents.labelsPrimaryRollout.noneAcceptableCases,
      meanAcceptablePerCase: documents.labelsPrimaryRollout.meanAcceptablePerCase,
      randomBaseline: documents.labelsPrimaryRollout.randomBaseline,
      ruleBaseline: documents.labelsPrimaryRollout.ruleBaseline,
      wallSeconds: documents.labelsPrimaryRollout.wallSeconds,
    },
    base: documents.labelsBase && {
      rule: documents.labelsBase.labelRule,
      allAcceptableCases: documents.labelsBase.allAcceptableCases,
      noneAcceptableCases: documents.labelsBase.noneAcceptableCases,
      partialCases: documents.labelsBase.partialCases,
      meanAcceptablePerCase: documents.labelsBase.meanAcceptablePerCase,
      randomBaseline: documents.labelsBase.randomBaseline,
      ruleBaseline: documents.labelsBase.ruleBaseline,
    },
    discharge: documents.labelsDischarge && {
      rule: documents.labelsDischarge.labelRule,
      allAcceptableCases: documents.labelsDischarge.allAcceptableCases,
      noneAcceptableCases: documents.labelsDischarge.noneAcceptableCases,
      partialCases: documents.labelsDischarge.partialCases,
      meanAcceptablePerCase: documents.labelsDischarge.meanAcceptablePerCase,
      randomBaseline: documents.labelsDischarge.randomBaseline,
      ruleBaseline: documents.labelsDischarge.ruleBaseline,
    },
    strictRollout: documents.labelsStrictRollout && {
      rule: documents.labelsStrictRollout.labelRule,
      focalIdle: documents.labelsStrictRollout.focalIdle,
      allAcceptableCases: documents.labelsStrictRollout.allAcceptableCases,
      noneAcceptableCases: documents.labelsStrictRollout.noneAcceptableCases,
      randomBaseline: documents.labelsStrictRollout.randomBaseline,
      ruleBaseline: documents.labelsStrictRollout.ruleBaseline,
    },
  },
  splits: documents.corpusBase && {
    bySplit: documents.corpusBase.bySplit,
    byEpisode: documents.corpusBase.byEpisode,
    splitSeed: documents.corpusBase.splitSeed,
    crossSplitTextMoves: documents.corpusBase.crossSplitTextMoves,
    corpusSha256: documents.corpusBase.corpusSha256,
  },
  cost: [
    costOf(documents.encodingTiming, 'encoder timing probe (4 forwards)'),
    costOf(documents.encoding, 'R10 corpus encoding'),
  ].filter(Boolean),
  training: {
    primary: documents.primaryTraining && {
      selected: documents.primaryTraining.selectedCheckpoint,
      selectedSha256: documents.primaryTraining.selectedCheckpointSha256,
      counts: documents.primaryTraining.counts,
      labelledCounts: documents.primaryTraining.labelledCounts,
      seconds: documents.primaryTraining.seconds,
      device: documents.primaryTraining.device,
      fourHeads: documents.primaryTraining.fourHeads,
      baseline: documents.primaryTraining.baseline,
      featureIdentityHash: documents.primaryTraining.featureIdentityHash,
    },
    primaryDevChoice: documents.primaryDev,
    primaryTest: documents.primaryTest && {
      metrics: documents.primaryTest.metrics,
      firstAndOnlyRun: documents.primaryTest.firstAndOnlyRun,
      exploratory: documents.primaryTest.exploratory,
    },
    discharge: documents.dischargeTraining && {
      selected: documents.dischargeTraining.selectedCheckpoint,
      selectedSha256: documents.dischargeTraining.selectedCheckpointSha256,
      labelledCounts: documents.dischargeTraining.labelledCounts,
      seconds: documents.dischargeTraining.seconds,
      fourHeads: documents.dischargeTraining.fourHeads,
      baseline: documents.dischargeTraining.baseline,
    },
    dischargeDevChoice: documents.dischargeDev,
    dischargeTest: documents.dischargeTest && {
      metrics: documents.dischargeTest.metrics,
      firstAndOnlyRun: documents.dischargeTest.firstAndOnlyRun,
      exploratory: documents.dischargeTest.exploratory,
    },
  },
  negativeControls: controls,
  files: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, {
    path,
    relPath: path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path,
    tracked: TRACKED.has(path.slice(root.length + 1)),
    exists: existsSync(path),
    sha256: shas[key] ?? null,
    bytes: existsSync(path) ? statSync(path).size : null,
  }])),
  headWeights: ['train-primary', 'train-discharge'].flatMap(dir => {
    const base = join(root, dir);
    if (!existsSync(base)) return [];
    return readdirSync(base).filter(name => name.endsWith('.safetensors')).sort()
      .map(name => ({ path: `${dir}/${name}`, sha256: sha(join(base, name)),
        bytes: statSync(join(base, name)).size }));
  }),
};
writeFileSync(join(root, 'EVIDENCE.json'), `${JSON.stringify(evidence, null, 2)}\n`);
const gpuHours = evidence.cost.reduce((sum, entry) => sum + entry.cardHoursActuallyResident, 0);
console.log(JSON.stringify({
  ok: true,
  evidence: join(root, 'EVIDENCE.json'),
  cases: evidence.capture?.cases,
  baseRule: evidence.labels.base?.ruleBaseline,
  dischargeRule: evidence.labels.discharge?.ruleBaseline,
  gpuCardHours: Number(gpuHours.toFixed(3)),
  forwards: evidence.cost.reduce((sum, entry) => sum + (entry.forwards ?? 0), 0),
  heads: evidence.headWeights.length,
  controls: evidence.negativeControls.map(control => control.name),
}, null, 2));
