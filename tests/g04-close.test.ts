/**
 * G04-R1-CLOSE regression: closing must synchronously reject new work, then
 * wait only for the already-started request.
 *
 * Old defect (reviewer-probed): `closed` was set only after `busy` drained, so
 * while one request was in flight a close still let the scheduler start the
 * next actor's request and let world restock mutate the game.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Provider } from '../src/agent/contracts';
import { createReactiveGame } from '../src/reactive/game';
import { initialState } from '../src/reactive/scenarios';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

const makeGame = (decide: Provider['decide']) => createReactiveGame({
  episodeId: 'close-regression',
  initialState: initialState(),
  actorIds: ['npc_a', 'npc_c'],
  providerFor: () => ({ decide }),
  mode: 'fixture',
  thinking: true,
  wakePolicy: 'event',
  timeoutMs: 2_000,
});

test('close during an in-flight request blocks new requests and world input', async () => {
  const first = deferred();
  const calls: string[] = [];
  const game = makeGame(async input => {
    calls.push(input.observation.id);
    if (calls.length === 1) await first.promise;
    return '{"type":"stop"}';
  });

  const running = game.runUntilIdle();
  assert.equal(calls.length, 1, 'npc_a request is in flight');

  const closing = game.close();
  // The closed flag latches synchronously, before any await.
  assert.equal(game.isClosed(), true);

  // Entrypoints reject from the close tick on.
  const restock = game.worldRestock('kitchen', 1);
  assert.equal(restock.ok, false);
  assert.equal(restock.error, 'game is closed');
  const player = game.playerLine('player eat');
  assert.equal(player.ok, false);

  // Release the in-flight request; the scheduler must not start npc_c.
  first.resolve();
  await running;
  await closing;
  assert.deepEqual(calls, ['npc_a']);
  // Initial kitchen is empty, so event policy classifies the stop as waiting.
  assert.equal(game.actorStateOf('npc_a'), 'waiting');

  // Repeated close is idempotent and adds no request.
  await game.close();
  await game.close();
  assert.deepEqual(calls, ['npc_a']);

  // advance after close refuses without touching a provider.
  assert.equal((await game.advance()).kind, 'closed');
  assert.deepEqual(calls, ['npc_a']);
});

test('close waits for the in-flight step to finish its bookkeeping', async () => {
  const gate = deferred();
  const game = makeGame(async () => {
    await gate.promise;
    return '{"type":"stop"}';
  });
  const step = game.advance();
  const closing = game.close();
  assert.equal(game.isClosed(), true);
  const during = game.worldRestock('kitchen', 1);
  assert.equal(during.ok, false);
  gate.resolve();
  const outcome = await step;
  await closing;
  assert.equal(outcome.kind, 'stepped');

  // The in-flight turn is fully recorded before close resolves.
  const snapshot = game.snapshot();
  assert.equal(snapshot.stopReason, 'user_closed');
  const turns = snapshot.cycles['npc_a'].flatMap(cycle => cycle.turns);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].providerCalled, true);
  assert.equal(turns[0].status, 'stopped');
  assert.equal(snapshot.actors['npc_a'].providerCalls, 1);
  // The rejected restock never mutated the world.
  assert.equal(snapshot.finalState.food.kitchen, snapshot.initialState.food.kitchen);
});
