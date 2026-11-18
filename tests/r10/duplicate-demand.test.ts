/**
 * R10 (A): a re-issued demand must dedupe, a second instance must not.
 *
 * The same actor asking again for the same action while the first request is
 * still queued is ONE demand: two receipts or two work hours would double the
 * world's answer to a single intention. Two different task instances of the
 * same type are two demands, so dedupe must never swallow the second one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../../src/decision/contracts';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { demandIdOf } from '../../src/r7/integration/action-intent';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { auditSettlement, loadFourDaySidecars, saveFourDaySidecars }
  from '../../src/r7/integration/sidecar';

const START = 480;
const DUE = START + 60;

function rest(id: string): Candidate {
  return { id, kind: 'rest', description: '休息 60 分钟',
    parameters: { action: 'rest', minutes: 60 }, preconditions: [],
    expectedEffects: {}, utilityComponents: {} };
}

function taskCandidate(taskId: string): Candidate {
  return { id: `task-option-${taskId}`, kind: 'gather', description: '采集食物',
    parameters: { action: 'gather', resource: 'food', taskId, taskType: 'COLLECT_FOOD',
      minutes: 30 }, preconditions: [], expectedEffects: {}, utilityComponents: {} };
}

function assign(runtime: R8Runtime, type: string): string {
  runtime.dispatch('tasks', 'propose', 'npc_01', { type, assigneeId: 'npc_01' });
  const taskId = (runtime.states.tasks as { tasks: { taskId: string }[] })
    .tasks.at(-1)!.taskId;
  runtime.dispatch('tasks', 'respond', 'npc_01', { taskId, verdict: 'accept' });
  return taskId;
}

test('the same demand re-issued while queued occupies the body once and pays once', () => {
  const runtime = R8Runtime.create({ seed: 'r10-demand' });
  runtime.world.npcs.npc_01.stamina = 40;
  const first = runtime.beginIntent({ intentId: 'npc_01-rest-1', commandId: 'cmd-1',
    actorId: 'npc_01', candidate: rest('rest-60'), minutes: 60 });
  assert.ok('intent' in first);
  const second = runtime.beginIntent({ intentId: 'npc_01-rest-2', commandId: 'cmd-2',
    actorId: 'npc_01', candidate: rest('rest-60'), minutes: 60 });
  assert.ok('intent' in second);
  assert.equal(second.duplicate, true);
  assert.equal(second.intent.intentId, 'npc_01-rest-1');
  assert.equal(runtime.intents.size, 1, 'one queued intent, not two');
  assert.equal(runtime.work.size, 1, 'one occupied body');
  assert.equal(runtime.workLog.length, 0, 'nothing is settled by a duplicate');
  assert.equal(runtime.duplicateDemands.length, 1);
  assert.equal(runtime.duplicateDemands[0].demandId, first.intent.demandId);
  assert.equal(runtime.duplicateDemands[0].dueAt, DUE, 'the duplicate adds no work time');

  // The R9 compatibility wrapper goes through the same demand identity.
  const wrapper = runtime.beginWork('npc_01', 'rest', 'cmd-3', rest('rest-60'), 60);
  assert.ok('startedAt' in wrapper);
  assert.deepEqual(wrapper, { startedAt: START, endsAt: DUE });
  assert.equal(runtime.duplicateDemands.length, 2);

  runtime.advanceWorld(DUE);
  assert.equal(runtime.world.simTime, DUE);
  const entries = runtime.workLog.filter(entry => entry.intentId === 'npc_01-rest-1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'applied');
  assert.equal(entries[0].eventIds.length, 1, 'exactly one receipt for one demand');
  assert.equal(entries[0].endsAt - entries[0].startedAt, 60, 'one hour charged, not two');
  const restEvents = runtime.committedEvents()
    .filter(event => event.type === 'rested' && event.actorId === 'npc_01');
  assert.equal(restEvents.length, 1);
  assert.equal(restEvents[0].payload.minutes, 60);
  const gain = runtime.world.npcs.npc_01.stamina - 40;
  assert.ok(gain >= 8 && gain <= 13, `one rest's net gain ${gain}`);
  const audit = auditSettlement(runtime, new GameplayLoop(runtime.session));
  assert.deepEqual(audit.duplicates.settledTwice, []);
  assert.equal(audit.duplicateDemands, 2);
});

test('two task instances of the same type are two demands, never one', () => {
  const runtime = R8Runtime.create({ seed: 'r10-demand-tasks' });
  const first = assign(runtime, 'COLLECT_FOOD');
  const second = assign(runtime, 'COLLECT_FOOD');
  runtime.session.submitWorldCommand({ commandId: 'to-village',
    type: 'move', actorId: 'npc_01', to: 'village' });
  const firstCandidate = taskCandidate(first), secondCandidate = taskCandidate(second);
  assert.notEqual(demandIdOf({ actorId: 'npc_01', candidate: firstCandidate,
    taskId: first, commitmentId: null, commitmentRevision: null }),
  demandIdOf({ actorId: 'npc_01', candidate: secondCandidate,
    taskId: second, commitmentId: null, commitmentRevision: null }));

  const queued = runtime.beginIntent({ intentId: 'task-a', commandId: 'cmd-a',
    actorId: 'npc_01', candidate: firstCandidate, minutes: 30,
    taskId: first, taskType: 'COLLECT_FOOD' });
  assert.ok('intent' in queued);
  // A second Open task for the same body is busy, NOT a duplicate demand.
  const blocked = runtime.beginIntent({ intentId: 'task-b', commandId: 'cmd-b',
    actorId: 'npc_01', candidate: secondCandidate, minutes: 30,
    taskId: second, taskType: 'COLLECT_FOOD' });
  assert.ok('rejected' in blocked);
  assert.match(blocked.rejected, /busy/);
  assert.equal(runtime.duplicateDemands.length, 0, 'a different instance is not deduped');

  runtime.advanceWorld(START + 30);
  // Domain states are replaced by each dispatch: always re-read the live rows.
  const rows = () => (runtime.states.tasks as
    { tasks: { taskId: string; status: string }[] }).tasks;
  assert.equal(rows().find(row => row.taskId === first)!.status, 'done');
  assert.equal(rows().find(row => row.taskId === second)!.status, 'accepted');

  const next = runtime.beginIntent({ intentId: 'task-b', commandId: 'cmd-b-2',
    actorId: 'npc_01', candidate: secondCandidate, minutes: 30,
    taskId: second, taskType: 'COLLECT_FOOD' });
  assert.ok('intent' in next);
  runtime.advanceWorld(START + 60);
  assert.equal(rows().find(row => row.taskId === second)!.status, 'done');
  const completions = runtime.committedEvents()
    .filter(event => event.type === 'task_completed');
  assert.deepEqual(completions.map(event => event.payload.taskId), [first, second]);
});

test('a restored queue still dedupes a re-issued demand in a new process-like load', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frostecho-r10-demand-restore-'));
  try {
    const base = join(directory, 'state.json');
    const runtime = R8Runtime.create({ seed: 'r10-demand-restore' });
    const play = new GameplayLoop(runtime.session);
    const begun = runtime.beginIntent({ intentId: 'npc_02-rest-1', commandId: 'cmd-1',
      actorId: 'npc_02', candidate: rest('rest-60'), minutes: 60 });
    assert.ok('intent' in begun);
    saveFourDaySidecars(runtime, play, base);

    const restored = loadFourDaySidecars(base);
    const again = restored.runtime.beginIntent({ intentId: 'npc_02-rest-2',
      commandId: 'cmd-2', actorId: 'npc_02', candidate: rest('rest-60'), minutes: 60 });
    assert.ok('intent' in again);
    assert.equal(again.duplicate, true);
    assert.equal(again.intent.intentId, 'npc_02-rest-1');
    assert.equal(restored.runtime.intents.size, 1);
    assert.equal(restored.runtime.duplicateDemands.length, 1);
    assert.equal(restored.runtime.busyUntil('npc_02'), DUE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
