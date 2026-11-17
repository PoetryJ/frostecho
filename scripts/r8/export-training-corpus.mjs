#!/usr/bin/env node
/** Exploratory imitation only: actual requests, reference choices, committed receipts. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { R8Runtime } = require('../../dist/src/r7/integration/runtime.js');
const { runStep } = require('../../dist/src/r7/integration/step.js');
const { referenceAgencyScorer } = require('../../dist/src/r7/agency/reference.js');
const { renderRequest, renderCandidateText } = require('../../dist/src/r7/jev/render.js');
const { validateChoiceRequest } = require('../../dist/src/decision/contracts.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const outArg = option('--out');
if (!outArg) throw new Error('Usage: node scripts/r8/export-training-corpus.mjs --out <newDir> [--seed <seed>]');
const out = resolve(outArg);
if (existsSync(out)) throw new Error(`Refusing existing output directory: ${out}`);
const corpusSeed = option('--seed', 'r8live-weak-reference-96-v1');
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (git.status !== 0) throw new Error('Cannot identify source HEAD');
const sourceHEAD = git.stdout.trim();
const sourceFiles = ['src/r7/integration/step.ts', 'src/r7/integration/runtime.ts',
  'src/r7/agency/reference.ts', 'src/r7/agency/options.ts', 'src/r7/jev/render.ts',
  'dist/src/r7/integration/step.js', 'dist/src/r7/integration/runtime.js',
  'dist/src/r7/agency/reference.js', 'dist/src/r7/agency/options.js',
  'dist/src/r7/jev/render.js', 'scripts/r8/export-training-corpus.mjs'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha(readFileSync(resolve(root, file)))]));
const scenarios = ['verify-stock', 'food-shortage', 'wood-shortage', 'hunger',
  'fatigue', 'maintain-power', 'build-generator', 'promise-and-food-task'];
const rows = [], episodes = [], rejected = [];
const exactSeen = new Map(), semanticSeen = new Map();
const stats = { scored: 0, applied: 0, duplicateExact: 0, duplicateSemantic: 0,
  crossSplitDuplicatesRejected: 0, nonApplied: 0, candidateCountRejected: 0 };
const distribution = values => values.reduce((counts, value) =>
  ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
// Random instance IDs must not manufacture uniqueness. Candidate IDs/order are
// ignored for the second key, while all actual model-visible semantics remain.
const normalizeIds = text => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
function semanticKey(request, rendered) {
  return sha(normalizeIds(JSON.stringify({
    context: rendered.segments.filter(segment => segment.kind !== 'candidate').map(segment => segment.text),
    candidates: request.candidates.map(renderCandidateText).sort(),
  })));
}
function setup(runtime, scenario, episodeSeed) {
  const actorId = runtime.context().actorIds[0], journal = [];
  const command = fields => {
    const input = { commandId: `${episodeSeed}-setup-${journal.length}`, actorId, ...fields };
    const result = runtime.session.submitWorldCommand(input);
    if (result.status !== 'applied') throw new Error(`Setup failed: ${JSON.stringify(result)}`);
    runtime.recordCommitted(result.events ?? []);
    journal.push({ kind: 'world-command', input, result });
  };
  const assign = type => {
    const proposed = runtime.dispatch('tasks', 'propose', actorId, { type, assigneeId: actorId });
    const taskId = runtime.states.tasks.tasks.at(-1)?.taskId;
    const accepted = runtime.dispatch('tasks', 'respond', actorId, { taskId, verdict: 'accept' });
    if (proposed.rejected.length || accepted.rejected.length) throw new Error('Task setup rejected');
    journal.push({ kind: 'accepted-assignment', type, taskId, proposed, accepted });
  };
  if (scenario === 'food-shortage') {
    command({ type: 'move', to: 'warehouse' });
    command({ type: 'withdraw', place: 'warehouse', resource: 'food', amount: 1 });
  }
  if (scenario === 'hunger') {
    const minutes = 2100 + Number.parseInt(sha(episodeSeed).slice(0, 2), 16) % 80;
    journal.push({ kind: 'advance', minutes, result: runtime.advanceWorld(runtime.world.simTime + minutes) });
  }
  if (scenario === 'fatigue') {
    command({ type: 'work', minutes: 240 });
    journal.push({ kind: 'advance', minutes: 30, result: runtime.advanceWorld(runtime.world.simTime + 30) });
  }
  if (scenario === 'maintain-power') assign('MAINTAIN_POWER');
  if (scenario === 'build-generator') assign('BUILD_GENERATOR');
  if (scenario === 'promise-and-food-task') {
    journal.push({ kind: 'player-promise', result: runtime.session.playerPromise(actorId, `${episodeSeed}-promise`) });
    assign('COLLECT_FOOD');
  }
  return { actorId, journal };
}

for (const [split, perScenario] of [['train', 8], ['dev', 2], ['test', 2]]) {
  for (const scenario of scenarios) {
    let acceptedCount = 0;
    for (let trial = 0; acceptedCount < perScenario && trial < 16; trial += 1) {
      // Every episode and any future permutations/counterfactuals inherit this
      // single sourceFamily and split. No trajectory is sliced across splits.
      const episodeSeed = `${corpusSeed}/${split}/${scenario}/${trial}`;
      const random = Number.parseInt(sha(episodeSeed).slice(0, 8), 16);
      const resources = { food: 45 + random % 99, firewood: 30 + (random >>> 8) % 40,
        power: 25 + (random >>> 16) % 31, medicine: 2 + (random >>> 24) % 5 };
      if (scenario === 'food-shortage') resources.food = 0;
      if (scenario === 'wood-shortage') resources.firewood = (random >>> 8) % 8;
      if (scenario === 'maintain-power') resources.power = (random >>> 16) % 10;
      const runtime = R8Runtime.create({ seed: episodeSeed, npcCount: 8, resources });
      const { actorId, journal } = setup(runtime, scenario, episodeSeed);
      const episode = { episodeSeed, sourceFamily: episodeSeed, split, scenario, resources,
        setup: journal, initialWorld: structuredClone(runtime.world),
        initialStates: structuredClone(runtime.states), decisions: [], caseIds: [] };
      const baseScorer = referenceAgencyScorer();
      for (let step = 0; step < 2 && acceptedCount < perScenario; step += 1) {
        let captured, choice;
        const beforeVersion = runtime.world.version;
        const scorer = { identity: baseScorer.identity, async score(incoming) {
          const request = JSON.parse(JSON.stringify(incoming));
          validateChoiceRequest(request);
          const rendered = renderRequest(request);
          for (const span of rendered.candidateSpans) {
            const segment = rendered.segments.find(value => value.kind === 'candidate' && value.index === span.index);
            if (!segment || rendered.text.slice(span.start, span.end) !== segment.text) throw new Error('Span mismatch');
          }
          const requestJson = JSON.stringify(request);
          captured = { schema: 'frostecho.joint-encoding-request/1', sourceHEAD,
            nodeVersion: process.version, seed: episodeSeed, npcCount: 8, request, requestJson,
            inputSha256: sha(requestJson), rendered: { ...rendered, spanUnit: 'utf16-code-unit' },
            rendererSourceSha256: sourceHashes['src/r7/jev/render.ts'],
            rendererBuildSha256: sourceHashes['dist/src/r7/jev/render.js'],
            renderedTextSha256: sha(rendered.text), modelCalls: 0, capturedBeforeCommit: true,
            worldVersionBefore: runtime.world.version };
          choice = await baseScorer.score(incoming);
          stats.scored += 1;
          return choice;
        } };
        const result = await runStep(runtime, scorer, { mode: 'reference', actorIds: [actorId],
          memoryPolicy: 'conditional-experience' });
        const record = result.records[0];
        const receipts = (record?.eventIds ?? []).map(id => runtime.committedEvent(id));
        episode.decisions.push({ step, record, choice, receipts, beforeVersion, afterVersion: runtime.world.version });
        if (!captured || record?.executionStatus !== 'applied' || !receipts.length
          || receipts.some(receipt => !receipt) || runtime.world.version <= beforeVersion) {
          stats.nonApplied += 1;
          rejected.push({ episodeSeed, step, reason: 'no-authoritative-applied-receipt', record });
          break;
        }
        stats.applied += 1;
        const k = captured.request.candidates.length;
        if (k < 2 || k > 8) { stats.candidateCountRejected += 1; continue; }
        const exact = captured.renderedTextSha256, semantic = semanticKey(captured.request, captured.rendered);
        const duplicate = exactSeen.get(exact) ?? semanticSeen.get(semantic);
        if (duplicate) {
          stats[exactSeen.has(exact) ? 'duplicateExact' : 'duplicateSemantic'] += 1;
          if (duplicate.split !== split) stats.crossSplitDuplicatesRejected += 1;
        } else {
          const selected = captured.request.candidates.find(candidate => candidate.id === choice.selectedId);
          if (!selected) throw new Error('Reference selected absent candidate');
          const caseId = `weak-${sha(`${episodeSeed}/${step}`).slice(0, 20)}`;
          const row = { ...captured, caseId, split, episodeSeed, sourceFamily: episodeSeed,
            sourcefamily: episodeSeed, augmentationGroup: `${episodeSeed}/root`, scenario,
            variant: 'original', counterfactual: false, orderVariant: false,
            permutationInvariantSha256: semantic, acceptableIds: [choice.selectedId],
            selectedId: choice.selectedId, selectedAction: selected.parameters.action,
            selectedResource: selected.parameters.resource ?? null,
            labelSource: 'reference-imitation', independentReviews: 0, researchTrainReady: false,
            labelMeaning: 'single reference-policy choice; not an independently adjudicated acceptable set',
            referenceScorerId: choice.scorerId, execution: { record, committedReceipts: receipts,
              beforeVersion, afterVersion: runtime.world.version },
            evidenceClass: 'real-engine-reference-rollout', realModel: false };
          rows.push(row); episode.caseIds.push(caseId); acceptedCount += 1;
          exactSeen.set(exact, { split, caseId }); semanticSeen.set(semantic, { split, caseId });
        }
        if (step === 0) episode.decisions.push({ kind: 'advance', minutes: 15,
          result: runtime.advanceWorld(runtime.world.simTime + 15) });
      }
      episode.finalWorld = structuredClone(runtime.world);
      episode.finalStates = structuredClone(runtime.states);
      episode.committedEvents = runtime.committedEvents();
      episodes.push(episode);
    }
    if (acceptedCount !== perScenario) throw new Error(`Insufficient unique samples: ${split}/${scenario}=${acceptedCount}`);
  }
}
const expected = { train: 64, dev: 16, test: 16 };
const actual = distribution(rows.map(row => row.split));
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Incorrect split counts: ${JSON.stringify(actual)}`);
const actionDistribution = distribution(rows.map(row => row.selectedAction));
if (Object.keys(actionDistribution).length < 5) throw new Error('Insufficient actual action diversity');
for (const row of rows) {
  if (JSON.stringify(JSON.parse(row.requestJson)) !== JSON.stringify(row.request)
    || sha(row.requestJson) !== row.inputSha256
    || renderRequest(row.request).text !== row.rendered.text) throw new Error('Envelope not independently reproducible');
}
const summary = { schema: 'frostecho.exploratory-reference-corpus/1', sourceHEAD,
  sourceHashes, nodeVersion: process.version, corpusSeed, counts: actual, uniqueInputs: rows.length,
  uniquePermutationInvariantInputs: semanticSeen.size, episodes: episodes.length,
  scenarios: distribution(rows.map(row => row.scenario)), actionDistribution,
  candidateCountDistribution: distribution(rows.map(row => row.request.candidates.length)),
  labelIndexDistribution: distribution(rows.map(row => row.request.candidates.findIndex(c => c.id === row.selectedId))),
  labelsBySplit: Object.fromEntries(Object.keys(expected).map(split => [split,
    distribution(rows.filter(row => row.split === split).map(row => row.selectedAction))])),
  stats, modelCalls: 0, labelSource: 'reference-imitation', independentReviews: 0,
  researchTrainReady: false, mayTrainOnJev: false, explorationTrainingAuthorized: true,
  limitations: ['Reference imitation is not an optimality or calibration label.',
    'Two-decision episodes do not demonstrate long-horizon model intelligence.',
    'Promise context is present but reference scores are not evidence of understanding it.',
    'No candidate permutations or counterfactual branches generated in this budget; any future variants must retain sourceFamily/split.',
    'Native promise instance UUIDs vary across reruns; normalized semantic dedup ignores UUIDs.'] };
mkdirSync(out, { recursive: true });
const jsonl = list => list.map(row => JSON.stringify(row)).join('\n') + '\n';
writeFileSync(resolve(out, 'cases.jsonl'), jsonl(rows), { flag: 'wx' });
for (const split of Object.keys(expected)) writeFileSync(resolve(out, `${split}.jsonl`),
  jsonl(rows.filter(row => row.split === split)), { flag: 'wx' });
writeFileSync(resolve(out, 'episodes.jsonl'), jsonl(episodes), { flag: 'wx' });
writeFileSync(resolve(out, 'rejected.json'), JSON.stringify(rejected, null, 2) + '\n', { flag: 'wx' });
summary.files = Object.fromEntries(['cases.jsonl', 'train.jsonl', 'dev.jsonl', 'test.jsonl',
  'episodes.jsonl', 'rejected.json'].map(file => [file, sha(readFileSync(resolve(out, file)))]));
writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ok: true, out, ...summary, sourceHashes: undefined, files: undefined }));
