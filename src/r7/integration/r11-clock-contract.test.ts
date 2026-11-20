/**
 * R11-A: one clock, planned travel, exactly-once settlement.
 *
 * These are the positive and negative controls the R10 audit asked for:
 * a single move, two moves in parallel, a move and a rest on the same due, a
 * road closed mid-route, a cancel mid-route, a save mid-route resumed in a
 * fresh process, and the authority boundary that stops an un-granted inline
 * work action.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { R8Runtime } from './runtime';
import type { ActionIntent } from './action-intent';
import { PlaySession } from '../../application-v2/session';
import { createLegacyMapRegistry } from '../../spatial-v2/legacy-profile';
import { TRAVEL_STAMINA_PER_TILE } from '../../survival/world-v2';
import type { Candidate } from '../../decision/contracts';

const action = (name: string, parameters: Record<string, unknown> = {}): Candidate => ({
  id: `r11-${name}` as Candidate['id'], kind: name as Candidate['kind'],
  description: `R11 control ${name}`, parameters: { action: name, ...parameters },
  preconditions: [], expectedEffects: {}, utilityComponents: {},
});

const moveTo = (to: string, purpose = 'travel'): Candidate => action('move', { to, purpose });

function beginMove(runtime: R8Runtime, intentId: string, actorId: string, to: string,
  minutes = 15): ActionIntent {
  const begun = runtime.beginIntent({ intentId, commandId: intentId, actorId,
    candidate: moveTo(to), minutes });
  assert.ok(!('rejected' in begun), 'move must queue: ' + JSON.stringify(begun));
  return (begun as { intent: ActionIntent }).intent;
}

/** The one thing every travel control asserts: the clock IS the plan. */
function assertPlanIsClock(intent: ActionIntent): void {
  const move = intent.move!;
  assert.ok(move, 'a queued move carries a travel plan');
  assert.equal(move.path.length, move.plannedMinutes, 'one minute per leg');
  assert.equal(intent.dueAt, intent.startedAt + move.plannedMinutes);
}

test('R11-A1: one original-map move pays its own path and keeps one terminal record', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a1' });
  runtime.enableLegacySpatial();
  const start = runtime.world.simTime;
  const stamina = runtime.world.npcs.npc_01.stamina;
  const intent = beginMove(runtime, 'move-warehouse', 'npc_01', 'warehouse', 15);
  assertPlanIsClock(intent);
  // The caller asked for 15 minutes; the real route needs more. The plan wins
  // and the guess stays visible instead of silently becoming the promise.
  assert.equal(intent.move!.requestedMinutes, 15);
  assert.ok(intent.move!.plannedMinutes > 15);

  const midway = start + 5;
  runtime.advanceWorld(midway);
  assert.equal(runtime.world.simTime, midway, 'the clock stops exactly where asked');
  assert.equal(intent.status, 'working');
  assert.equal(intent.move!.leg, 5, 'one leg per paid minute');
  assert.equal(intent.move!.progress, 5);
  assert.equal(runtime.workLog.length, 0, 'an unfinished walk is not a terminal record');
  assert.equal(runtime.work.size, 1, 'the actor stays occupied');

  const report = runtime.advanceWorld(intent.dueAt);
  assert.equal(runtime.world.simTime, intent.dueAt, 'arrival is exactly the due time');
  assert.equal(intent.status, 'applied');
  assert.equal(runtime.workLog.length, 1, 'one intent, one terminal record');
  assert.equal(runtime.workLog[0].settledAt, intent.dueAt);
  assert.equal(runtime.world.npcs.npc_01.location, 'warehouse');
  assert.equal(runtime.legacyPosition('npc_01')!.mapId, 'warehouse');
  assert.equal(intent.move!.leg, intent.move!.path.length);
  assert.equal(intent.move!.progress, intent.move!.plannedMinutes);
  assert.equal(intent.move!.legReceiptIds.length, intent.move!.path.length);
  for (const receiptId of intent.move!.legReceiptIds) {
    assert.ok(runtime.committedEvent(receiptId), `leg receipt ${receiptId} is committed`);
  }
  assert.equal(runtime.committedEvents().filter(event => event.type === 'legacy_cell_moved').length,
    intent.move!.path.filter(leg => leg.kind === 'cell').length);
  // Stamina is charged once per walked tile, exactly as the path says: the
  // charge is read from the movement receipts, not from a drifting vital.
  const steps = runtime.committedEvents()
    .filter(event => event.type === 'legacy_cell_moved' || event.type === 'legacy_door_crossed');
  assert.equal(steps.length, intent.move!.path.length);
  assert.ok(steps.every(event => event.payload.extraStamina === TRAVEL_STAMINA_PER_TILE));
  assert.ok(runtime.world.npcs.npc_01.stamina < stamina, 'walking really costs stamina');
  assert.equal(report.reachedEnd, false);
});

