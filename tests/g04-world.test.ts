/**
 * G04 workstream A self-tests — the single new world rule: `restock`.
 * World-only, existing locations, integer amount in [1,10], no extra fields,
 * no overflow; the world actor is not an NPC and never enters the npcs map.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/engine';
import { WORLD_ACTOR_ID } from '../src/rules';
import type { WorldState } from '../src/types';

const world = (): WorldState => ({
  npcs: {
    npc_a: { id: 'npc_a', location: 'kitchen', hunger: 40 },
    npc_b: { id: 'npc_b', location: 'dorm', hunger: 0 },
    npc_c: { id: 'npc_c', location: 'kitchen', hunger: 20 },
  },
  food: { kitchen: 0, dorm: 0 },
  tick: 0,
});

let counter = 0;
const id = (): string => `t${++counter}`;

test('world restock is accepted, emits FoodRestocked and updates food', () => {
  const engine = new Engine(world());
  const command = { commandId: id(), actorId: WORLD_ACTOR_ID, type: 'restock', payload: { location: 'kitchen', amount: 2 } };
  const result = engine.submit(command as never);
  assert.equal(result.status, 'accepted');
  assert.equal(engine.getState().food.kitchen, 2);
  const events = engine.getEvents();
  assert.equal(events.length, 1);
  const event = events[0] as { type: string; location: string; amount: number; before: number; after: number };
  assert.equal(event.type, 'FoodRestocked');
  assert.deepEqual([event.location, event.amount, event.before, event.after], ['kitchen', 2, 0, 2]);
  // the world never becomes an NPC
  assert.equal(engine.getState().npcs[WORLD_ACTOR_ID], undefined);
  assert.equal(engine.getState().npcs.npc_a.hunger, 40);
});

test('NPCs can never restock', () => {
  const engine = new Engine(world());
  for (const actorId of ['npc_a', 'npc_b', 'npc_c']) {
    const result = engine.submit({ commandId: id(), actorId, type: 'restock', payload: { location: 'kitchen', amount: 1 } } as never);
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'FORBIDDEN_ACTION', `${actorId} must not restock`);
  }
  assert.equal(engine.getState().food.kitchen, 0);
});

test('the world actor may only restock', () => {
  const engine = new Engine(world());
  const move = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'move', payload: { to: 'dorm' } } as never);
  assert.equal(move.reason, 'FORBIDDEN_ACTION');
  const eat = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'eat', payload: {} } as never);
  assert.equal(eat.reason, 'FORBIDDEN_ACTION');
});

test('restock payload validation is strict', () => {
  const engine = new Engine(world());
  const bad: unknown[] = [
    null,
    {},
    { location: 'kitchen' },
    { amount: 2 },
    { location: 'attic', amount: 2 },
    { location: 'kitchen', amount: 0 },
    { location: 'kitchen', amount: 11 },
    { location: 'kitchen', amount: 1.5 },
    { location: 'kitchen', amount: '2' },
    { location: 'kitchen', amount: Number.NaN },
    { location: 'kitchen', amount: 2, extra: true },
    [2, 'kitchen'],
  ];
  for (const payload of bad) {
    const result = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'restock', payload } as never);
    assert.equal(result.status, 'rejected', `payload ${JSON.stringify(payload)} must be rejected`);
    assert.equal(result.reason, 'INVALID_PAYLOAD');
  }
  assert.equal(engine.getState().food.kitchen, 0);
});

test('restock that would overflow a safe integer is rejected', () => {
  const state = world();
  state.food.kitchen = Number.MAX_SAFE_INTEGER - 5;
  const engine = new Engine(state);
  const result = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'restock', payload: { location: 'kitchen', amount: 10 } } as never);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'INVALID_PAYLOAD');
});

test('restock is a normal ledger entry: duplicate ids and replay both work', () => {
  const engine = new Engine(world());
  const commandId = id();
  const command = { commandId, actorId: WORLD_ACTOR_ID, type: 'restock', payload: { location: 'dorm', amount: 3 } };
  const first = engine.submit(command as never);
  assert.equal(first.status, 'accepted');
  const again = engine.submit(command as never);
  assert.equal(again.status, 'duplicate');
  assert.deepEqual(again.eventIds, first.eventIds);
  // conflicting payload under the same id
  const conflict = engine.submit({ ...command, payload: { location: 'dorm', amount: 4 } } as never);
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.reason, 'COMMAND_ID_CONFLICT');
  assert.equal(engine.getState().food.dorm, 3);
  // invariants hold for both locations
  assert.deepEqual(engine.getState().food, { kitchen: 0, dorm: 3 });
});
