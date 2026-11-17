/**
 * R3 (P): the warehouse -> kitchen delivery run as a real task — success
 * trajectory, the honest out-of-stock trajectory (fallback + rumor + retry),
 * the blocked-road trajectory (report, promise intact, reopen), task-board
 * bookkeeping and save/restore identity.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GameplayLoop } from '../src/gameplay-v2/loop';
import { BUILDINGS, MAPS, findPath } from '../src/spatial-v2/map';
import { actorCell } from '../src/gameplay-v2/loop';
import { DEFAULT_WAREHOUSE_FOOD } from '../src/survival/world-v2';

function loop(npcCount = 8): GameplayLoop {
  return GameplayLoop.create(npcCount, { seed: 'r3-gameplay' });
}

test('delivery run: assign -> travel -> withdraw -> travel -> deliver completes the task', () => {
  const play = loop();
  const task = play.assign('npc_01', 'deliver-meal');
  assert.equal(task.kind, 'deliver-meal');
  for (let index = 0; index < 10; index += 1) play.step();
  const board = play.board.toJSON();
  const entry = board.find(item => item.taskId === task.taskId);
  assert.equal(entry?.status, 'done');
  const world = play.session.world;
  assert.equal((world.spatial?.deliveredMeals ?? 0) >= 1, true);
  assert.equal(world.npcs.npc_01.location, 'kitchen');
});

test('delivery run: personally-witnessed out-of-stock falls back, rumor + restock retries', () => {
  const play = loop();
  // Drain the warehouse before npc_02 ever gets there.
  const session = play.session;
  session.submitWorldCommand({ commandId: 'drain-t', type: 'travel', actorId: 'npc_01',
    route: findPath(MAPS.village, actorCell(session.world, 'npc_01'),
      BUILDINGS.find(building => building.id === 'warehouse')!.door)!.path!, minutesPerTile: 2 });
  session.submitWorldCommand({ commandId: 'drain-w', type: 'withdraw', actorId: 'npc_01',
    place: 'warehouse', resource: 'food', amount: 4 });
  assert.equal(session.world.spatial?.stocks.warehouse.food, 0);

  const task = play.assign('npc_02', 'deliver-meal');
  const phases: string[] = [];
  let witnessedEmpty = false;
  for (let index = 0; index < 8; index += 1) {
    const view = play.deliveryView('npc_02');
    phases.push(`${view.stockLevel ?? 'unknown'}:${view.carried}`);
    if (view.stockLevel === 0) witnessedEmpty = true;
    play.step();
  }
  // npc_02 personally witnessed the empty shelves before any transfer changed
  // the level (R4's gather -> deposit chain may legitimately refill it later).
  assert.equal(witnessedEmpty, true, 'out_of_stock was personally observed');
  const boardMid = play.board.toJSON();
  const midStatus = boardMid.find(item => item.taskId === task.taskId)?.status;
  if (midStatus === 'done') {
    // R4: the honest failure may now be solved by the gather -> deposit chain;
    // a `done` task must then be backed by a real delivery receipt.
    assert.ok((play.session.world.spatial?.deliveredMeals ?? 0) >= 1,
      'done only with an authoritative delivery');
  } else {
    assert.equal(midStatus, 'active', 'promise survives the honest failure');
  }

  // A rumor alone never changes the confirmed level...
  const levelBeforeRumor = play.deliveryView('npc_02').stockLevel;
  session.tellRestock('npc_02');
  const rumorView = play.deliveryView('npc_02');
  assert.equal(rumorView.restockRumor, true);
  assert.deepEqual(rumorView.stockLevel, levelBeforeRumor,
    'rumor never changes the confirmed level');
  // ...but a refill is only knowledge when npc_02 is standing at the warehouse.
  const beforeRefill = play.deliveryView('npc_02').stockLevel;
  const atWarehouse = play.session.world.npcs.npc_02.location === 'warehouse';
  play.submitSpatial({ commandId: 'refill', type: 'restock', place: 'warehouse',
    resource: 'food', amount: 3, source: 'player' });
  const witnessed = play.deliveryView('npc_02');
  if (atWarehouse) {
    assert.equal(witnessed.stockLevel, (beforeRefill ?? 4) + 3,
      'restock seen in person updates the belief');
  } else {
    assert.deepEqual(witnessed.stockLevel, beforeRefill,
      'an unseen refill never updates the belief');
  }
  for (let index = 0; index < 10; index += 1) play.step();
  const board = play.board.toJSON();
  assert.equal(board.find(item => item.taskId === task.taskId)?.status, 'done',
    'restock + rumor enabled the retry to completion');
  assert.ok((play.session.world.spatial?.deliveredMeals ?? 0) >= 1);
});

test('delivery run: a sealed warehouse door is reported, not silently cancelled', () => {
  const play = loop();
  const door = BUILDINGS.find(building => building.id === 'warehouse')!.door;
  const seal = [{ x: door.x - 1, y: door.y }, { x: door.x, y: door.y }, { x: door.x + 1, y: door.y },
    { x: door.x - 1, y: door.y + 1 }, { x: door.x, y: door.y + 1 }, { x: door.x + 1, y: door.y + 1 }];
  play.submitSpatial({ commandId: 'seal', type: 'close-road', cells: seal });
  const task = play.assign('npc_03', 'deliver-meal');
  const report = play.step();
  const record = report.records.find(item => item.actorId === 'npc_03');
  assert.ok(record);
  assert.equal(record!.selectedId, 'g-report-blocked');
  assert.equal(record!.reason, 'delivery.report-blocked');
  const board = play.board.toJSON();
  assert.equal(board.find(item => item.taskId === task.taskId)?.status, 'active');
  // Reopening the road lets the run continue to completion.
  play.submitSpatial({ commandId: 'unseal', type: 'open-road', cells: seal });
  for (let index = 0; index < 10; index += 1) play.step();
  assert.equal(play.board.toJSON()
    .find(item => item.taskId === task.taskId)?.status, 'done');
});

test('delivery run: unobserved world restock never leaks into NPC belief', () => {
  const play = loop();
  play.assign('npc_04', 'deliver-meal');
  // Nobody has left the dorms yet: a warehouse refill is unobserved by all.
  const before = play.deliveryView('npc_04');
  assert.equal(before.stockLevel, null);
  play.submitSpatial({ commandId: 'silent-refill', type: 'restock', place: 'warehouse',
    resource: 'food', amount: 5, source: 'player' });
  const after = play.deliveryView('npc_04');
  assert.deepEqual(after.stockLevel, before.stockLevel,
    'an unseen restock must not change the actor belief');
  // Contrast: the same refill is personally witnessed once the actor stands
  // inside the warehouse (its own withdraw leaves it there in this flow).
  play.step(); // npc_04 walks to the warehouse
  assert.equal(play.session.world.npcs.npc_04.location, 'warehouse');
  play.submitSpatial({ commandId: 'seen-refill', type: 'restock', place: 'warehouse',
    resource: 'food', amount: 2, source: 'player' });
  const witnessed = play.deliveryView('npc_04');
  assert.equal(witnessed.stockLevel, DEFAULT_WAREHOUSE_FOOD + 5 + 2,
    'the witnessed refill updates the belief');
});

test('delivery run: save and restore preserve spatial state, beliefs and board', () => {
  const directory = mkdtempSync(join(tmpdir(), 'r3-restore-'));
  const path = join(directory, 'session.json');
  const play = loop();
  const task = play.assign('npc_01', 'deliver-meal');
  play.step(); // travel step, spatial state exists
  play.save(path);
  const restored = GameplayLoop.load(path);
  assert.deepEqual(restored.session.world.spatial, play.session.world.spatial);
  assert.deepEqual(restored.board.toJSON()
    .find(item => item.taskId === task.taskId)?.status, 'active');
  for (let index = 0; index < 10; index += 1) restored.step();
  assert.equal(restored.board.toJSON()
    .find(item => item.taskId === task.taskId)?.status, 'done');
  rmSync(directory, { recursive: true, force: true });
});

test('delivery run: step records stay reference-rules mode with conflicts visible', () => {
  const play = loop();
  play.assign('npc_05', 'deliver-meal');
  const { records, mode } = play.step();
  assert.equal(mode, 'reference-rules/1');
  for (const record of records) {
    assert.equal(record.mode, 'reference-rules/1');
    assert.ok(record.candidates.length > 0);
  }
  const delivery = records.find(record => record.actorId === 'npc_05');
  assert.ok(delivery);
  assert.equal(delivery!.selectedId, 'g-travel-warehouse');
});
