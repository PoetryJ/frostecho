import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openCli } from './cli-session.mjs';
const require = createRequire(import.meta.url);
const { R8Runtime } = require('../../dist/src/r7/integration/runtime.js');
const { GameplayLoop } = require('../../dist/src/gameplay-v2/loop.js');
const { createCommitmentBridge } = require('../../dist/src/r7/integration/commitment-bridge.js');
const root = process.cwd();
const out = resolve('artifacts/r8-commitment-bridge', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });

function fixture(name) {
  const dir = join(out, name); mkdirSync(dir, { recursive: true });
  const runtime = R8Runtime.create({ seed: 'bridge-empty-warehouse', resources: { food: 130 } });
  runtime.enableLegacySpatial();
  // Registered scenario condition, not an unrecorded in-run stock mutation.
  runtime.world.spatial = { positions: {}, stocks: { warehouse: { food: 0 } },
    carry: {}, deliveredMeals: 0, closedCells: [] };
  const play = new GameplayLoop(runtime.session), state = join(dir, 'session.json');
  play.save(state); runtime.save(state);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ seed: 'bridge-empty-warehouse',
    warehouseFood: 0, publicFood: 130, fullOriginalMaps: true, evidenceClass: 'reference' }, null, 2));
  return { dir, state, runtime, play };
}
const open = state => openCli(root, ['--profile', 'gospel-5.8.19', '--state', state]);

test('real CLI: accepted promise -> observed shortage -> explicit change -> gather/deposit/withdraw/deliver -> one fulfilment', { timeout: 30000 }, async () => {
  const { dir, state } = fixture('delivery');
  let cli = open(state), commitmentId, taskId;
  const records = [];
  try {
    await cli.ready;
    const requested = await cli.send('request npc_01 deliver-meal');
    assert.equal(requested.commitment.status, 'active');
    commitmentId = requested.commitment.commitmentId; taskId = requested.task.taskId;
    records.push(requested);
    let status;
    for (let i = 0; i < 20; i++) {
      const step = await cli.send('r8-step npc_01'); records.push(step);
      status = await cli.send('commitment-status');
      if (status.commitments.find(row => row.commitmentId === commitmentId).status === 'pending-change') break;
    }
    assert.equal(status.commitments.find(row => row.commitmentId === commitmentId).status, 'pending-change');
    assert.ok(records.some(row => row.records?.some(record => record.observationText.includes(commitmentId))));
    await cli.send('save'); records.push(...cli.records); await cli.close();
    cli = open(state); await cli.ready;
    const accepted = await cli.send(`respond-change ${commitmentId} accept`);
    assert.equal(accepted.commitment.revision, 2); records.push(accepted);
    const actions = [];
    for (let i = 0; i < 30; i++) {
      const step = await cli.send('r8-step npc_01'); records.push(step);
      for (const record of step.records ?? []) {
        const candidate = record.candidates.find(row => row.id === record.selectedId);
        if (candidate?.parameters.commitmentId === commitmentId && record.executionStatus === 'applied')
          actions.push(candidate.parameters.action);
      }
      status = await cli.send('commitment-status');
      if (status.commitments.find(row => row.commitmentId === commitmentId).status === 'fulfilled') break;
    }
    const completed = status.commitments.find(row => row.commitmentId === commitmentId);
    assert.equal(completed.status, 'fulfilled', JSON.stringify({ actions, completed }));
    assert.equal(completed.taskId, taskId);
    assert.equal(status.tasks.filter(row => row.commitmentId === commitmentId).length, 1);
    assert.equal(status.tasks.find(row => row.taskId === taskId).status, 'done');
    for (const action of ['gather', 'deposit', 'withdraw', 'deliver']) assert.ok(actions.includes(action), JSON.stringify(actions));
    const authority = await cli.send('r8-status');
    const fulfilmentReceipts = authority.runtime.committed.filter(row => completed.evidenceEventIds.includes(row.eventId)
      && row.type === 'meal_delivered');
    assert.equal(fulfilmentReceipts.length, 1);
    const receipt = fulfilmentReceipts[0];
    assert.equal(receipt.type, 'meal_delivered'); assert.equal(receipt.actorId, 'npc_01');
    assert.equal(receipt.payload.to, 'kitchen'); assert.equal(receipt.payload.amount, 1);
    await cli.send('save'); await cli.close();
    cli = open(state); await cli.ready;
    const restored = await cli.send('commitment-status');
    assert.deepEqual(restored.commitments.find(row => row.commitmentId === commitmentId), completed);
    const later = await cli.send('r8-step npc_01');
    assert.ok(later.records.every(row => row.candidates.every(candidate => candidate.parameters.commitmentId !== commitmentId)));
    writeFileSync(join(dir, 'story.json'), JSON.stringify({ commitmentId, taskId, actions, completed, receipt, records }, null, 2));
    await cli.close();
  } finally { if (cli.child.exitCode === null) await cli.close().catch(() => cli.kill()); }
});

