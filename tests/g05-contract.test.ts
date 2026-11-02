/**
 * G05-R1 workstream D — independent black-box contract tests.
 *
 * Expectations are written directly from CONTRACTS.txt; this file never imports
 * the production scenarios or judges, so it can catch expectation drift in the
 * matrix itself. It drives only the public createReactiveGame surface, exactly
 * like the external golden-g05.cjs gate.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReactiveGame } from '../src/reactive/game';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { WorldState } from '../src/types';

function initialWorld(kitchen: number): WorldState {
  return {
    simTime: 0,
    tick: 0,
    npcs: Object.fromEntries(['npc_a', 'npc_b', 'npc_c'].map(id => [id, { id, location: 'kitchen', hunger: 70 }])),
    food: { dorm: 0, kitchen },
  };
}

function game(kitchen: number, needPolicy: 'one-shot' | 'recurring') {
  return createReactiveGame({
    episodeId: `contract-${kitchen}-${needPolicy}`,
    initialState: initialWorld(kitchen),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'fixture',
    thinking: true,
    wakePolicy: 'event',
    needPolicy,
  });
}

function view(g: ReturnType<typeof game>) {
  const r = g.snapshot();
  return {
    simTime: r.finalState.simTime ?? 0,
    a: r.finalState.npcs.npc_a.hunger,
    b: r.finalState.npcs.npc_b.hunger,
    c: r.finalState.npcs.npc_c.hunger,
    food: r.finalState.food.kitchen,
    calls: Object.values(r.actors).reduce((s, actor) => s + actor.providerCalls, 0),
  };
}

test('contract: 70 advance 3 = 40 for every NPC incl. the passive player', async () => {
  const g = game(4, 'one-shot');
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 0, a: 70, b: 70, c: 70, food: 4, calls: 0 });
  assert.ok(g.worldAdvanceTime(3).ok);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 3, a: 40, b: 40, c: 40, food: 4, calls: 0 });
  await g.close();
});

test('contract T1 recurring: two meals, 4 calls, kitchen empties, player decays to 10', async () => {
  const g = game(4, 'recurring');
  await g.runUntilIdle();
  g.worldAdvanceTime(3);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 3, a: 70, b: 40, c: 70, food: 2, calls: 2 });
  g.worldAdvanceTime(3);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 6, a: 70, b: 10, c: 70, food: 0, calls: 4 });
  await g.close();
});

test('contract T2: two single steps to 50, then 100 real pumps stay at zero calls and flat cycles', async () => {
  for (const policy of ['one-shot', 'recurring'] as const) {
    const g = game(2, policy);
    await g.runUntilIdle();
    g.worldAdvanceTime(1);
    await g.runUntilIdle();
    g.worldAdvanceTime(1);
    await g.runUntilIdle();
    const before = g.snapshot();
    for (let i = 0; i < 100; i++) {
      g.notifyWorldChange();
      await g.runUntilIdle();
    }
    const after = g.snapshot();
    assert.deepEqual(view(g), { simTime: 2, a: 50, b: 50, c: 50, food: 2, calls: 0 });
    for (const id of g.actorIds) {
      assert.equal(after.actors[id].cycles, before.actors[id].cycles, `${policy}: pump opened a cycle`);
      assert.equal(after.actors[id].state, 'satisfied', 'resting above LOW keeps the satisfied rest state');
    }
    await g.close();
  }
});

test('contract T3 recurring: empty-kitchen wait, 30->60 is not success, then 90', async () => {
  const g = game(0, 'recurring');
  await g.runUntilIdle();
  g.worldAdvanceTime(3);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 3, a: 40, b: 40, c: 40, food: 0, calls: 2 });
  for (const id of g.actorIds) assert.equal(g.snapshot().actors[id].state, 'waiting');
  g.worldAdvanceTime(1);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 4, a: 30, b: 30, c: 30, food: 0, calls: 2 });
  assert.ok(g.worldRestock('kitchen', 4).ok);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 4, a: 90, b: 30, c: 90, food: 0, calls: 6 });
  // 60 must not have been declared a success mid-way: each actor's eating cycle
  // shows two eat turns in one session, and only the 90 ends it.
  for (const id of g.actorIds) {
    const record = g.snapshot();
    const eatingCycle = record.cycles[id].at(-1);
    const eats = eatingCycle?.turns.filter(t => t.step?.command?.type === 'eat' && t.step?.exec?.status === 'accepted') ?? [];
    assert.equal(eats.length, 2, `${id}: 30->60->90 takes two accepted eats`);
    assert.equal(record.actors[id].state, 'satisfied');
  }
  await g.close();
});

test('contract T3 one-shot: no reactivation, restock is not eaten', async () => {
  const g = game(0, 'one-shot');
  await g.runUntilIdle();
  g.worldAdvanceTime(3);
  await g.runUntilIdle();
  g.worldAdvanceTime(1);
  await g.runUntilIdle();
  assert.ok(g.worldRestock('kitchen', 4).ok);
  await g.runUntilIdle();
  assert.deepEqual(view(g), { simTime: 4, a: 30, b: 30, c: 30, food: 4, calls: 0 });
  await g.close();
});

test('contract: in-flight time input is accepted and decays the authoritative world', async () => {
  const g = game(4, 'recurring');
  await g.runUntilIdle();
  g.worldAdvanceTime(3); // 40, reactivation pending
  const pending = g.runUntilIdle();
  const mid = g.worldAdvanceTime(1); // must not say "busy"
  assert.equal(mid.ok, true);
  await pending;
  const after = g.snapshot();
  assert.equal(after.finalState.simTime, 4);
  // Success is judged on the authoritative hunger after the in-flight decay.
  for (const id of g.actorIds) {
    assert.equal(after.actors[id].goalReached, after.finalState.npcs[id].hunger >= 70);
  }
  await g.close();
});

test('contract: budgets — session 5, actor 10 for the whole episode, no resets', async () => {
  const g = game(0, 'recurring');
  await g.runUntilIdle();
  for (let i = 0; i < 14; i++) {
    g.worldAdvanceTime(4);
    g.worldRestock('kitchen', 4);
    await g.runUntilIdle();
    if (g.actorIds.every(id => g.snapshot().actors[id].providerCalls >= 10)) break;
  }
  const record = g.snapshot();
  for (const id of g.actorIds) {
    assert.ok(record.actors[id].providerCalls <= 10, `${id}: episode budget exceeded`);
    for (const cycle of record.cycles[id]) {
      assert.ok(cycle.providerCalls <= 5, `${id} cycle ${cycle.cycle}: session budget exceeded`);
    }
  }
  assert.ok(record.actors.npc_a.providerCalls >= 8, 'the loop must really drive cycles');
  await g.close();
});
