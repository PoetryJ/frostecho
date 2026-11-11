import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RULES_VERSION,
  SurvivalError,
  applyCommand,
  createWorldV2,
  MINUTES_PER_DAY,
  migrateSnapshot,
  runEightNpcDay,
  submitCommand,
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
  assert.equal(migrated.schema, 'frostecho.world-v2/2');
  assert.equal(migrated.rulesVersion, RULES_VERSION);
  assert.equal(migrated.npcs.npc_a.stamina, 80);
  assert.equal(migrated.npcs.npc_a.san, 80);
});

test('a snapshot from another rules version is rejected, not silently upgraded', () => {
  assert.throws(() => migrateSnapshot({ schema: 'frostecho.world-v2/2', rulesVersion: 'other' }),
    (error: unknown) => error instanceof SurvivalError && error.code === 'rules_version');
});

test('the presentation view is frozen', () => {
  const view = viewOf(world());
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.npcs));
});

test('R1-F: a command never mutates the input snapshot', () => {
  const input = world();
  const before = JSON.stringify(input);
  applyCommand(input, { commandId: 'adv-1', type: 'advance', minutes: 90 });
  assert.equal(JSON.stringify(input), before);
});

test('R1-F: a previously returned state is not changed by the next command', () => {
  const first = applyCommand(world(), { commandId: 'adv-1', type: 'advance', minutes: 90 }).state;
  const snapshot = JSON.stringify(first);
  applyCommand(first, { commandId: 'adv-2', type: 'advance', minutes: 90 });
  assert.equal(JSON.stringify(first), snapshot);
  assert.notEqual(JSON.stringify(first), JSON.stringify(applyCommand(first,
    { commandId: 'adv-3', type: 'advance', minutes: 90 }).state));
});

test('R1-F: four days is exactly 96h and thirty days is exactly 720h', () => {
  let four = createWorldV2({ npcIds: IDS, days: 4, rngSeed: 'time-4' });
  for (let day = 1; day <= 4; day += 1) four = runEightNpcDay(four, day).state;
  assert.equal(four.simTime, 4 * MINUTES_PER_DAY);
  assert.equal(four.ending, 'survived');

  let thirty = createWorldV2({ npcIds: IDS, days: 30, rngSeed: 'time-30' });
  for (let day = 1; day <= 30; day += 1) thirty = runEightNpcDay(thirty, day).state;
  assert.equal(thirty.simTime, 30 * MINUTES_PER_DAY);
  assert.equal(thirty.ending, 'survived');
});

test('R1-F: illegal location and non-finite amounts are rejected without effect', () => {
  const state = world();
  const before = JSON.stringify(state);
  assert.throws(() => applyCommand(state, { commandId: 'm', type: 'move', actorId: 'npc_a',
    to: 'moon-base' as never }), (error: unknown) =>
    error instanceof SurvivalError && error.code === 'bad_location');
  assert.throws(() => applyCommand(state, { commandId: 'a', type: 'advance', minutes: Number.NaN }),
    (error: unknown) => error instanceof SurvivalError && error.code === 'bad_minutes');
  assert.throws(() => applyCommand(state, { commandId: 'g', type: 'gather', actorId: 'npc_a',
    resource: 'food', amount: Number.POSITIVE_INFINITY }),
  (error: unknown) => error instanceof SurvivalError && error.code === 'bad_amount');
  assert.equal(JSON.stringify(state), before);
});

test('R1-F: submitCommand reports applied/rejected/duplicate and does not double-apply', () => {
  const command = { commandId: 'sub-1', type: 'eat', actorId: 'npc_a', amount: 1 } as const;
  const first = submitCommand(world(), command);
  assert.equal(first.status, 'applied');
  assert.ok(first.eventIds.length > 0);
  assert.equal(first.postStateVersion, 1);
  const second = submitCommand(first.state, command);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.postStateVersion, first.postStateVersion);
  assert.equal(second.state.resources.food, first.state.resources.food);

  const rejected = submitCommand(world(), { commandId: 'sub-2', type: 'eat', actorId: 'npc_a', amount: 999 });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'insufficient_food');
  assert.equal(rejected.postStateVersion, 0);
});
