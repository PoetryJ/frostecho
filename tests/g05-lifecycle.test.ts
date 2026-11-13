/**
 * G05-R1 workstream B self-tests — the restored need-reactivation state machine.
 *
 * LOW=40 reactivates only a satisfied actor (recurring); GOAL=70 completes a
 * cycle on the authoritative hunger; an empty kitchen means stop->waiting and
 * waking only once local food exists. Session 5 / actor 10 budgets are never
 * reset or exempted by time or cycles. G04 (one-shot) semantics are unchanged.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { EPISODE_CALL_LIMIT, NEED_REACTIVATE_HUNGER, type NeedPolicy } from '../src/reactive/contracts';
import { GOAL_HUNGER_AT_LEAST } from '../src/agent/contracts';

function game(needPolicy: NeedPolicy, kitchenFood = 0, hunger?: Record<string, number>) {
  return createNeedsGame({
    episodeId: `life-${needPolicy}-${kitchenFood}`,
    initialState: buildNeedsWorld({ kitchenFood, ...(hunger !== undefined ? { hunger } : {}) }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'fixture',
    thinking: true,
    needPolicy,
  });
}

test('initial all-70 world completes the initial check with zero provider calls', async () => {
  const g = game('recurring');
  await g.runUntilIdle();
  const record = g.snapshot();
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 0);
  for (const id of g.actorIds) assert.equal(record.actors[id].state, 'satisfied');
  await g.close();
});

test('recurring: satisfied at 40 reactivates exactly once; 41 rests', async () => {
  assert.equal(NEED_REACTIVATE_HUNGER, 40);
  const g = game('recurring', 4);
  await g.runUntilIdle();
  g.worldAdvanceTime(3); // 70 -> 40
  await g.runUntilIdle();
  let record = g.snapshot();
  // 40 <= LOW: both actors eat once back to 70 (2 calls).
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 2);
  assert.equal(record.finalState.npcs.npc_a.hunger, 70);
  // From 70, advance 2 => 50 (> LOW): rest, no new cycle, no call.
  g.worldAdvanceTime(2);
  const cyclesBefore = record.actors.npc_a.cycles;
  await g.runUntilIdle();
  record = g.snapshot();
  assert.equal(record.finalState.npcs.npc_a.hunger, 50);
  assert.equal(record.actors.npc_a.cycles, cyclesBefore);
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 2);
  await g.close();
});

test('one-shot: satisfied actors never reactivate even at/below 40', async () => {
  const g = game('one-shot', 4);
  await g.runUntilIdle();
  g.worldAdvanceTime(3);
  await g.runUntilIdle();
  const record = g.snapshot();
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 0);
  assert.equal(record.finalState.npcs.npc_a.hunger, 40);
  for (const id of g.actorIds) assert.equal(record.actors[id].state, 'satisfied');
  await g.close();
});

test('30 -> eat 60 is not success; the same session eats again to 90', async () => {
  const g = game('recurring', 0);
  await g.runUntilIdle();
  g.worldAdvanceTime(4); // 70 -> 30
  await g.runUntilIdle(); // reactivate at 40-crossing? 30 <= 40, empty kitchen: stop -> waiting (1 call each)
  let record = g.snapshot();
  for (const id of g.actorIds) assert.equal(record.actors[id].state, 'waiting');
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 2);
  g.worldRestock('kitchen', 4);
  await g.runUntilIdle();
  record = g.snapshot();
  // 30 -> 60 (still hungry, same session) -> 90 (goal). 2 eats per actor.
  assert.equal(record.finalState.npcs.npc_a.hunger, 90);
  assert.equal(record.finalState.npcs.npc_c.hunger, 90);
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 6);
  for (const id of g.actorIds) {
    assert.equal(record.actors[id].state, 'satisfied');
    assert.equal(record.actors[id].goalReached, true);
  }
  await g.close();
});

test('waiting keeps decaying without new cycles or calls until local food exists', async () => {
  const g = game('recurring', 0);
  await g.runUntilIdle();
  g.worldAdvanceTime(3);
  await g.runUntilIdle();
  const before = g.snapshot();
  g.worldAdvanceTime(1);
  await g.runUntilIdle();
  for (let i = 0; i < 100; i++) { g.notifyWorldChange(); await g.runUntilIdle(); }
  const after = g.snapshot();
  assert.equal(after.finalState.npcs.npc_a.hunger, 30);
  assert.equal(Object.values(after.actors).reduce((s, a) => s + a.providerCalls, 0), 2);
  for (const id of g.actorIds) {
    assert.equal(after.actors[id].cycles, before.actors[id].cycles);
    assert.equal(after.actors[id].state, 'waiting');
  }
  await g.close();
});

test('time input while a decision is in flight executes against the authoritative world', async () => {
  const g = game('recurring', 4);
  await g.runUntilIdle();
  g.worldAdvanceTime(3); // 40 -> reactivation on next run
  let resolved = false;
  const pending = g.runUntilIdle().then(() => { resolved = true; });
  // In-flight world input is accepted (not "busy") and decays immediately.
  const result = g.worldAdvanceTime(1);
  assert.equal(result.ok, true);
  await pending;
  assert.equal(resolved, true);
  const record = g.snapshot();
  // 40 - 10 = 30 before the first eat lands; 30 + 30 = 60 is not the goal, so
  // the session continues to 90 if food remains (kitchen had 4).
  assert.ok(record.finalState.simTime === 4);
  assert.ok(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0) >= 2);
  await g.close();
});

test('budgets: time and cycles never reset the per-actor episode limit', async () => {
  const g = game('recurring', 0);
  await g.runUntilIdle();
  // Drive repeated need cycles: decay, restock, eat back to the goal. Each
  // reactivated cycle spends 2 calls; the 10-call episode budget must bind
  // across cycles with no reset, and exhaustion must be terminal.
  for (let i = 0; i < 14; i++) {
    g.worldAdvanceTime(4);
    g.worldRestock('kitchen', 4);
    await g.runUntilIdle();
    if (g.actorIds.every(id => g.snapshot().actors[id].providerCalls >= EPISODE_CALL_LIMIT)) break;
  }
  const record = g.snapshot();
  for (const id of g.actorIds) {
    assert.ok(record.actors[id].providerCalls <= EPISODE_CALL_LIMIT, `${id} exceeded the episode budget`);
  }
  assert.ok(record.actors.npc_a.providerCalls >= EPISODE_CALL_LIMIT - 2, 'the loop must actually exercise the budget');
  // Once exhausted, neither restock nor more time resurrects the actor.
  const calls = record.actors.npc_a.providerCalls;
  g.worldRestock('kitchen', 10);
  g.worldAdvanceTime(5);
  await g.runUntilIdle();
  const after = g.snapshot();
  assert.equal(after.actors.npc_a.providerCalls, calls);
  await g.close();
});

test('ordinary stop / closed states do not resurrect on time input', async () => {
  const g = game('recurring', 4);
  await g.runUntilIdle();
  await g.close();
  const before = g.snapshot();
  assert.equal(g.worldAdvanceTime(3).ok, false, 'closed game rejects time');
  await g.runUntilIdle();
  assert.equal(g.snapshot().finalState.simTime, before.finalState.simTime);
});

test('G04 one-shot semantics: restock still wakes a waiting actor (G04-R1 preserved)', async () => {
  const g = game('one-shot', 0, { npc_a: 40, npc_c: 40, npc_b: 70 });
  // Hunger 40 < 70: the initial cycle calls the provider, stops on the empty kitchen.
  await g.runUntilIdle();
  let record = g.snapshot();
  for (const id of g.actorIds) assert.equal(record.actors[id].state, 'waiting');
  g.worldRestock('kitchen', 2);
  await g.runUntilIdle();
  record = g.snapshot();
  assert.equal(record.finalState.npcs.npc_a.hunger, 70);
  assert.equal(Object.values(record.actors).reduce((s, a) => s + a.providerCalls, 0), 4);
  await g.close();
});

test('goal constants stay frozen', () => {
  assert.equal(GOAL_HUNGER_AT_LEAST, 70);
  assert.equal(EPISODE_CALL_LIMIT, 10);
});
