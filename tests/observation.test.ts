import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialWorld } from '../src';
import { observe } from '../src/agent';

test('observation is own id, location, hunger, food here, and reachable places', () => {
  const state = initialWorld();
  const seen = observe(state, 'npc_a');
  assert.deepEqual(seen, {
    id: 'npc_a',
    location: 'dorm',
    hunger: 40,
    foodHere: 0,
    reachable: ['dorm', 'kitchen'],
  });
  assert.deepEqual(Object.keys(seen).sort(), ['foodHere', 'hunger', 'id', 'location', 'reachable']);
});

test('foodHere follows the current location only', () => {
  const state = initialWorld();
  state.npcs.npc_a.location = 'kitchen';
  state.food.kitchen = 4;
  state.food.dorm = 9;
  const seen = observe(state, 'npc_a');
  assert.equal(seen.foodHere, 4);
  assert.equal(seen.location, 'kitchen');
  assert.equal(JSON.stringify(seen).includes('9'), false);
});

test('changing invisible food, other NPCs, or tick does not change the observation', () => {
  const base = initialWorld();
  const hidden = initialWorld();
  hidden.food.kitchen = 99;
  hidden.npcs.npc_b.hunger = 3;
  hidden.npcs.npc_b.location = 'kitchen';
  hidden.npcs.npc_b.id = 'other';
  hidden.tick = 50;
  assert.deepEqual(observe(base, 'npc_a'), observe(hidden, 'npc_a'));

  const visible = initialWorld();
  visible.food.dorm = 2;
  assert.equal(observe(visible, 'npc_a').foodHere, 2);
  assert.notDeepEqual(observe(base, 'npc_a'), observe(visible, 'npc_a'));
});

test('observation does not mutate the world and reachable is a copy', () => {
  const state = initialWorld();
  const before = structuredClone(state);
  const seen = observe(state, 'npc_a');
  seen.hunger = 0;
  seen.reachable.push('moon' as 'dorm');
  assert.deepEqual(state, before);
  assert.deepEqual(observe(state, 'npc_a').reachable, ['dorm', 'kitchen']);
});

test('prototype actor ids are not observable NPCs', () => {
  const state = initialWorld();
  for (const actorId of ['proto', 'toString', 'constructor', '__proto__']) {
    assert.throws(() => observe(state, actorId), new RegExp(`unknown actor ${actorId}`));
  }
});
