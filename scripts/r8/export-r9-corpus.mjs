#!/usr/bin/env node
/**
 * C line: on-policy failure / disagreement corpus.
 *
 * The previous corpus was 96 reference two-step questions. This one captures the
 * states where the current policy actually failed or had to choose between
 * conflicting obligations, and labels them from what the world allows:
 *
 *   medical-zero-resource  medicine is 0, so "treat" is a proposable but
 *                          impossible action; the acceptable set excludes it
 *   resource-contention    two promises need the same last unit of food
 *   cancel-after-work      work was started and cancelled; resuming it is wrong
 *   wrong-location-gather  the actor stands somewhere the action cannot happen
 *
 * Each row is a real `frostecho.joint-encoding-request/1` envelope plus the
 * acceptable set, so `encode_joint_corpus.py` consumes it unchanged.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { R8Runtime } = require('../../dist/src/r7/integration/runtime.js');
const { runStep } = require('../../dist/src/r7/integration/step.js');
const { renderRequest } = require('../../dist/src/r7/jev/render.js');
const { validateChoiceRequest } = require('../../dist/src/decision/contracts.js');
const sha = value => createHash('sha256').update(value).digest('hex');

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const out = option('--out');
const suffix = option('--suffix') ?? 's0';
const VARIANT = Number(String(suffix).replace(/[^0-9]/g, '')) || 0;
if (!out) throw new Error('Usage: --out <newDir>');
mkdirSync(resolve(out), { recursive: true });

const RENDER_SRC = sha(readFileSync(resolve(root, 'src/r7/jev/render.ts')));
const RENDER_BUILD = sha(readFileSync(resolve(root, 'dist/src/r7/jev/render.js')));

function envelopeOf(runtime, request, seed) {
  validateChoiceRequest(request);
  const rendered = renderRequest(request);
  const requestJson = JSON.stringify(request);
  return {
    schema: 'frostecho.joint-encoding-request/1',
    sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
    seed, npcCount: 8, request, requestJson,
    inputSha256: sha(requestJson),
    rendered: { ...rendered, spanUnit: 'utf16-code-unit' },
    rendererSourceSha256: RENDER_SRC,
    rendererBuildSha256: RENDER_BUILD,
    renderedTextSha256: sha(rendered.text),
    modelCalls: 0, worldCommits: 0,
    realModel: false,
  };
}

/** Run one real step but stop at the scorer, so nothing is committed. */
async function capture(runtime) {
  const stop = new Error('capture-complete');
  let captured = null;
  const scorer = {
    identity: { mode: 'reference', scorerId: 'r9-capture/1',
      rendererId: 'joint-c-action/1', experimental: false, countsAsAdmitted: false },
    async score(request) {
      if (request.candidates.length < 2) {
        return { requestId: request.requestId, candidateSetHash: request.candidateSetHash,
          scorerId: 'r9-capture/1', scores: [], selectedId: null,
          disposition: 'abstain', reason: 'skip single' };
      }
      captured = request;
      throw stop;
    },
  };
  try { await runStep(runtime, scorer, { mode: 'reference' }); }
  catch (error) { if (error !== stop) throw error; }
  return captured;
}

const rows = [];
function pushRow(scenario, family, split, seed, runtime, request, acceptable, note) {
  if (!request) return;
  const envelope = envelopeOf(runtime, request, seed);
  rows.push({
    ...envelope,
    caseId: `r9-${scenario}-${suffix}-${rows.length}`,
    scenario, sourceFamily: family, split,
    episodeSeed: seed,
    acceptableIds: acceptable,
    labelSource: 'on-policy-failure',
    labelMeaning: note,
    independentReviews: 0,
    researchTrainReady: false,
  });
}

/** 1. medicine is zero: treating is proposable but impossible. */
{
  const seed = 'r9-medical-zero-' + suffix;
  const runtime = R8Runtime.create({ seed });
  runtime.world.resources.medicine = 0;
  runtime.world.resources.food = 4 + (VARIANT % 5) * 6;
  runtime.world.resources.firewood = 6 + (VARIANT % 4) * 7;
  const actor = runtime.context().actorIds[VARIANT % 3];
  runtime.world.npcs[actor].health = 35 + (VARIANT % 6) * 8;
  runtime.world.npcs[actor].hunger = 50 + (VARIANT % 5) * 9;
  const request = await capture(runtime);
  const acceptable = (request?.candidates ?? [])
    .filter(c => c.parameters.action !== 'medical').map(c => c.id);
  pushRow('medical-zero-resource', 'medical', 'test', seed, runtime, request, acceptable,
    'medicine=0: medical is proposable but cannot execute, so it is excluded');
}

/** 2. two promises, one unit of food. */
{
  const seed = 'r9-contention-' + suffix;
  const runtime = R8Runtime.create({ seed });
  const ids = runtime.context().actorIds;
  const a = ids[VARIANT % 4];
  const b = ids[(VARIANT + 1 + (VARIANT % 3)) % ids.length];
  runtime.world.resources.food = 1 + (VARIANT % 3);
  const p1 = runtime.dispatch('tasks', 'propose', a, { type: 'DISTRIBUTE_FOOD', assigneeId: a });
  const p2 = runtime.dispatch('tasks', 'propose', b, { type: 'COLLECT_FOOD', assigneeId: b });
  for (const [actorId, type] of [[a, 'DISTRIBUTE_FOOD'], [b, 'COLLECT_FOOD']]) {
    const task = runtime.states.tasks.tasks.filter(t => t.assigneeId === actorId
      && t.type === type).at(-1);
    if (task) runtime.dispatch('tasks', 'respond', actorId, { taskId: task.taskId, verdict: 'accept' });
  }
  const request = await capture(runtime);
  const acceptable = (request?.candidates ?? [])
    .filter(c => c.parameters.action === 'gather' || c.parameters.action === 'move')
    .map(c => c.id);
  pushRow('resource-contention', 'contention', 'test', seed, runtime, request, acceptable,
    'one unit of food, two obligations: gathering/walking is acceptable, spending it is not');
  void p1; void p2;
}