test('R11-A2: two NPCs walk in parallel, each on its own clock and receipts', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a2' });
  runtime.enableLegacySpatial();
  const start = runtime.world.simTime;
  const first = beginMove(runtime, 'a-to-kitchen', 'npc_01', 'kitchen');
  const second = beginMove(runtime, 'b-to-medical', 'npc_02', 'medical');
  assert.equal(runtime.work.size, 2, 'two bodies, two intents');
  assert.equal(runtime.work.get('npc_01')!.intentId, first.intentId);
  assert.equal(runtime.work.get('npc_02')!.intentId, second.intentId);

  const target = Math.max(first.dueAt, second.dueAt);
  runtime.advanceWorld(target);
  assert.equal(runtime.world.simTime, target);
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  assert.equal(runtime.world.npcs.npc_01.location, 'kitchen');
  assert.equal(runtime.world.npcs.npc_02.location, 'medical');
  assert.equal(runtime.workLog.length, 2);
  const receipts = new Set([...first.move!.legReceiptIds, ...second.move!.legReceiptIds]);
  assert.equal(receipts.size, first.move!.legReceiptIds.length + second.move!.legReceiptIds.length,
    'no receipt is shared between two bodies');
  // Neither walk paid more minutes than its own path.
  assert.equal(first.move!.progress, first.move!.plannedMinutes);
  assert.equal(second.move!.progress, second.move!.plannedMinutes);
  assert.ok(first.move!.landedAt.every((at, index) => at === start + index + 1));
});

test('R11-A3: a move and a rest that fall due together settle once each', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a3' });
  runtime.enableLegacySpatial();
  const start = runtime.world.simTime;
  const move = beginMove(runtime, 'move-dorm-b', 'npc_01', 'dorm-b');
  const rest = runtime.beginIntent({ intentId: 'rest-together', commandId: 'rest-together',
    actorId: 'npc_02', candidate: action('rest', { minutes: move.move!.plannedMinutes }),
    minutes: move.move!.plannedMinutes });
  assert.ok(!('rejected' in rest));
  const restIntent = (rest as { intent: ActionIntent }).intent;
  assert.equal(restIntent.dueAt, move.dueAt, 'same due minute on purpose');

  runtime.advanceWorld(move.dueAt);
  assert.equal(runtime.world.simTime, start + move.move!.plannedMinutes);
  assert.equal(move.status, 'applied');
  assert.equal(restIntent.status, 'applied');
  assert.equal(runtime.workLog.length, 2);
  assert.equal(runtime.committedEvents().filter(event => event.type === 'rested').length, 1);
  assert.equal(runtime.world.npcs.npc_01.location, 'dorm-b');
  assert.deepEqual(runtime.workLog.map(entry => entry.settledAt), [move.dueAt, move.dueAt]);
});

