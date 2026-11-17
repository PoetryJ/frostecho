/**
 * R3 (P): spatial command coverage for the WorldV2 reducer — travel over the
 * real village grid, warehouse stock withdraw/restock, meal delivery and road
 * closing/reopening, plus the frozen-flow guarantee that pre-R3 command
 * streams never materialize a `spatial` field.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCommand,
  createWorldV2,
  DEFAULT_WAREHOUSE_FOOD,
  runEightNpcDay,
  submitCommand,
  SurvivalError,
  type WorldV2,
} from '../src/survival/world-v2';
import { BUILDINGS, findPath, MAPS, cellKey } from '../src/spatial-v2/map';

const IDS = ['npc_a', 'npc_b', 'npc_c', 'npc_d', 'npc_e', 'npc_f', 'npc_g', 'npc_h'];

function world(): WorldV2 {
  return createWorldV2({ npcIds: IDS, rngSeed: 'r3-spatial' });
}

function building(id: string): (typeof BUILDINGS)[number] {
  const found = BUILDINGS.find(entry => entry.id === id);
  assert.ok(found, `building ${id} exists`);
  return found;
}

function routeTo(world_: WorldV2, actorId: string, goal: { x: number; y: number }):
    Array<{ x: number; y: number }> {
  const npc = world_.npcs[actorId];
  const home = building(npc.location);
  const result = findPath(MAPS.village, home.door, goal, new Set(world_.spatial?.closedCells ?? []));
  assert.ok(result.path, `path to ${goal.x},${goal.y} must exist`);
  return result.path;
}

test('map: A* reaches every building door from every other door', () => {
  for (const from of BUILDINGS) {
    for (const to of BUILDINGS) {
      if (from.id === to.id) continue;
      const result = findPath(MAPS.village, from.door, to.door);
      assert.ok(result.path, `${from.id} -> ${to.id} reachable`);
      assert.deepEqual(result.path![0], from.door);
      assert.deepEqual(result.path![result.path!.length - 1], to.door);
    }
  }
});

test('travel: dorm -> warehouse door advances time, drains the traveller and updates location', () => {
  const state = world();
  const route = routeTo(state, 'npc_a', building('warehouse').door);
  const { state: after, events } = applyCommand(state, {
    commandId: 't1', type: 'travel', actorId: 'npc_a', route, minutesPerTile: 2,
  });
  const tiles = route.length - 1;
  assert.equal(after.simTime, tiles * 2);
  assert.equal(after.npcs.npc_a.location, 'warehouse');
  assert.equal(after.npcs.npc_b.location, 'dorm-b', 'only the traveller moves');
  assert.ok(after.npcs.npc_a.hunger < state.npcs.npc_a.hunger);
  assert.ok(after.npcs.npc_a.stamina < state.npcs.npc_a.stamina);
  assert.deepEqual(after.spatial!.positions.npc_a, building('warehouse').door);
  const traveled = events.find(entry => entry.type === 'traveled');
  assert.equal(traveled?.payload.tiles, tiles);
  assert.equal(traveled?.payload.arrivedAt, 'warehouse');
});

test('travel: route must start at the actor cell and step 4-adjacent', () => {
  const state = world();
  const door = building('dorm-a').door;
  assert.throws(() => applyCommand(state, {
    commandId: 'bad1', type: 'travel', actorId: 'npc_a',
    route: [{ x: door.x + 5, y: door.y }, { x: door.x + 6, y: door.y }], minutesPerTile: 1,
  }), (error: unknown) => error instanceof SurvivalError && error.code === 'bad_route');
  assert.throws(() => applyCommand(state, {
    commandId: 'bad2', type: 'travel', actorId: 'npc_a',
    route: [door, { x: door.x + 2, y: door.y }], minutesPerTile: 1,
  }), (error: unknown) => error instanceof SurvivalError && error.code === 'bad_route');
});

test('travel: a wall cell is never walkable', () => {
  const state = world();
  const door = building('dorm-a').door;
  // Straight into the dorm footprint above the door row.
  assert.throws(() => applyCommand(state, {
    commandId: 'wall', type: 'travel', actorId: 'npc_a',
    route: [door, { x: door.x, y: door.y - 1 }], minutesPerTile: 1,
  }), (error: unknown) => error instanceof SurvivalError && error.code === 'road_blocked');
});

test('withdraw: success moves warehouse stock into carry with an event', () => {
  let state = world();
  const route = routeTo(state, 'npc_a', building('warehouse').door);
  state = applyCommand(state, { commandId: 'w0', type: 'travel', actorId: 'npc_a', route, minutesPerTile: 1 }).state;
  const { state: after, events } = applyCommand(state, {
    commandId: 'w1', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 2,
  });
  assert.equal(after.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD - 2);
  assert.equal(after.spatial!.carry.npc_a.meals, 2);
  assert.equal(events[0].type, 'stock_withdrawn');
});

test('withdraw: out-of-stock is an observable event, not an error', () => {
  let state = world();
  const route = routeTo(state, 'npc_a', building('warehouse').door);
  state = applyCommand(state, { commandId: 'w0', type: 'travel', actorId: 'npc_a', route, minutesPerTile: 1 }).state;
  state = applyCommand(state, {
    commandId: 'w1', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: DEFAULT_WAREHOUSE_FOOD,
  }).state;
  const { state: after, events } = applyCommand(state, {
    commandId: 'w2', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 1,
  });
  assert.equal(events[0].type, 'out_of_stock');
  assert.equal(events[0].payload.available, 0);
  assert.equal(events[0].payload.wanted, 1);
  assert.equal(after.spatial!.stocks.warehouse.food, 0);
  assert.equal(after.spatial!.carry.npc_a.meals, DEFAULT_WAREHOUSE_FOOD);
});

test('withdraw requires standing at the place', () => {
  assert.throws(() => applyCommand(world(), {
    commandId: 'far', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 1,
  }), (error: unknown) => error instanceof SurvivalError && error.code === 'bad_location');
});

test('restock after an out_of_stock observation enables a retry', () => {
  let state = world();
  const route = routeTo(state, 'npc_a', building('warehouse').door);
  state = applyCommand(state, { commandId: 't', type: 'travel', actorId: 'npc_a', route, minutesPerTile: 1 }).state;
  state = applyCommand(state, {
    commandId: 'w1', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: DEFAULT_WAREHOUSE_FOOD,
  }).state;
  const empty = applyCommand(state, {
    commandId: 'w2', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 1,
  });
  assert.equal(empty.events[0].type, 'out_of_stock');
  const restocked = applyCommand(empty.state, {
    commandId: 'r1', type: 'restock', place: 'warehouse', resource: 'food', amount: 3, source: 'convoy',
  });
  assert.equal(restocked.events[0].type, 'stock_restocked');
  assert.equal(restocked.state.spatial!.stocks.warehouse.food, 3);
  const retry = applyCommand(restocked.state, {
    commandId: 'w3', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 1,
  });
  assert.equal(retry.events[0].type, 'stock_withdrawn');
  assert.equal(retry.state.spatial!.carry.npc_a.meals, DEFAULT_WAREHOUSE_FOOD + 1);
});

test('deliver: shortfall is observable; a real delivery completes the meal flow', () => {
  let state = world();
  const toWarehouse = routeTo(state, 'npc_a', building('warehouse').door);
  state = applyCommand(state, { commandId: 't1', type: 'travel', actorId: 'npc_a', route: toWarehouse, minutesPerTile: 1 }).state;
  state = applyCommand(state, {
    commandId: 'w1', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 2,
  }).state;
  const toKitchen = routeTo(state, 'npc_a', building('kitchen').door);
  // Route must start where the actor actually stands now.
  assert.equal(cellKey(toKitchen[0]), cellKey(building('warehouse').door));
  state = applyCommand(state, { commandId: 't2', type: 'travel', actorId: 'npc_a', route: toKitchen, minutesPerTile: 1 }).state;
  assert.equal(state.npcs.npc_a.location, 'kitchen');
  const short = applyCommand(state, {
    commandId: 'd1', type: 'deliver', actorId: 'npc_a', to: 'kitchen', amount: 3,
  });
  assert.equal(short.events[0].type, 'delivery_shortfall');
  assert.equal(short.events[0].payload.carried, 2);
  const done = applyCommand(short.state, {
    commandId: 'd2', type: 'deliver', actorId: 'npc_a', to: 'kitchen', amount: 2,
  });
  assert.equal(done.events[0].type, 'meal_delivered');
  assert.equal(done.state.spatial!.deliveredMeals, 2);
  assert.equal(done.state.spatial!.carry.npc_a.meals, 0);
});

test('close-road / open-road: authority events and walkability effects', () => {
  const state = world();
  const door = building('dorm-a').door;
  const corridor = [{ x: door.x, y: door.y + 1 }, { x: door.x + 1, y: door.y + 1 }];
  const closed = applyCommand(state, { commandId: 'c1', type: 'close-road', cells: corridor });
  assert.equal(closed.events[0].type, 'road_closed');
  assert.equal(closed.state.spatial!.closedCells.length, 2);
  assert.throws(() => applyCommand(closed.state, {
    commandId: 'blocked', type: 'travel', actorId: 'npc_a',
    route: [door, corridor[0]], minutesPerTile: 1,
  }), (error: unknown) => error instanceof SurvivalError && error.code === 'road_blocked');
  const reopened = applyCommand(closed.state, { commandId: 'o1', type: 'open-road', cells: [corridor[0]] });
  assert.equal(reopened.events[0].type, 'road_reopened');
  assert.equal(reopened.state.spatial!.closedCells.length, 1);
  const through = applyCommand(reopened.state, {
    commandId: 'ok', type: 'travel', actorId: 'npc_a', route: [door, corridor[0]], minutesPerTile: 1,
  });
  assert.equal(through.events[0].type, 'traveled');
  assert.throws(() => applyCommand(state, {
    commandId: 'oob', type: 'close-road', cells: [{ x: 999, y: 0 }],
  }), (error: unknown) => error instanceof SurvivalError && error.code === 'bad_cells');
});

test('a closed corridor forces a detour, not a shorter path through it', () => {
  // Seal the row south of dorm-a across the map width.
  const door = building('dorm-a').door;
  const row = Array.from({ length: 20 }, (_, index) => ({ x: 13 + index, y: door.y + 1 }));
  const sealed = applyCommand(world(), { commandId: 'seal', type: 'close-road', cells: row }).state;
  const target = building('kitchen').door;
  const direct = findPath(MAPS.village, door, target);
  const detour = findPath(MAPS.village, door, target, new Set(sealed.spatial!.closedCells));
  assert.ok(direct.path);
  assert.ok(detour.path, 'kitchen stays reachable around the sealed row');
  assert.ok(detour.path!.length > direct.path!.length, 'detour is strictly longer');
});

test('frozen flows: pre-R3 command streams never materialize a spatial field', () => {
  let state = world();
  for (let day = 1; day <= 4; day += 1) state = runEightNpcDay(state, day).state;
  assert.equal('spatial' in state, false, 'no spatial key after the frozen 8-NPC loop');
  assert.equal(state.ending, 'survived');
  // The classic command set through submitCommand also stays spatial-free.
  const classic = submitCommand(world(), { commandId: 'e1', type: 'eat', actorId: 'npc_a', amount: 1 });
  assert.equal('spatial' in classic.state, false);
});

test('spatial commands snapshot and restore through the same schema', () => {
  let state = world();
  const route = routeTo(state, 'npc_a', building('warehouse').door);
  state = applyCommand(state, { commandId: 't1', type: 'travel', actorId: 'npc_a', route, minutesPerTile: 1 }).state;
  state = applyCommand(state, {
    commandId: 'w1', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 1,
  }).state;
  const restored = JSON.parse(JSON.stringify(state)) as WorldV2;
  assert.deepEqual(restored.spatial, state.spatial);
  const again = applyCommand(restored, {
    commandId: 'w2', type: 'withdraw', actorId: 'npc_a', place: 'warehouse', resource: 'food', amount: 1,
  });
  assert.equal(again.state.spatial!.stocks.warehouse.food, DEFAULT_WAREHOUSE_FOOD - 2);
});
