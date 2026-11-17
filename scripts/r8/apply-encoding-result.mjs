#!/usr/bin/env node
/** Replay one real score on the exact captured state; no online inference claim. */
import assert from 'node:assert/strict';
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
const { makeChoiceResult, validateChoiceRequest } = require('../../dist/src/decision/contracts.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const option = flag => {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} is required`);
  return resolve(args[i + 1]);
};
const requestPath = option('--request'), resultPath = option('--result'), out = option('--out');
assert.equal(existsSync(out), false, 'Choose a new output path');
const requestBytes = readFileSync(requestPath), resultBytes = readFileSync(resultPath);
const captured = JSON.parse(requestBytes), result = JSON.parse(resultBytes);
assert.equal(captured.schema, 'frostecho.joint-encoding-request/1');
assert.equal(result.schema, 'frostecho.r8.joint-live-probe/2');
assert.deepEqual(JSON.parse(captured.requestJson), captured.request);
assert.equal(sha(captured.requestJson), captured.inputSha256);
validateChoiceRequest(captured.request);
assert.equal(result.status, 'encoded');
assert.equal(result.encoderForwardCalls, 1); assert.equal(result.headForwardCalls, 1);
assert.equal(result.gameCommits, 0); assert.equal(result.experimental, true);
assert.equal(result.countsAsAdmitted, false); assert.equal(result.calibrated, false);
assert.equal(result.requestFileSha256, sha(requestBytes));
assert.equal(result.input.inputSha256, captured.inputSha256);
assert.equal(result.input.candidateSetHash, captured.request.candidateSetHash);
const ids = captured.request.candidates.map(candidate => candidate.id);
assert.deepEqual(result.input.candidateIds, ids);
assert.deepEqual(result.scores.map(score => score.candidateId), ids);
assert.deepEqual(result.forward.shape, [ids.length, 5120]);
assert.equal(result.input.rendererSourceSha256, captured.rendererSourceSha256);
assert.equal(sha(readFileSync(resolve(root, 'src/r7/jev/render.ts'))), captured.rendererSourceSha256);
assert.equal(sha(readFileSync(resolve(root, 'dist/src/r7/jev/render.js'))), captured.rendererBuildSha256);
assert.equal(result.selectedId, result.scores.reduce((a, b) => b.logit > a.logit ? b : a).candidateId);
assert.equal(captured.npcCount, 8); assert.equal(typeof captured.seed, 'string');
const identity = { mode: 'jev-experimental', scorerId: 'jev-real-score-replay/1',
  checkpointSha256: result.headSha256, encoderId: result.encoder.modelPath,
  rendererId: result.input.rendererId, memoryPolicyId: captured.request.memoryPolicyVersion,
  experimental: true, countsAsAdmitted: false };
const runtime = R8Runtime.create({ seed: captured.seed, npcCount: captured.npcCount });
const snapshot = () => structuredClone({ world: runtime.world, states: runtime.states });
const before = snapshot(), priorIds = new Set(runtime.committedEvents().map(event => event.eventId));
const stop = new Error('one-score-replay-complete');
let scoreRequests = 0, replayed = false;
const scorer = { identity, async score(request) {
  if (++scoreRequests > 1) throw stop;
  assert.equal(sha(JSON.stringify(request)), captured.inputSha256, 'Recreated request differs');
  const choice = makeChoiceResult({ request, scorerId: identity.scorerId, scores: result.scores,
    selectedId: result.selectedId, disposition: 'accept', reason: 'real score replay; uncalibrated experiment' });
  replayed = true;
  return choice;
} };
try { await runStep(runtime, scorer, { mode: 'jev-experimental', memoryPolicy: captured.request.memoryPolicyVersion }); }
catch (error) { if (error !== stop) throw error; }
assert.equal(replayed, true);
const after = snapshot(), added = runtime.committedEvents().filter(event => !priorIds.has(event.eventId));
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
assert.equal(git.status, 0);
const report = { schema: 'frostecho.real-score-replay/1', sourceHEAD: git.stdout.trim(),
  evidenceClass: 'real-model-score-replay', requestFile: requestPath, resultFile: resultPath,
  resultFileSha256: sha(resultBytes), inputSha256: captured.inputSha256, identity,
  selectedId: result.selectedId, selectedCandidate: captured.request.candidates.find(c => c.id === result.selectedId),
  scores: result.scores, before, after, committedAdded: added,
  worldVersionBefore: before.world.version, worldVersionAfter: after.world.version,
  executionValidated: added.length > 0 && after.world.version === before.world.version + 1,
  encoderForwardCalls: 0, headForwardCalls: 0, scoreReplays: 1,
  sourceInferenceCounts: { encoderForwardCalls: 1, headForwardCalls: 1 },
  worldChanged: JSON.stringify(before) !== JSON.stringify(after),
  note: 'Replays one measured real-model score on the identical input. Not an online service, new inference, action-quality result or calibration guarantee.' };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
assert.ok(added.length > 0, 'Score replay produced no committed receipt; inspect saved report');
assert.equal(after.world.version, before.world.version + 1, 'Expected exactly one world commit');
console.log(JSON.stringify({ ok: true, out, evidenceClass: report.evidenceClass, selectedId: result.selectedId,
  committedEvents: added.map(event => event.eventId), worldVersionBefore: report.worldVersionBefore,
  worldVersionAfter: report.worldVersionAfter, encoderForwardCalls: 0, headForwardCalls: 0 }));
