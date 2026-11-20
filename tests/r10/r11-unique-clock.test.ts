/**
 * R11-A: one clock, one settlement, one physical effect.
 *
 * R10 reproduced a full-map move where one 15-minute intent left 22 workLog
 * rows, ended `rejected`, advanced the clock 516 instead of 495 and still put
 * the actor in the warehouse. The cause was a nested `advanceWorld` from the
 * original tile walk: the still-`working` intent was claimed again by every
 * nested settlement.
 *
 * These tests drive the real runtime and original map. They assert the clock is
 * charged once, the intent has one terminal state, each physical step has one
 * receipt, and the paid window equals the planned route.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { cellKey } from '../../src/spatial-v2/map';
import { createLegacyMapRegistry } from '../../src/spatial-v2/legacy-profile';

const candidate = (action: string, parameters: Record<string, unknown> = {}) => ({
  id: `r11-${action}`, kind: action, description: `r11 ${action}`,
  parameters: { action, ...parameters }, preconditions: [],
  expectedEffects: {}, utilityComponents: {},
});

function fullMap(seed: string): R8Runtime {
  const runtime = R8Runtime.create({ seed });
  runtime.enableLegacySpatial();
  return runtime;
}

test('one original-map move: one terminal state, one clock charge, route minutes', () => {
  const runtime = fullMap('r11-unique-single');
  const begun = runtime.beginIntent({ intentId: 'move-1', commandId: 'move-1',
    actorId: 'npc_01', candidate: candidate('move', { to: 'warehouse', purpose: 'travel' }),
    minutes: 15 });
  assert.ok('intent' in begun);
  const intent = begun.intent;
  // The paid window is the real route, not the old 15-minute estimate.
  const planned = runtime.legacySpatialMinutes('npc_01', 'warehouse');
  assert.equal(intent.dueAt - intent.startedAt, planned);

  runtime.advanceWorld(intent.dueAt);

  assert.equal(runtime.world.simTime, intent.dueAt, 'the clock is charged exactly once');
  assert.equal(runtime.workLog.length, 1, 'one logical intent, one workLog row');
  assert.equal(runtime.workLog[0].status, 'applied');
  assert.equal(runtime.world.npcs.npc_01.location, 'warehouse');
  // The walk settled inside its paid window, so no nested advance was attempted.
  assert.equal(runtime.nestedAdvanceSuppressed, 0);
  // Each physical step has its own movement receipt; no receipt repeats.
  const steps = runtime.workLog[0].eventIds.filter(id => id.startsWith('legacy-step:'));
  assert.equal(new Set(steps).size, steps.length);
  assert.ok(steps.length >= 2, 'a real route crosses more than one tile');
});

test('two NPCs move in parallel and each keeps its own receipt and clock', () => {
  const runtime = fullMap('r11-unique-parallel');
  const first = runtime.beginIntent({ intentId: 'a', commandId: 'a', actorId: 'npc_01',
    candidate: candidate('move', { to: 'warehouse', purpose: 'travel' }), minutes: 15 });
  const second = runtime.beginIntent({ intentId: 'b', commandId: 'b', actorId: 'npc_02',
    candidate: candidate('move', { to: 'dorm-a', purpose: 'travel' }), minutes: 15 });
  assert.ok('intent' in first && 'intent' in second);
  const target = Math.max(first.intent.dueAt, second.intent.dueAt);

  runtime.advanceWorld(target);

  assert.equal(runtime.world.simTime, target);
  assert.equal(runtime.workLog.length, 2);
  assert.ok(runtime.workLog.every(row => row.status === 'applied'));
  assert.equal(new Set(runtime.workLog.map(row => row.intentId)).size, 2);
  assert.equal(runtime.world.npcs.npc_01.location, 'warehouse');
  assert.equal(runtime.world.npcs.npc_02.location, 'dorm-a');
});

test('a move and a rest due at different points settle once each', () => {
  const runtime = fullMap('r11-unique-mixed');
  const move = runtime.beginIntent({ intentId: 'move', commandId: 'move', actorId: 'npc_01',
    candidate: candidate('move', { to: 'warehouse', purpose: 'travel' }), minutes: 15 });
  const rest = runtime.beginIntent({ intentId: 'rest', commandId: 'rest', actorId: 'npc_02',
    candidate: candidate('rest', { minutes: 60 }), minutes: 60 });
  assert.ok('intent' in move && 'intent' in rest);

  runtime.advanceWorld(rest.intent.dueAt);

  assert.equal(runtime.world.simTime, rest.intent.dueAt);
  assert.equal(runtime.workLog.length, 2);
  assert.equal(runtime.workLog.filter(row => row.status === 'applied').length, 2);
  // The move settled at its own due, not at the rest's later boundary.
  assert.equal(runtime.workLog.find(row => row.intentId === 'move')!.settledAt, move.intent.dueAt);
});

test('cancelling a queued move leaves no movement behind', () => {
  const runtime = fullMap('r11-unique-cancel');
  const begun = runtime.beginIntent({ intentId: 'move', commandId: 'move', actorId: 'npc_01',
    candidate: candidate('move', { to: 'warehouse', purpose: 'travel' }), minutes: 15 });
  assert.ok('intent' in begun);
  const movementReceipts = () => runtime.committedEvents()
    .filter(event => event.type === 'legacy_cell_moved' || event.type === 'legacy_door_crossed')
    .length;
  const receiptsBefore = movementReceipts();

  assert.equal(runtime.cancelIntent('move', 'player_cancelled'), true);
  runtime.advanceWorld(begun.intent.dueAt);

  assert.equal(runtime.workLog.length, 1);
  assert.equal(runtime.workLog[0].status, 'cancelled');
  assert.equal(runtime.world.npcs.npc_01.location, 'dorm-a', 'a cancelled trip does not teleport');
  assert.equal(movementReceipts(), receiptsBefore,
    'a cancelled intent produces no physical receipt');
});

test('a closed door refuses the move with no partial walk and one clock charge', () => {
  const runtime = fullMap('r11-unique-blocked');
  const registry = createLegacyMapRegistry({ gatesClosed: false });
  const entry = registry.maps.village.triggers.find(trigger => trigger.target === 'warehouse')!;
  runtime.world.spatial ??= { positions: {}, stocks: { warehouse: { food: 120 } },
    carry: {}, closedCells: [], deliveredMeals: 0 };
  runtime.world.spatial.closedCells.push(cellKey({ x: entry.x, y: entry.y }));
  const begun = runtime.beginIntent({ intentId: 'blocked', commandId: 'blocked',
    actorId: 'npc_01', candidate: candidate('move', { to: 'warehouse', purpose: 'travel' }),
    minutes: 15 });
  assert.ok('intent' in begun);

  runtime.advanceWorld(begun.intent.dueAt);

  assert.equal(runtime.workLog.length, 1);
  assert.equal(runtime.workLog[0].status, 'rejected');
  assert.equal(runtime.world.npcs.npc_01.location, 'dorm-a');
  assert.ok(runtime.world.simTime <= begun.intent.dueAt);
});

test('a queued move saves and resumes in a new runtime with the same result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r11-a-save-'));
  try {
    const first = fullMap('r11-unique-save');
    const begun = first.beginIntent({ intentId: 'move', commandId: 'move', actorId: 'npc_01',
      candidate: candidate('move', { to: 'warehouse', purpose: 'travel' }), minutes: 15 });
    assert.ok('intent' in begun);
    const savePath = join(dir, 'game');
    first.save(savePath);
    // R11-A turned the walk into a segmented phase, so the actor really does
    // advance along the planned path before `due`: the saving contract is the
    // serialised `{path, leg, progress}`, not "the body is still at home".
    first.advanceWorld(begun.intent.startedAt + 5);
    const midway = first.world.npcs.npc_01.location;
    assert.notEqual(midway, 'warehouse', 'the walk is not teleported to the goal');
    assert.ok(begun.intent.move!.leg > 0 && begun.intent.move!.leg < begun.intent.move!.path.length);

    const resumed = R8Runtime.load(savePath);
    assert.equal(resumed.intents.get('move')?.dueAt, begun.intent.dueAt);
    assert.equal(resumed.intents.get('move')?.move?.path.length, begun.intent.move!.path.length,
      'the whole path survives the save');
    resumed.advanceWorld(begun.intent.dueAt);
    assert.equal(resumed.world.simTime, begun.intent.dueAt);
    assert.equal(resumed.workLog.length, 1);
    assert.equal(resumed.workLog[0].status, 'applied');
    assert.equal(resumed.world.npcs.npc_01.location, 'warehouse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the original-map authority refuses un-granted work at the session seam', () => {
  const runtime = fullMap('r11-unique-grant');
  runtime.travelLegacyTo('npc_01', 'village');
  assert.equal(runtime.world.npcs.npc_01.location, 'village');
  const before = { clock: runtime.world.simTime, wood: runtime.world.resources.firewood };
  const outcome = runtime.session.executeCandidate('npc_01',
    candidate('gather', { resource: 'firewood', amount: 2 }), 'no-grant');

  assert.equal(outcome.status, 'rejected');
  assert.match(String(outcome.reason), /work_requires_intent/);
  assert.equal(runtime.world.simTime, before.clock, 'a refused shortcut spends no time');
  assert.equal(runtime.world.resources.firewood, before.wood, 'a refused shortcut moves no goods');
});
