/**
 * R10 (A): one clock, one deterministic settlement order, no serialisation.
 *
 * Two intents that fall due in the same minute must settle in a total order
 * `(dueAt, intentId)` that does not depend on Map insertion order, and a body
 * whose authorisation was revoked one minute before its due time must produce
 * zero receipts. The positive control is the opposite failure mode: two bodies
 * resting at once must overlap in wall time, not be queued one after another.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from '../../src/decision/contracts';
import { R8Runtime } from '../../src/r7/integration/runtime';

const START = 480; // day 1, 08:00
const DUE = START + 60;

function rest(id: string): Candidate {
  return { id, kind: 'rest', description: '休息 60 分钟',
    parameters: { action: 'rest', minutes: 60 }, preconditions: [],
    expectedEffects: {}, utilityComponents: {} };
}

function rested(runtime: R8Runtime, actorId: string): number {
  return runtime.committedEvents()
    .filter(event => event.type === 'rested' && event.actorId === actorId).length;
}

function terminal(runtime: R8Runtime, intentId: string) {
  return runtime.workLog.filter(entry => entry.intentId === intentId);
}

test('same-minute dues settle in (dueAt, intentId) order and a revoked body has 0 receipts', () => {
  const runtime = R8Runtime.create({ seed: 'r10-clock' });
  runtime.world.npcs.npc_01.stamina = 40;
  runtime.world.npcs.npc_02.stamina = 40;
  runtime.world.npcs.npc_03.stamina = 40;
  // Inserted in reverse id order on purpose: insertion order must not decide.
  const applied = runtime.beginIntent({ intentId: 'z-rest', commandId: 'cmd-z',
    actorId: 'npc_01', candidate: rest('rest-z'), minutes: 60 });
  const explicit = runtime.beginIntent({ intentId: 'm-rest', commandId: 'cmd-m',
    actorId: 'npc_03', candidate: rest('rest-m'), minutes: 60 });
  const revoked = runtime.beginIntent({ intentId: 'a-rest', commandId: 'cmd-a',
    actorId: 'npc_02', candidate: rest('rest-a'), minutes: 60 });
  assert.ok('intent' in applied && 'intent' in explicit && 'intent' in revoked);
  assert.equal(applied.intent.dueAt, DUE);
  assert.equal(explicit.intent.dueAt, DUE);
  assert.equal(revoked.intent.dueAt, DUE);

  // One minute before due: an explicit cancel, and an authorisation withdrawal
  // that leaves the intent queued (settlement must refuse it by generation).
  runtime.advanceWorld(DUE - 1);
  assert.equal(runtime.world.simTime, DUE - 1);
  assert.equal(runtime.workLog.length, 0, 'nothing settles before its due time');
  assert.equal(runtime.cancelIntent('m-rest', 'player_cancelled_before_due'), true);
  runtime.session.bumpGeneration('npc_02', 'player_cancelled_before_due');

  runtime.advanceWorld(DUE);
  assert.equal(runtime.world.simTime, DUE);

  // Settlement order at the shared due minute: sorted by (dueAt, intentId).
  // The explicit cancel already logged at DUE-1, so only the two bodies that
  // were still working at DUE appear here.
  assert.deepEqual(runtime.workLog.filter(entry => entry.settledAt === DUE)
    .map(entry => entry.intentId), ['a-rest', 'z-rest']);

  const cancelledAtDue = terminal(runtime, 'a-rest');
  assert.equal(cancelledAtDue.length, 1);
  assert.equal(cancelledAtDue[0].status, 'cancelled');
  assert.equal(cancelledAtDue[0].failureReason, 'generation_revoked');
  assert.deepEqual(cancelledAtDue[0].eventIds, []);
  assert.equal(rested(runtime, 'npc_02'), 0, 'revoked authorisation produces no receipt');

  const explicitCancel = terminal(runtime, 'm-rest');
  assert.equal(explicitCancel.length, 1);
  assert.equal(explicitCancel[0].status, 'cancelled');
  assert.equal(explicitCancel[0].failureReason, 'player_cancelled_before_due');
  assert.equal(explicitCancel[0].settledAt, DUE - 1);
  assert.deepEqual(explicitCancel[0].eventIds, []);
  assert.equal(rested(runtime, 'npc_03'), 0, 'explicit cancel produces no receipt');

  const appliedEntry = terminal(runtime, 'z-rest');
  assert.equal(appliedEntry.length, 1);
  assert.equal(appliedEntry[0].status, 'applied');
  assert.equal(appliedEntry[0].eventIds.length, 1, 'the surviving body settles exactly once');
  assert.equal(rested(runtime, 'npc_01'), 1);
  const restEvent = runtime.committedEvent(appliedEntry[0].eventIds[0])!;
  assert.equal(restEvent.type, 'rested');
  assert.equal(restEvent.payload.minutes, 60, 'one hour of rest, not two');
  // Net gain is one hour (+12) minus the clock's own drain: not two settlements.
  const gain = runtime.world.npcs.npc_01.stamina - 40;
  assert.ok(gain >= 8 && gain <= 13, `one-hour rest gain ${gain}`);
});

test('the same boundaries reached in one span give the same terminal outcomes', () => {
  function arm(split: boolean) {
    const runtime = R8Runtime.create({ seed: 'r10-clock' });
    for (const id of ['npc_01', 'npc_02']) runtime.world.npcs[id].stamina = 40;
    const queued = [
      runtime.beginIntent({ intentId: 'z-rest', commandId: 'cmd-z', actorId: 'npc_01',
        candidate: rest('rest-z'), minutes: 60 }),
      runtime.beginIntent({ intentId: 'a-rest', commandId: 'cmd-a', actorId: 'npc_02',
        candidate: rest('rest-a'), minutes: 60 }),
    ];
    assert.ok(queued.every(entry => 'intent' in entry));
    if (split) runtime.advanceWorld(DUE - 1);
    runtime.session.bumpGeneration('npc_02', 'player_cancelled_before_due');
    runtime.advanceWorld(DUE);
    // Receipt ids embed the session-global sequence, so compare the physical
    // outcome (status + receipt type + count), never the opaque id spelling.
    return runtime.workLog
      .filter(entry => entry.intentId === 'a-rest' || entry.intentId === 'z-rest')
      .sort((left, right) => left.intentId.localeCompare(right.intentId))
      .map(entry => ({ intentId: entry.intentId, status: entry.status,
        receiptTypes: entry.eventIds.map(id => id.split(':')[1] ?? id) }));
  }
  assert.deepEqual(arm(true), arm(false));
});

test('parallel rest stays parallel: two bodies, one hour of wall time, no serialisation', () => {
  const runtime = R8Runtime.create({ seed: 'r10-parallel' });
  runtime.world.npcs.npc_01.stamina = 40;
  runtime.world.npcs.npc_02.stamina = 40;
  const begun = ['npc_01', 'npc_02'].map(actorId => runtime.beginIntent({
    intentId: `${actorId}-rest`, commandId: `${actorId}-cmd`, actorId,
    candidate: rest(`${actorId}-rest-60`), minutes: 60 }));
  assert.ok(begun.every(entry => 'intent' in entry));

  runtime.advanceWorld(DUE);
  assert.equal(runtime.world.simTime, DUE, 'both rests finish inside the same hour');
  const entries = runtime.workLog.filter(entry => entry.kind === 'rest');
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.status === 'applied'));
  assert.deepEqual(entries.map(entry => entry.settledAt), [DUE, DUE]);
  // Two one-hour bodies cost 120 charged minutes inside 60 wall minutes: they
  // overlap. Serialising them would cost 120 wall minutes (or 16 copies of work).
  const charged = entries.reduce((sum, entry) => sum + (entry.endsAt - entry.startedAt), 0);
  assert.equal(charged, 120);
  assert.equal(DUE - START, 60);
  for (const actorId of ['npc_01', 'npc_02']) {
    const gain = runtime.world.npcs[actorId].stamina - 40;
    assert.ok(gain >= 8 && gain <= 13, `${actorId} gained ${gain}, not two rests`);
    assert.equal(rested(runtime, actorId), 1);
  }
});
