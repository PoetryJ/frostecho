/**
 * G05-R1 workstream A self-tests — simulated steps and the decay rule.
 *
 * advance_time: world-only, integer steps in [1,10], payload exactly {steps},
 * one atomic commit per command. Every NPC incl. the player loses
 * DECAY_PER_STEP=10 satiety per step, floored at 0: TimeAdvanced{before,after,
 * steps} first, then one HungerChanged per changed NPC in id order. Pre-G05
 * worlds without simTime read it as 0 and stay canonically identical until the
 * first advance; initialWorld does not materialize the field.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld, replay } from '../src/engine';
import { WORLD_ACTOR_ID } from '../src/rules';
import { RULES, type WorldState } from '../src/types';

const world = (): WorldState => ({
  npcs: {
    npc_a: { id: 'npc_a', location: 'kitchen', hunger: 70 },
    npc_b: { id: 'npc_b', location: 'dorm', hunger: 20 },
    npc_c: { id: 'npc_c', location: 'kitchen', hunger: 5 },
  },
  food: { kitchen: 0, dorm: 0 },
  tick: 0,
  simTime: 0,
});

let counter = 0;
const id = (): string => `t${++counter}`;
const advance = (steps: number) =>
  ({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'advance_time', payload: { steps } }) as never;

test('70 advance 3 = 40; another 3 = 10; a floored NPC stays at 0', () => {
  const engine = new Engine(world());
  assert.equal(engine.submit(advance(3)).status, 'accepted');
  let state = engine.getState();
  assert.equal(state.simTime, 3);
  assert.deepEqual([state.npcs.npc_a.hunger, state.npcs.npc_b.hunger, state.npcs.npc_c.hunger], [40, 0, 0]);
  engine.submit(advance(3));
  state = engine.getState();
  assert.equal(state.simTime, 6);
  assert.deepEqual([state.npcs.npc_a.hunger, state.npcs.npc_b.hunger, state.npcs.npc_c.hunger], [10, 0, 0]);
});

test('one atomic commit: TimeAdvanced first, then id-sorted HungerChanged for changed NPCs only', () => {
  const engine = new Engine(world());
  engine.submit(advance(1));
  const events = engine.getEvents();
  assert.equal(events[0].type, 'TimeAdvanced');
  assert.deepEqual(
    [events[0].before, events[0].after, events[0].steps],
    [0, 1, 1],
  );
  const hungers = events.slice(1) as { npcId: string; before: number; after: number }[];
  assert.deepEqual(hungers.map(h => h.npcId), ['npc_a', 'npc_b', 'npc_c']);
  assert.deepEqual(hungers.map(h => [h.before, h.after]), [[70, 60], [20, 10], [5, 0]]);
  assert.equal(engine.getState().tick, 1, 'one command = one tick, not one per step');
  // A second advance: npc_c is already at 0 and stays silent.
  engine.submit(advance(1));
  const second = engine.getEvents().slice(4);
  assert.equal(second[0].type, 'TimeAdvanced');
  assert.deepEqual(second.slice(1).map(h => (h as { npcId: string }).npcId), ['npc_a', 'npc_b']);
});

test('advance 3 equals three advance 1 in simTime and satiety (logs may differ)', () => {
  const single = new Engine(world());
  single.submit(advance(3));
  const split = new Engine(world());
  split.submit(advance(1));
  split.submit(advance(1));
  split.submit(advance(1));
  assert.equal(single.getState().simTime, split.getState().simTime);
  for (const id of ['npc_a', 'npc_b', 'npc_c']) {
    assert.equal(single.getState().npcs[id].hunger, split.getState().npcs[id].hunger, id);
  }
});

test('retrying the same commandId never decays twice', () => {
  const engine = new Engine(world());
  const command = { commandId: 'same', actorId: WORLD_ACTOR_ID, type: 'advance_time', payload: { steps: 2 } } as never;
  assert.equal(engine.submit(command).status, 'accepted');
  assert.equal(engine.submit(command).status, 'duplicate');
  assert.equal(engine.getState().simTime, 2);
  assert.equal(engine.getState().npcs.npc_a.hunger, 50);
});

test('advance_time payload validation is strict and rejects leave state untouched', () => {
  const engine = new Engine(world());
  const bad: unknown[] = [
    { steps: 0 }, { steps: -5 }, { steps: 11 }, { steps: 1.5 },
    { steps: '3' }, { steps: 3, extra: 1 }, { minutes: 30 }, {},
  ];
  for (const payload of bad) {
    const result = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'advance_time', payload } as never);
    assert.equal(result.status, 'rejected', `payload ${JSON.stringify(payload)} must be rejected`);
    assert.equal(result.reason, 'INVALID_PAYLOAD');
  }
  assert.equal(engine.getState().simTime, 0);
  assert.equal(engine.getState().npcs.npc_a.hunger, 70);
});

test('NPCs can never advance_time; the world actor may only restock and advance_time', () => {
  const engine = new Engine(world());
  const npc = engine.submit({ commandId: id(), actorId: 'npc_a', type: 'advance_time', payload: { steps: 1 } } as never);
  assert.equal(npc.status, 'rejected');
  assert.equal(npc.reason, 'FORBIDDEN_ACTION');
  const move = engine.submit({ commandId: id(), actorId: WORLD_ACTOR_ID, type: 'move', payload: { to: 'dorm' } } as never);
  assert.equal(move.reason, 'FORBIDDEN_ACTION');
});

test('pre-G05 worlds without simTime read as 0 and materialize only on advance', () => {
  const legacy = world();
  delete legacy.simTime;
  const engine = new Engine(legacy);
  assert.equal(engine.getState().simTime, undefined, 'old saves are not rewritten');
  engine.submit(advance(2));
  assert.equal(engine.getState().simTime, 2);
  assert.equal(engine.getState().npcs.npc_a.hunger, 50);
});

test('replay from events reproduces simTime and hunger exactly', () => {
  const engine = new Engine(world());
  engine.submit(advance(3));
  engine.submit(advance(10));
  const replayed = replay(engine.getInitialState(), engine.getEvents());
  assert.deepEqual(replayed, engine.getState());
});

test('initialWorld stays pre-G05 canonical: no simTime field', () => {
  assert.equal(initialWorld().simTime, undefined);
  assert.equal('simTime' in initialWorld(), false);
});

test('decay uses the frozen rule constants', () => {
  assert.equal(RULES.DECAY_PER_STEP, 10);
  assert.equal(RULES.TIME_ADVANCE_MAX_STEPS, 10);
  assert.equal(RULES.EAT_HUNGER_RESTORE, 30, 'eat +30 is unchanged');
});