test('cancelled promise keeps its original terminal/task IDs and never produces a bound candidate', { timeout: 15000 }, async () => {
  const { dir, state } = fixture('cancel'); const cli = open(state);
  try {
    await cli.ready;
    const request = await cli.send('request npc_01 deliver-meal');
    const id = request.commitment.commitmentId, taskId = request.task.taskId;
    await cli.send(`cancel-commitment ${id}`);
    const before = await cli.send('task-status');
    const steps = [];
    for (let i = 0; i < 6; i++) steps.push(await cli.send('r8-step npc_01'));
    const status = await cli.send('commitment-status');
    assert.equal(status.commitments.find(row => row.commitmentId === id).status, 'cancelled');
    assert.equal(status.tasks.find(row => row.taskId === taskId).status, 'cancelled');
    assert.ok(steps.every(step => step.records.every(row => row.candidates.every(candidate => candidate.parameters.commitmentId !== id))));
    assert.deepEqual(status.commitments.find(row => row.commitmentId === id).evidenceEventIds, []);
    const after = await cli.send('task-status');
    assert.equal(after.status.spatial.deliveredMeals, before.status.spatial.deliveredMeals);
    writeFileSync(join(dir, 'cancel.json'), JSON.stringify({ id, taskId, steps, status }, null, 2));
    await cli.close();
  } finally { if (cli.child.exitCode === null) await cli.close().catch(() => cli.kill()); }
});

test('supply closes only on the named task real committed deposit; forged receipt has no effect', async () => {
  const { dir, runtime, play } = fixture('supply');
  const response = play.requestCommitment('npc_01', 'supply-warehouse', { verdict: 'accept' });
  const bridge = createCommitmentBridge(runtime, play);
  const candidate = bridge.view('npc_01').candidates[0];
  bridge.afterCommit('npc_01', candidate, ['made-up:stock_deposited:0']);
  assert.equal(play.commitments.find(response.commitment.commitmentId).status, 'active');
  const { runStep } = require('../../dist/src/r7/integration/step.js');
  const { referenceAgencyScorer } = require('../../dist/src/r7/agency/reference.js');
  const trace = [];
  for (let i = 0; i < 15; i++) {
    trace.push(await runStep(runtime, referenceAgencyScorer(), { actorIds: ['npc_01'], goalBridge: bridge }));
    if (play.commitments.find(response.commitment.commitmentId).status === 'fulfilled') break;
  }
  const row = play.commitments.find(response.commitment.commitmentId);
  assert.equal(row.status, 'fulfilled'); assert.equal(row.evidenceEventIds.length, 1);
  assert.equal(runtime.committedEvent(row.evidenceEventIds[0]).type, 'stock_deposited');
  assert.equal(play.board.tasks.length, 1);
  writeFileSync(join(dir, 'supply.json'), JSON.stringify({ commitment: row, trace }, null, 2));
});

test('ledger-only cancellation or pending change during scorer await prevents the world command itself', async () => {
  const { runStep } = require('../../dist/src/r7/integration/step.js');
  const { makeChoiceResult } = require('../../dist/src/decision/contracts.js');
  const controls = [];
  for (const mutation of ['cancel', 'change']) {
    const { runtime, play } = fixture(`late-${mutation}`);
    const accepted = play.requestCommitment('npc_01', 'supply-warehouse', { verdict: 'accept' });
    const bridge = createCommitmentBridge(runtime, play);
    let release, captured, started;
    const ready = new Promise(resolve => { started = resolve; });
    const scorer = { identity: { mode: 'reference', scorerId: 'delayed-reference/1', experimental: false, countsAsAdmitted: false },
      score(request) { captured = request; started(); return new Promise(resolve => { release = resolve; }); } };
    const step = runStep(runtime, scorer, { actorIds: ['npc_01'], goalBridge: bridge });
    await ready;
    const world = JSON.stringify(runtime.world);
    const memory = runtime.session.memories.get('npc_01').snapshotHash();
    if (mutation === 'cancel') play.commitments.cancel(accepted.commitment.commitmentId, { at: runtime.world.simTime });
    else play.commitments.proposeChange(accepted.commitment.commitmentId, {
      kind: 'suspend', reason: 'test independent ledger change', terms: { resumeWhen: 'hunger>=60' }, at: runtime.world.simTime });
    assert.equal(JSON.stringify(runtime.world), world);
    assert.equal(runtime.session.memories.get('npc_01').snapshotHash(), memory);
    const selected = captured.candidates.find(row => row.parameters.commitmentId === accepted.commitment.commitmentId);
    release(makeChoiceResult({ request: captured, scorerId: 'delayed-reference/1',
      scores: captured.candidates.map(row => ({ candidateId: row.id, logit: row.id === selected.id ? 1 : 0 })),
      selectedId: selected.id, disposition: 'accept', reason: 'released after ledger mutation' }));
    const result = await step;
    assert.equal(result.executed, 0); assert.equal(result.records[0].executionStatus, 'stale');
    assert.deepEqual(result.records[0].eventIds, []);
    assert.equal(JSON.stringify(runtime.world), world, 'late result must not execute any world command');
    controls.push({ mutation, selectedId: selected.id, result });
  }
  writeFileSync(join(out, 'late-ledger-controls.json'), JSON.stringify(controls, null, 2));
});
console.log(`Commitment bridge evidence: ${out}`);
