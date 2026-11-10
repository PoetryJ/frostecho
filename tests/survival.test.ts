import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RULES_VERSION,
  SurvivalError,
  applyCommand,
  createWorldV2,
  migrateSnapshot,
  runEightNpcDay,
  viewOf,
  type WorldV2,
} from '../src/survival/world-v2';

const IDS = ['npc_a', 'npc_b', 'npc_c', 'npc_d', 'npc_e', 'npc_f', 'npc_g', 'npc_h'];

function world(): WorldV2 {
  return createWorldV2({ npcIds: IDS, rngSeed: 'fixture-1' });
}

test('eating increases satiety (G05 direction guard)', () => {
  const state = world();
  const before = state.npcs.npc_a.hunger;
  const { state: after } = applyCommand(state, {
    commandId: 'c1', type: 'eat', actorId: 'npc_a', amount: 1,
  });
  assert.ok(after.npcs.npc_a.hunger > before);
  assert.equal(after.resources.food, state.resources.food - 1);
});

test('gathering is deterministic for the same seed and state', () => {
  const command = { commandId: 'g1', type: 'gather', actorId: 'npc_a', resource: 'food', amount: 3 } as const;
  const left = applyCommand(world(), command);
  const right = applyCommand(world(), command);
  assert.deepEqual(left.state.resources, right.state.resources);
  assert.deepEqual(left.events, right.events);
});

test('duplicate command ids are rejected', () => {
  const command = { commandId: 'dup', type: 'advance', minutes: 10 } as const;
  const first = applyCommand(world(), command);
  assert.throws(() => applyCommand(first.state, command), (error: unknown) =>
    error instanceof SurvivalError && error.code === 'duplicate_command');
});

test('inventory never goes negative', () => {
  const state = world();
  assert.throws(() => applyCommand(state, { commandId: 'e', type: 'eat', actorId: 'npc_a', amount: 999 }),
    (error: unknown) => error instanceof SurvivalError && error.code === 'insufficient_food');
  assert.throws(() => applyCommand(state, { commandId: 'r', type: 'refuel', actorId: 'npc_a', amount: 999 }),
    (error: unknown) => error instanceof SurvivalError && error.code === 'insufficient_firewood');
});

test('a dead npc cannot act and its death is recorded once', () => {
  let state = world();
  state = { ...state, npcs: { ...state.npcs, npc_a: { ...state.npcs.npc_a, health: 0, alive: false } },
    dead: ['npc_a'] };
  assert.throws(() => applyCommand(state, { commandId: 'x', type: 'eat', actorId: 'npc_a', amount: 1 }),
    (error: unknown) => error instanceof SurvivalError && error.code === 'dead_actor');
});

test('four-day 8-npc loop is reproducible and ends with a declared ending', () => {
  const run = () => {
    let state = world();
    for (let day = 1; day <= 4; day += 1) state = runEightNpcDay(state, day).state;
    return state;
  };
  const left = run();
  const right = run();
  assert.equal(left.ending, 'survived');
  assert.deepEqual(left.npcs, right.npcs);
  assert.deepEqual(left.resources, right.resources);
  assert.ok(Object.values(left.npcs).some(npc => npc.alive));
});

test('resources stay non-negative across the four-day loop', () => {
  let state = world();
  for (let day = 1; day <= 4; day += 1) {
    state = runEightNpcDay(state, day).state;
    assert.ok(state.resources.food >= 0);
    assert.ok(state.resources.firewood >= 0);
    assert.ok(state.resources.power >= 0);
    for (const npc of Object.values(state.npcs)) {
      assert.ok(npc.hunger >= 0 && npc.hunger <= 100);
      assert.ok(npc.health >= 0 && npc.health <= 100);
    }
  }
});

test('v0 snapshots migrate with documented defaults and the current rule version', () => {
  const migrated = migrateSnapshot({
    schema: 'frostecho.world-v2/0',
    simTime: 60,
    weather: 'snow',
    npcs: { npc_a: { id: 'npc_a', location: 'dorm-a', hunger: 50, health: 90, alive: true } },
    resources: { food: 1, firewood: 1, power: 1, medicine: 0 },
    furnace: { lit: false, fuel: 0, warmth: 0 },
  });
  assert.equal(migrated.schema, 'frostecho.world-v2/1');
  assert.equal(migrated.rulesVersion, RULES_VERSION);
  assert.equal(migrated.npcs.npc_a.stamina, 80);
  assert.equal(migrated.npcs.npc_a.san, 80);
});

test('a snapshot from another rules version is rejected, not silently upgraded', () => {
  assert.throws(() => migrateSnapshot({ schema: 'frostecho.world-v2/1', rulesVersion: 'other' }),
    (error: unknown) => error instanceof SurvivalError && error.code === 'rules_version');
});

test('the presentation view is frozen', () => {
  const view = viewOf(world());
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.npcs));
});
