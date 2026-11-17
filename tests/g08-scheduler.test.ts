/**
 * G08 worker B — logical-time wake scheduler tests.
 *
 * Covers the frozen contracts in src/temporal/contracts.ts on the reactive
 * side: a paused (timed_wait) actor is skipped by round-robin, both NPCs
 * waiting leaves the game idle without hidden time steps, one time jump
 * resumes each paused session exactly once in the SAME cycle, budgets bind
 * across waits, a closed game never revives a paused actor, and records /
 * status / checkpoint data carry the capability axis and the deadlines.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReactiveGame } from '../src/reactive/game';
import { buildNeedsWorld } from '../src/needs/game';
import { PLAYER_ACTOR_ID } from '../src/reactive/contracts';
import { G08_GAME_SCHEMA, type G08GameCheckpoint } from '../src/temporal/contracts';
import type { Provider } from '../src/agent/contracts';
import type { WorldState } from '../src/types';

function queued(scripts: Record<string, string[]>): (actorId: string) => Provider {
  const cursors: Record<string, number> = {};
  return (actorId: string) => ({
    decide: async () => {
      const list = scripts[actorId] ?? [];
      const index = cursors[actorId] ?? 0;
      cursors[actorId] = index + 1;
      return list[Math.min(index, list.length - 1)] ?? '{"type":"stop"}';
    },
  });
}

function worldWith(hungerA: number, hungerC: number, kitchenFood = 3): WorldState {
  return buildNeedsWorld({ kitchenFood, hunger: { npc_a: hungerA, npc_c: hungerC } });
}

function g08Game(episodeId: string, providerFor: (actorId: string) => Provider, world: WorldState) {
  return createReactiveGame({
    episodeId,
    initialState: world,
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode: 'reference',
    thinking: false,
    wakePolicy: 'event',
    actionSet: 'timed_wait',
  });
}

test('a waiting actor is skipped by round-robin while the other NPC continues', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"wait"}', '{"type":"stop"}'],
    npc_c: ['{"type":"stop"}'],
  });
  const game = g08Game('g08-b-rr', providerFor, worldWith(40, 40));
  const stepA = await game.advance();
  assert.equal(stepA.kind, 'stepped');
  assert.equal((stepA as { actorId: string }).actorId, 'npc_a');
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait');
  assert.equal(game.status().wakeAtSimTime?.npc_a, 1, 'simTime 0 + 1 step');

  const stepC = await game.advance();
  assert.equal((stepC as { actorId: string }).actorId, 'npc_c');
  assert.equal(game.actorStateOf('npc_c'), 'stopped');

  const idle = await game.advance();
  assert.equal(idle.kind, 'idle');
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait', 'no provider call, no wake');

  const jump = game.worldAdvanceTime(1);
  assert.equal(jump.ok, true);
  assert.equal(game.actorStateOf('npc_a'), 'active', 'reconcile resumed at simTime 1');

  const resumed = await game.advance();
  assert.equal((resumed as { actorId: string }).actorId, 'npc_a');
  assert.equal(game.status().actors.npc_a.cycle, 1, 'the SAME cycle continues');
  assert.equal(game.actorStateOf('npc_a'), 'stopped');
});

test('both NPCs waiting leaves the game idle; pumping does not move time', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"wait"}', '{"type":"stop"}'],
    npc_c: ['{"type":"wait"}', '{"type":"stop"}'],
  });
  const game = g08Game('g08-b-both', providerFor, worldWith(40, 40));
  await game.advance(); // npc_a wait
  await game.advance(); // npc_c wait
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait');
  assert.equal(game.actorStateOf('npc_c'), 'timed_wait');
  const before = game.status();
  for (let i = 0; i < 5; i += 1) {
    const outcome = await game.advance();
    assert.equal(outcome.kind, 'idle');
  }
  assert.equal(game.status().simTime, before.simTime, 'idle pumps never advance time');
  assert.equal(game.status().actors.npc_a.providerCalls, 1);
  assert.equal(game.status().actors.npc_c.providerCalls, 1);

  game.worldAdvanceTime(1);
  assert.equal(game.actorStateOf('npc_a'), 'active');
  assert.equal(game.actorStateOf('npc_c'), 'active');
  await game.runUntilIdle(); // both stop on their next decision
  assert.equal(game.actorStateOf('npc_a'), 'stopped');
  assert.equal(game.actorStateOf('npc_c'), 'stopped');
  assert.equal(game.status().actors.npc_a.providerCalls, 2);
});

test('a time jump resumes a paused session exactly once', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"wait"}', '{"type":"stop"}'],
    npc_c: ['{"type":"stop"}'],
  });
  const game = g08Game('g08-b-jump', providerFor, worldWith(40, 40));
  await game.advance(); // npc_a wait -> deadline 1
  await game.advance(); // npc_c stop
  game.worldAdvanceTime(5); // jump far past the deadline
  assert.equal(game.actorStateOf('npc_a'), 'active');
  game.worldAdvanceTime(5); // more time: no second resume, no new cycle
  assert.equal(game.actorStateOf('npc_a'), 'active');
  const wakeTransitions = game.snapshot().transitions.filter(t => t.to === 'active' && t.reason.includes('wait over'));
  assert.equal(wakeTransitions.length, 1);
  const done = await game.runUntilIdle();
  assert.equal(done.kind, 'idle');
  assert.equal(game.status().actors.npc_a.cycle, 1);
  assert.equal(game.status().actors.npc_a.providerCalls, 2);
});

test('the fifth wait in a session and the tenth across cycles end budget_exhausted with no deadline', async () => {
  const providerFor = queued({
    npc_a: [
      // cycle 1: four waits then an empty-kitchen stop becomes `waiting`
      '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}', '{"type":"stop"}',
      // cycle 2 (after the wake): five more waits; the 5th is also the 10th overall
      '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}',
    ],
    npc_c: ['{"type":"stop"}'],
  });
  const world = worldWith(40, 40, 0); // empty kitchen: a stop here parks as waiting
  const game = g08Game('g08-b-budget', providerFor, world);
  // npc_c stops once and leaves the ring; step until npc_a performs each wait.
  const stepUntil = async (expect: 'timed_wait' | 'waiting' | 'budget_exhausted'): Promise<void> => {
    for (let guard = 0; guard < 5 && game.actorStateOf('npc_a') === 'active'; guard += 1) {
      await game.advance();
    }
    assert.equal(game.actorStateOf('npc_a'), expect);
  };
  for (let i = 0; i < 4; i += 1) {
    await stepUntil('timed_wait');
    game.worldAdvanceTime(1); // resume each wait
  }
  await stepUntil('waiting'); // cycle 1 call 5: the empty-kitchen stop
  assert.equal(game.status().actors.npc_a.providerCalls, 5);

  game.worldRestock('kitchen', 3); // wake -> cycle 2 for every parked actor
  assert.equal(game.actorStateOf('npc_a'), 'active');
  assert.equal(game.status().actors.npc_a.cycle, 2);

  for (let i = 0; i < 4; i += 1) {
    await stepUntil('timed_wait'); // npc_a's next wait (npc_c stops with food present)
    game.worldAdvanceTime(1); // resume each wait
  }
  assert.equal(game.actorStateOf('npc_a'), 'active');
  assert.equal(game.status().actors.npc_a.providerCalls, 9);

  await stepUntil('budget_exhausted'); // session call 5 == actor call 10, a wait
  assert.equal(game.status().wakeAtSimTime?.npc_a ?? null, null, 'no recoverable deadline');
  const final = await game.advance();
  assert.equal(final.kind, 'idle');
});

test('a closed game never revives a paused actor', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"wait"}'],
    npc_c: ['{"type":"stop"}'],
  });
  const game = g08Game('g08-b-close', providerFor, worldWith(40, 40));
  await game.advance();
  await game.advance();
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait');
  await game.close();
  assert.equal((await game.advance()).kind, 'closed');
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait', 'closed parks, never wakes');
  const jump = game.worldAdvanceTime(1);
  assert.equal(jump.ok, false);
  assert.equal(game.snapshot().stopReason, 'user_closed');
});

test('records, status and checkpoint data carry the G08 axis and deadlines', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"wait"}'],
    npc_c: ['{"type":"stop"}'],
  });
  const game = g08Game('g08-b-record', providerFor, worldWith(40, 40));
  await game.advance();
  const status = game.status();
  assert.equal(status.actionSet, 'timed_wait');
  assert.equal(status.wakeAtSimTime?.npc_a, 1);
  assert.equal(status.wakeAtSimTime?.npc_c, null);

  const record = game.snapshot();
  assert.equal(record.schema, G08_GAME_SCHEMA);
  assert.equal(record.actionSet, 'timed_wait');
  assert.equal(record.wakeAtSimTime?.npc_a, 1);
  const pause = record.transitions.find(t => t.to === 'timed_wait');
  assert.ok(pause, 'the pause is a recorded transition');

  const data = (game as unknown as { checkpointData(): G08GameCheckpoint }).checkpointData();
  assert.equal(data.schema, G08_GAME_SCHEMA);
  assert.equal(data.actionSet, 'timed_wait');
  assert.equal(data.wakeAtSimTime.npc_a, 1);
  assert.equal(data.wakeAtSimTime.npc_c, null);
  assert.equal(data.states.npc_a, 'timed_wait');
  const savedSession = data.cycles.npc_a.at(-1)?.session as unknown as Record<string, unknown>;
  assert.equal(savedSession.schema, 'frostecho.g08.session/1');
  assert.equal(savedSession.actionSet, 'timed_wait');
  assert.equal(savedSession.wakeAtSimTime, 1);
});

test('a legacy G08 game accepts the axis without wait behaviour and keeps no deadlines', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"wait"}', '{"type":"stop"}'],
    npc_c: ['{"type":"stop"}'],
  });
  const game = createReactiveGame({
    episodeId: 'g08-b-legacy',
    initialState: worldWith(40, 40),
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode: 'reference',
    thinking: false,
    wakePolicy: 'event',
    actionSet: 'legacy',
  });
  const stepped = await game.advance();
  assert.equal((stepped as { actorId: string }).actorId, 'npc_a');
  // The wait object is rejected; the session stays ready for the next round.
  assert.equal(game.actorStateOf('npc_a'), 'active');
  assert.equal(game.status().actionSet, 'legacy');
  assert.equal(game.status().wakeAtSimTime?.npc_a ?? null, null);
  await game.runUntilIdle();
  assert.equal(game.snapshot().actionSet, 'legacy');
});

test('the player cannot wait: player input never pauses sessions', async () => {
  const providerFor = queued({
    npc_a: ['{"type":"stop"}'],
    npc_c: ['{"type":"stop"}'],
  });
  const game = g08Game('g08-b-player', providerFor, worldWith(40, 40));
  const line = game.playerLine('player move dorm');
  assert.equal(line.ok, true);
  assert.equal(game.actorStateOf('npc_a'), 'active');
  assert.equal(game.world.getState().npcs[PLAYER_ACTOR_ID]?.location, 'dorm');
});