test('R11-A4: closing the road mid-route stops the walk and keeps the paid legs', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a4' });
  runtime.enableLegacySpatial();
  const intent = beginMove(runtime, 'move-medical', 'npc_01', 'medical');
  const ahead = intent.move!.path.findIndex((leg, index) => index > 2
    && leg.kind === 'cell' && leg.mapId === 'village');
  assert.ok(ahead > 0, 'the route really crosses the village');
  runtime.advanceWorld(intent.startedAt + 3);
  const walked = intent.move!.leg;
  assert.ok(walked > 0 && walked < intent.move!.path.length);

  const blocked = intent.move!.path[ahead];
  const closed = runtime.session.submitWorldCommand({ commandId: 'close-ahead',
    type: 'close-road', cells: [{ x: blocked.cell.x, y: blocked.cell.y }] });
  assert.equal(closed.status, 'applied');
  const positionBefore = runtime.legacyPosition('npc_01')!;
  const clockBefore = runtime.world.simTime;

  runtime.advanceWorld(intent.dueAt);
  assert.equal(intent.status, 'rejected');
  assert.match(intent.failureReason!, /legacy_move_not_adjacent_or_blocked|original_route_blocked/);
  assert.equal(intent.move!.leg, walked, 'no further leg was paid for');
  assert.equal(intent.move!.progress, walked, 'paid minutes stop at the last walked leg');
  assert.deepEqual(runtime.legacyPosition('npc_01'), positionBefore, 'the actor stays where it is');
  assert.equal(intent.receiptIds.length, walked, 'walked legs stay as receipts');
  assert.equal(runtime.world.simTime, intent.dueAt, 'time still passes');
  assert.equal(runtime.work.size, 0);
  assert.equal(runtime.workLog.length, 1);
  void clockBefore;
  // The rejected journey never resumes.
  runtime.advanceWorld(intent.dueAt + 120);
  assert.deepEqual(runtime.legacyPosition('npc_01'), positionBefore);
});

test('R11-A5: a cancel mid-route keeps walked legs, then moves and fulfils nothing', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a5' });
  runtime.enableLegacySpatial();
  const intent = beginMove(runtime, 'move-workshop', 'npc_01', 'workshop');
  runtime.advanceWorld(intent.startedAt + 4);
  const walked = intent.move!.leg;
  const positionBefore = runtime.legacyPosition('npc_01')!;

  assert.equal(runtime.cancelIntent(intent.intentId, 'player_cancelled'), true);
  assert.equal(intent.status, 'cancelled');
  assert.equal(intent.move!.cancelAt, runtime.world.simTime);
  assert.equal(intent.move!.leg, walked, 'the walked legs are preserved');
  assert.equal(intent.receiptIds.length, walked, 'and their receipts with them');
  assert.equal(runtime.work.size, 0);

  runtime.advanceWorld(intent.dueAt + 60);
  assert.equal(runtime.world.simTime, intent.dueAt + 60);
  assert.deepEqual(runtime.legacyPosition('npc_01'), positionBefore, 'a cancelled walk never moves');
  assert.equal(intent.move!.leg, walked, 'and never pays another minute');
  assert.equal(runtime.workLog.filter(entry => entry.intentId === intent.intentId).length, 1);
  assert.equal(runtime.workLog.find(entry => entry.intentId === intent.intentId)!.status, 'cancelled');
  assert.equal(runtime.committedEvents()
    .filter(event => event.type === 'legacy_door_crossed'
      && event.payload.commandId === `${intent.intentId}:step:${walked}`).length, 0,
  'nothing lands after the cancel point');
});

