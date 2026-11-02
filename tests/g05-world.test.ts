/**
 * G05 workstream A self-tests — simulated time and the metabolic rule.
 *
 * advance_time: world-only, integer minutes in [1,120], payload exactly
 * {minutes}, tick advances once per command. Every 10 simulated minutes each
 * NPC gains +1 hunger (clamped at 100): TimeAdvanced first, then one
 * HungerChanged per NPC in id order. Pre-G05 worlds without simTime keep
 * working and stay canonically identical until the first advance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld, replay } from '../src/engine';
import { WORLD_ACTOR_ID } from '../src/rules';
import { RULES, type WorldState } from '../src/types';

const world = (): WorldState => ({
  npcs: {
    npc_a: { id: 'npc_a', location: 'kitchen', hunger: 40 },
    npc_b: { id: 'npc_b', location: 'dorm', hunger: 20 },
    npc_c: { id: 'npc_c', location: 'kitchen', hunger: 99 },
  },
  food: { kitchen: 0, dorm: 0 },
  tick: 0,
  simTime: 0,
});

let counter = 0;
const id = (): string => `t${++counter}`;
const advance = (minutes: number) =>
  ({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'advance_time', payload: { minutes } }) as never;

test('advance_time is accepted, emits TimeAdvanced and advances tick and simTime', () => {
  const engine = new Engine(world());
  const result = engine.submit(advance(10));
  assert.equal(result.status, 'accepted');
  const state = engine.getState();
  assert.equal(state.simTime, 10);
  assert.equal(state.tick, 1);
  const events = engine.getEvents();
  assert.equal(events.length, 4); // TimeAdvanced + 3 HungerChanged
  assert.equal(events[0].type, 'TimeAdvanced');
  const time = events[0] as { type: string; before: number; after: number };
  assert.deepEqual([time.before, time.after], [0, 10]);
});

test('metabolism: +1 hunger per NPC per crossed 10-minute boundary, id-sorted after TimeAdvanced', () => {
  const engine = new Engine(world());
  engine.submit(advance(25));
  const state = engine.getState();
  assert.equal(state.simTime, 25);
  // boundaries crossed: 10, 20 → +2 each
  assert.deepEqual(
    [state.npcs.npc_a.hunger, state.npcs.npc_b.hunger, state.npcs.npc_c.hunger],
    [42, 22, 100],
  );
  const events = engine.getEvents();
  assert.equal(events[0].type, 'TimeAdvanced');
  const hungers = events.slice(1) as { type: string; npcId: string; before: number; after: number }[];
  assert.deepEqual(hungers.map(h => h.npcId), ['npc_a', 'npc_b', 'npc_c']);
  assert.deepEqual(hungers.map(h => [h.before, h.after]), [[40, 42], [20, 22], [99, 100]]);
  // clamped NPC still reports the change once, then saturates silently
  engine.submit(advance(10));
  const events2 = engine.getEvents();
  const lastTimeIndex = events2.map(e => e.type).lastIndexOf('TimeAdvanced');
  const second = events2.slice(lastTimeIndex + 1) as { npcId: string; after: number }[];
  assert.deepEqual(second.map(h => h.npcId), ['npc_a', 'npc_b']);
  assert.equal(engine.getState().npcs.npc_c.hunger, RULES.HUNGER_MAX);
});

test('partial boundary: 9 minutes change nothing, the 10th minute crosses exactly one boundary', () => {
  const engine = new Engine(world());
  engine.submit(advance(9));
  assert.equal(engine.getEvents().length, 1); // TimeAdvanced only
  engine.submit(advance(1));
  const events = engine.getEvents();
  assert.equal(events.length, 1 + 1 + 3); // first command + TimeAdvanced + 3 hunger events
  assert.equal(engine.getState().npcs.npc_a.hunger, 41);
});

test('a single 120-minute advance crosses 12 boundaries at once', () => {
  const engine = new Engine(world());
  engine.submit(advance(RULES.TIME_ADVANCE_MAX_MIN));
  const state = engine.getState();
  assert.equal(state.simTime, 120);
  assert.equal(state.npcs.npc_a.hunger, 52);
  assert.equal(state.npcs.npc_c.hunger, 100);
});

test('advance_time payload validation is strict', () => {
  const engine = new Engine(world());
  const bad: unknown[] = [
    { minutes: 0 }, { minutes: -5 }, { minutes: 121 }, { minutes: 10.5 },
    { minutes: '10' }, { minutes: 10, extra: 1 }, { location: 'kitchen' }, {},
  ];
  for (const payload of bad) {
    const result = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'advance_time', payload } as never);
    assert.equal(result.status, 'rejected', `payload ${JSON.stringify(payload)} must be rejected`);
    assert.equal(result.reason, 'INVALID_PAYLOAD');
  }
  assert.equal(engine.getState().simTime, 0);
});

test('NPCs can never advance_time; the world actor may only restock and advance_time', () => {
  const engine = new Engine(world());
  const npc = engine.submit({ commandId: id(), actorId: 'npc_a', type: 'advance_time', payload: { minutes: 10 } } as never);
  assert.equal(npc.status, 'rejected');
  assert.equal(npc.reason, 'FORBIDDEN_ACTION');
  const move = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'move', payload: { to: 'dorm' } } as never);
  assert.equal(move.reason, 'FORBIDDEN_ACTION');
  const eat = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'eat', payload: {} } as never);
  assert.equal(eat.reason, 'FORBIDDEN_ACTION');
});

test('pre-G05 worlds without simTime stay valid until the first advance materializes it', () => {
  const legacy = world();
  delete legacy.simTime;
  const engine = new Engine(legacy);
  assert.equal(engine.getState().simTime, undefined);
  engine.submit(advance(10));
  assert.equal(engine.getState().simTime, 10);
});

test('replay from events reproduces simTime and hunger exactly', () => {
  const engine = new Engine(world());
  engine.submit(advance(30));
  engine.submit(advance(45));
  const replayed = replay(engine.getInitialState(), engine.getEvents());
  assert.deepEqual(replayed, engine.getState());
});

test('initialWorld starts at simTime 0', () => {
  assert.equal(initialWorld().simTime, 0);
});