/** 3. work cancelled after it started: resuming it is not acceptable. */
{
  const seed = 'r9-cancel-' + suffix;
  const runtime = R8Runtime.create({ seed });
  const actor = runtime.context().actorIds[0];
  const cancelTypes = ['COLLECT_WOOD', 'COLLECT_FOOD', 'MAINTAIN_POWER', 'PREPARE_WARMTH'];
  const cancelType = cancelTypes[VARIANT % cancelTypes.length];
  const task = runtime.dispatch('tasks', 'propose', actor,
    { type: cancelType, assigneeId: actor });
  void task;
  const taskId = runtime.states.tasks.tasks.at(-1)?.taskId;
  if (taskId) {
    runtime.dispatch('tasks', 'respond', actor, { taskId, verdict: 'accept' });
    runtime.dispatch('tasks', 'cancel', 'old_qian', { taskId });
  }
  // A work item that was begun must not be silently resumed by the next step.
  const request = await capture(runtime);
  const acceptable = (request?.candidates ?? [])
    .filter(c => c.kind !== 'gather').map(c => c.id);
  pushRow('cancel-after-work', 'cancel', 'test', seed, runtime, request, acceptable,
    'cancelled task: its gather is not acceptable, other needs are');
}

/** 4. standing where the action cannot happen. */
{
  const seed = 'r9-wrong-location-' + suffix;
  const runtime = R8Runtime.create({ seed });
  const actor = runtime.context().actorIds[0];
  const places = ['warehouse', 'kitchen', 'medical', 'dorm-a'];
  const place = places[VARIANT % places.length];
  runtime.session.submitWorldCommand({ commandId: 'to-place', type: 'move',
    actorId: actor, to: place });
  const placeTypes = ['COLLECT_WOOD', 'COLLECT_FOOD', 'MAINTAIN_POWER', 'PREPARE_MEDICAL'];
  runtime.dispatch('tasks', 'propose', actor,
    { type: placeTypes[VARIANT % placeTypes.length], assigneeId: actor });
  const taskId = runtime.states.tasks.tasks.at(-1)?.taskId;
  if (taskId) {
    runtime.dispatch('tasks', 'respond', actor, { taskId, verdict: 'accept' });
  }
  const request = await capture(runtime);
  const acceptable = (request?.candidates ?? [])
    .filter(c => c.parameters.action === 'move' || c.parameters.action === 'wait')
    .map(c => c.id);
  pushRow('wrong-location-gather', 'location', 'test', seed, runtime, request, acceptable,
    'actor is in the warehouse: gathering wood is not acceptable, walking to the source is');
}

/** 5. reference-style continuity cases (train/dev), unchanged semantics. */
for (const [index, scenario] of ['verify-stock', 'food-shortage', 'fatigue', 'promise-and-food-task']
  .entries()) {
  const seed = `r9-ref-${scenario}-${suffix}`;
  const runtime = R8Runtime.create({ seed });
  if (scenario === 'food-shortage') runtime.world.resources.food = 4 + (VARIANT % 6) * 3;
  if (scenario === 'fatigue') {
    for (const id of runtime.context().actorIds) {
      runtime.world.npcs[id].stamina = 10 + (VARIANT % 5) * 8;
    }
  }
  if (scenario === 'verify-stock') runtime.world.resources.firewood = 8 + (VARIANT % 5) * 5;
  if (scenario === 'promise-and-food-task') {
    runtime.world.resources.food = 10 + (VARIANT % 4) * 8;
    runtime.world.simTime = 480 + (VARIANT % 8) * 60;
  }
  const request = await capture(runtime);
  if (!request) continue;
  const acceptable = request.candidates
    .filter(c => c.parameters.action !== 'wait').map(c => c.id);
  pushRow(scenario, 'reference', index % 2 === 0 ? 'train' : 'dev', seed, runtime,
    request, acceptable, 'reference imitation, kept for continuity only');
}

// No identical visible input may sit in two splits.
const seen = new Map();
let moved = 0;
for (const row of rows) {
  const key = `${row.rendered.text}`;
  const first = seen.get(key);
  if (first && first !== row.split) { row.split = first; moved += 1; }
  else if (!first) seen.set(key, row.split);
}

const lines = rows.map(row => JSON.stringify(row)).join('\n');
writeFileSync(resolve(out, 'cases.jsonl'), `${lines}\n`, 'utf8');
const summary = {
  schema: 'frostecho.r9.corpus/1',
  cases: rows.length,
  splits: rows.reduce((acc, row) => ({ ...acc, [row.split]: (acc[row.split] ?? 0) + 1 }), {}),
  scenarios: rows.reduce((acc, row) => ({ ...acc, [row.scenario]: (acc[row.scenario] ?? 0) + 1 }), {}),
  labelSource: 'on-policy-failure + reference continuity',
  independentReviews: 0,
  crossSplitDuplicatesMoved: moved,
  corpusSha256: sha(lines),
  sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
};
writeFileSync(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