test('R11-A6: a walk saved mid-route continues in a fresh process from its receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frostecho-r11-a6-'));
  const save = join(directory, 'midway.json');
  const expectedPath = join(directory, 'expected.json');
  try {
    const continuous = R8Runtime.create({ seed: 'r11-a6' });
    continuous.enableLegacySpatial();
    const moved = beginMove(continuous, 'move-warehouse', 'npc_01', 'warehouse');
    beginMove(continuous, 'other-move', 'npc_02', 'medical');
    continuous.advanceWorld(moved.startedAt + 7);
    continuous.save(save);
    const savedClock = continuous.world.simTime;
    const savedLeg = moved.move!.leg;
    assert.ok(savedLeg > 0 && savedLeg < moved.move!.path.length, 'saved mid-route');
    continuous.advanceWorld(moved.dueAt);
    writeFileSync(expectedPath, JSON.stringify({
      clock: continuous.world.simTime, status: moved.status,
      leg: moved.move!.leg, progress: moved.move!.progress,
      position: continuous.legacyPosition('npc_01'),
      receipts: moved.move!.legReceiptIds, workLog: continuous.workLog,
      stamina: continuous.world.npcs.npc_01.stamina,
    }));

    const child = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict'),fs=require('node:fs');
      const {R8Runtime}=require(process.argv[1]);
      const r=R8Runtime.load(process.argv[2]);
      const intent=r.intents.get('move-warehouse');
      assert.equal(intent.status,'working','the mid-route intent is still live');
      assert.equal(intent.move.leg,Number(process.argv[3]));
      const before=r.world.simTime;
      const receiptsBefore=new Set(r.committedEvents().map(e=>e.eventId));
      r.advanceWorld(intent.dueAt);
      const planted=[...new Set(r.committedEvents().map(e=>e.eventId))]
        .filter(id=>!receiptsBefore.has(id));
      const duplicatePlanted=planted.filter(id=>!receiptsBefore.has(id)&&false);
      assert.equal(r.world.simTime,intent.dueAt);
      assert.equal(intent.status,'applied');
      assert.equal(r.workLog.filter(x=>x.intentId==='move-warehouse').length,1);
      assert.equal(new Set(intent.move.legReceiptIds).size,intent.move.path.length);
      assert.equal(r.legacyPosition('npc_01').mapId,'warehouse');
      console.log(JSON.stringify({clock:r.world.simTime,status:intent.status,
        leg:intent.move.leg,progress:intent.move.progress,
        position:r.legacyPosition('npc_01'),receipts:intent.move.legReceiptIds,
        workLog:r.workLog.filter(x=>x.intentId==='move-warehouse'),
        stamina:r.world.npcs.npc_01.stamina,savedClock:before,
        planted:planted.length,duplicatePlanted:duplicatePlanted.length,
        otherIntent:r.intents.get('other-move').status}));
    `, resolve(__dirname, 'runtime.js'), save, String(savedLeg)],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    const resumed = JSON.parse(child.stdout);
    const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
    assert.equal(resumed.savedClock, savedClock);
    assert.equal(resumed.clock, expected.clock);
    assert.equal(resumed.status, expected.status);
    assert.equal(resumed.leg, expected.leg);
    assert.equal(resumed.progress, expected.progress);
    assert.deepEqual(resumed.position, expected.position);
    assert.deepEqual(resumed.receipts, expected.receipts,
      'the resumed process reuses the same committed leg receipts, never new ones');
    assert.equal(resumed.workLog.length, 1);
    assert.equal(resumed.workLog[0].settledAt, expected.workLog
      .find((entry: { intentId: string }) => entry.intentId === 'move-warehouse')!.settledAt);
    assert.ok(Math.abs(resumed.stamina - expected.stamina) < 1e-6);
    // A second walk was queued before the save and keeps its own schedule.
    assert.ok(['working', 'applied'].includes(resumed.otherIntent));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('R11-A7: the new profile refuses un-granted inline work; the legacy entry declares itself', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a7' });
  runtime.session.submitWorldCommand({ commandId: 'to-village', type: 'move',
    actorId: 'npc_01', to: 'village' });
  const before = { time: runtime.world.simTime, wood: runtime.world.resources.firewood };
  const gather = action('gather', { resource: 'firewood', amount: 2 });

  const inline = runtime.session.executeCandidate('npc_01', gather, 'no-grant');
  assert.equal(inline.status, 'rejected');
  assert.match(inline.reason!, /work_requires_intent/);
  assert.equal(runtime.world.simTime, before.time, 'no time was spent');
  assert.equal(runtime.world.resources.firewood, before.wood, 'no wood was gathered');

  const queued = runtime.queueAction({ intentId: 'gather-queued', commandId: 'gather-queued',
    actorId: 'npc_01', candidate: gather, taskId: null, taskType: 'COLLECT_WOOD' });
  assert.equal(queued.status, 'queued');
  // A control that only waits shows the survival drift; the difference is the
  // real yield, so the receipt and the resource must agree.
  const control = R8Runtime.create({ seed: 'r11-a7' });
  control.session.submitWorldCommand({ commandId: 'to-village', type: 'move',
    actorId: 'npc_01', to: 'village' });
  runtime.advanceWorld(before.time + 30);
  control.advanceWorld(before.time + 30);
  const queuedYield = runtime.committedEvents()
    .filter(event => event.type === 'gathered').reduce((sum, event) =>
      sum + Number(event.payload.amount), 0);
  assert.ok(queuedYield > 0, 'the queued gather really runs');
  assert.equal(runtime.world.resources.firewood, control.world.resources.firewood + queuedYield,
    'and the wood matches the receipt');
  assert.equal(runtime.world.simTime, before.time + 30, 'and it costs its own minutes');

  // The legacy entry still exists, and what it runs inline is recorded.
  const legacyInlined = runtime.session.executeCandidateLegacy('npc_01', gather, 'legacy-gather');
  assert.equal(legacyInlined.status, 'applied');
  assert.equal(runtime.session.inlineWorkExecutions.length, 1);
  assert.equal(runtime.session.inlineWorkExecutions[0].action, 'gather');
  assert.equal(runtime.world.simTime, before.time + 30, 'inline work still spends no clock');
});

test('R11-A8: a handed-in session keeps its own authority (legacy drivers still work)', () => {
  const session = PlaySession.create(3, { seed: 'r11-a8' });
  const runtime = R8Runtime.create({ session });
  assert.equal(session.workAuthority, 'legacy-inline');
  runtime.session.submitWorldCommand({ commandId: 'legacy-to-village', type: 'move',
    actorId: 'npc_01', to: 'village' });
  const gather = action('gather', { resource: 'firewood', amount: 2 });
  const before = runtime.world.resources.firewood;
  const outcome = runtime.session.executeCandidate('npc_01', gather, 'legacy-inline');
  assert.equal(outcome.status, 'applied');
  assert.ok(runtime.world.resources.firewood > before, 'the legacy entry still gathers');
  assert.equal(runtime.session.inlineWorkExecutions.length, 0,
    'a session that declared the legacy authority is not an audit finding');
});

test('R11-A10: standing on the door tile still plans the trip', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a10' });
  runtime.enableLegacySpatial();
  const registry = createLegacyMapRegistry();
  const exit = registry.maps.dorm_a.triggers[0];
  const walked = runtime.walkLegacy('npc_01', { x: exit.x, y: exit.y }, 'walk-to-door');
  assert.equal(walked.status, 'applied', JSON.stringify(walked));
  const intent = beginMove(runtime, 'from-door', 'npc_01', 'village');
  // The zero-length walk to the door is not a refusal: the first leg is the door.
  assert.equal(intent.move!.path[0].kind, 'door');
  runtime.advanceWorld(intent.dueAt);
  assert.equal(intent.status, 'applied');
  assert.equal(runtime.world.npcs.npc_01.location, 'village');
});

test('R11-A11: a route already blocked when queued fails in one paid minute', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a11' });
  runtime.enableLegacySpatial();
  const registry = createLegacyMapRegistry();
  const entry = registry.maps.village.triggers.find(trigger => trigger.target === 'warehouse')!;
  const closed = runtime.session.submitWorldCommand({ commandId: 'close-before',
    type: 'close-road', cells: [{ x: entry.x, y: entry.y }] });
  assert.equal(closed.status, 'applied');
  const started = runtime.world.simTime;
  const intent = beginMove(runtime, 'blocked-before', 'npc_01', 'warehouse');
  assert.equal(intent.move!.refusedReason, 'original_route_blocked');
  assert.equal(intent.dueAt, started + 1, 'the attempt costs one minute, not the whole trip');
  runtime.advanceWorld(intent.dueAt);
  assert.equal(intent.status, 'rejected');
  assert.equal(runtime.workLog.length, 1);
  assert.equal(runtime.world.npcs.npc_01.location, 'dorm-a');
  // The refusal is the actor's own observation, not a silent drop.
  const rejected = runtime.session.memories.get('npc_01')!.toJSON().records
    .filter(record => record.kind === 'action_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(runtime.committedEvent(rejected[0].sourceEventIds[0])?.type, 'action_rejected');
});

test('R11-A9: a nested clock advance is refused instead of re-charging the span', () => {
  const runtime = R8Runtime.create({ seed: 'r11-a9' });
  const intent = runtime.beginIntent({ intentId: 'rest-guarded', commandId: 'rest-guarded',
    actorId: 'npc_01', candidate: action('rest', { minutes: 10 }), minutes: 10 });
  assert.ok(!('rejected' in intent));
  runtime.registerIntentGuard(() => {
    // A re-entrant clock advance here is the R10 defect in one line.
    runtime.advanceWorld(runtime.world.simTime + 60);
    return null;
  });
  runtime.advanceWorld(490);
  const entry = runtime.workLog.find(row => row.intentId === 'rest-guarded')!;
  assert.equal(entry.status, 'rejected');
  assert.match(entry.failureReason!, /reentrant_advance_world/);
  assert.equal(runtime.world.simTime, 490, 'the outer span is still the only span charged');
});
