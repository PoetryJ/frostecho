/**
 * R4 (G3): one world clock and one conservation rule. A travel leg evolves
 * exactly what an advance of the same minutes evolves (furnace, every NPC,
 * deaths, calendar, ending); the traveller pays one explicit extra cost; every
 * food transfer debits one source and credits one target.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCommand, createWorldV2, DEFAULT_WAREHOUSE_FOOD, submitCommand,
  TRAVEL_STAMINA_PER_TILE, type WorldV2 } from '../src/survival/world-v2';
import { BUILDINGS, MAPS, findPath } from '../src/spatial-v2/map';

function world(): WorldV2 {
  return createWorldV2({ npcIds: ['npc_01', 'npc_02', 'npc_03'], rngSeed: 'r4-clock' });
}

function route(door: string): Array<{ x: number; y: number }> {
  const target = BUILDINGS.find(building => building.id === door)!.door;
  return findPath(MAPS.village, BUILDINGS.find(building => building.id === 'dorm-a')!.door,
    target).path!;
}

test('R4-G3: a travel leg and an advance of the same minutes evolve identically', () => {
  const base = world();
  const path = route('kitchen');
  const minutes = (path.length - 1) * 2;
  const advanced = submitCommand(base, { commandId: 'adv', type: 'advance', minutes }).state;
  const traveled = applyCommand(base, { commandId: 'trv', type: 'travel',
    actorId: 'npc_01', route: path, minutesPerTile: 2 }).state;
  assert.equal(traveled.simTime, advanced.simTime);
  assert.equal(traveled.day, advanced.day);
  assert.deepEqual(traveled.furnace, advanced.furnace, 'the furnace burns once per span');
  for (const id of ['npc_02', 'npc_03']) {
    const left = advanced.npcs[id];
    const right = traveled.npcs[id];
    for (const key of ['hunger', 'stamina', 'health', 'san'] as const) {
      assert.equal(right[key], left[key], `${id}.${key} follows the shared clock`);
    }
  }
  const extra = advanced.npcs.npc_01.stamina - traveled.npcs.npc_01.stamina;
  assert.ok(Math.abs(extra - (path.length - 1) * TRAVEL_STAMINA_PER_TILE) < 1e-9,
    'the traveller pays exactly one explicit extra cost');
});

test('R4-G3: long travel cannot keep bystanders (or the furnace) frozen', () => {
  let state = world();
  const toKitchen = route('kitchen');
  for (let index = 0; index < 60; index += 1) {
    const leg = index % 2 === 0 ? toKitchen : route('dorm-a');
    const start = state.npcs.npc_01.location === 'dorm-a'
      ? BUILDINGS.find(building => building.id === 'dorm-a')!.door
      : BUILDINGS.find(building => building.id === 'kitchen')!.door;
    const path = findPath(MAPS.village, start,
      BUILDINGS.find(building => building.id === (index % 2 === 0 ? 'kitchen' : 'dorm-a'))!.door).path!;
    const result = submitCommand(state, { commandId: `leg-${index}`, type: 'travel',
      actorId: 'npc_01', route: path, minutesPerTile: 2 });
    if (result.status !== 'applied') break;
    state = result.state;
  }
  assert.ok(state.npcs.npc_02.hunger < 70, 'bystanders starve on the same clock');
  assert.ok(state.furnace.fuel < 6, 'the furnace burns while anyone walks');
  assert.ok(state.simTime > 0);
});

test('R4-G3: a settled ending is never re-litigated by later travel', () => {
  const base = world();
  const finished = base.ending === 'none'
    ? { ...base, simTime: 4 * 24 * 60, ending: 'survived' as const }
    : base;
  const path = route('kitchen');
  const result = applyCommand(finished, { commandId: 'late', type: 'travel',
    actorId: 'npc_01', route: path, minutesPerTile: 2 });
  assert.equal(result.state.ending, 'survived', 'a settled ending stays settled');
});

test('R4-G3: every food transfer debits one source and credits one target', () => {
  let state = world();
  const publicBefore = state.resources.food;
  const gathered = submitCommand(state, { commandId: 'g1', type: 'gather',
    actorId: 'npc_01', resource: 'food', amount: 2 }).state;
  const gained = gathered.resources.food - publicBefore;
  assert.ok(gained > 0, 'gathering adds public food');
  assert.equal(gathered.spatial, undefined, 'gathering alone does not touch the warehouse');

  const path = route('warehouse');
  const arrived = submitCommand(gathered, { commandId: 't1', type: 'travel',
    actorId: 'npc_01', route: path, minutesPerTile: 2 }).state;
  const deposit = submitCommand(arrived, { commandId: 'd1', type: 'deposit',
    actorId: 'npc_01', place: 'warehouse', resource: 'food', amount: 2 });
  assert.equal(deposit.events[0].type, 'stock_deposited');
  assert.equal(deposit.state.resources.food, arrived.resources.food - 2);
  assert.equal(deposit.state.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD + 2);
  assert.equal(deposit.events[0].payload.publicFood, deposit.state.resources.food);
  assert.equal(deposit.events[0].payload.total, DEFAULT_WAREHOUSE_FOOD + 2);

  const withdraw = submitCommand(deposit.state, { commandId: 'w1', type: 'withdraw',
    actorId: 'npc_01', place: 'warehouse', resource: 'food', amount: 1 });
  assert.equal(withdraw.state.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD + 1);
  assert.equal(withdraw.state.spatial!.carry.npc_01.meals, 1);

  const kitchen = findPath(MAPS.village, BUILDINGS.find(building => building.id === 'warehouse')!.door,
    BUILDINGS.find(building => building.id === 'kitchen')!.door).path!;
  const atKitchen = submitCommand(withdraw.state, { commandId: 't2', type: 'travel',
    actorId: 'npc_01', route: kitchen, minutesPerTile: 2 }).state;
  const delivered = submitCommand(atKitchen, { commandId: 'd2', type: 'deliver',
    actorId: 'npc_01', to: 'kitchen', amount: 1 });
  assert.equal(delivered.state.spatial!.carry.npc_01.meals, 0);
  assert.equal(delivered.state.spatial!.deliveredMeals, 1);
  assert.equal(delivered.state.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD + 1);
  assert.equal(delivered.state.resources.food, gathered.resources.food - 2);
});

test('R4-G3: a duplicate deposit replays and never double-credits', () => {
  let state = world();
  const path = route('warehouse');
  state = submitCommand(state, { commandId: 't1', type: 'travel', actorId: 'npc_01',
    route: path, minutesPerTile: 2 }).state;
  const first = submitCommand(state, { commandId: 'dep-1', type: 'deposit',
    actorId: 'npc_01', place: 'warehouse', resource: 'food', amount: 2 });
  const replay = submitCommand(first.state, { commandId: 'dep-1', type: 'deposit',
    actorId: 'npc_01', place: 'warehouse', resource: 'food', amount: 2 });
  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.state.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD + 2,
    'no second credit');
  const conflict = submitCommand(first.state, { commandId: 'dep-1', type: 'deposit',
    actorId: 'npc_01', place: 'warehouse', resource: 'food', amount: 3 });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.reason, 'command_id_conflict');
  assert.equal(conflict.state.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD + 2,
    'no side effect');
});

test('R4-G3: delivering more than carried is an authoritative shortfall, not a success', () => {
  let state = world();
  const path = route('kitchen');
  state = submitCommand(state, { commandId: 't1', type: 'travel', actorId: 'npc_01',
    route: path, minutesPerTile: 2 }).state;
  const result = submitCommand(state, { commandId: 'del', type: 'deliver',
    actorId: 'npc_01', to: 'kitchen', amount: 1 });
  assert.equal(result.events[0].type, 'delivery_shortfall');
  assert.equal(result.state.spatial?.deliveredMeals ?? 0, 0,
    'a shortfall never counts as a delivery');
});
