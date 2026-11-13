/**
 * G10 P0 regressions — one authoritative label, one real timeout request body.
 *
 * P0-1: a bound yield promise is labelled by the request outcome; hunger can
 * never upgrade a violation or an error to goal_reached.
 * P0-2: a short local timeout still records the ONE request body that was
 * really sent; a missing response stays null; production timeout is unchanged.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { createHttpProvider } from '../src/agent/providers/http';
import { createWireCollector } from '../scripts/g09-eval-lib';
import { G09_REQUEST_TEXT, G09_TIMEOUT_MS } from '../src/negotiation/contracts';
import { createGoalRequest } from '../src/negotiation/requests';
import { Engine } from '../src/engine';
import { createAgentSession, stepAgent } from '../src/agent/runner';

type NeedsGame = ReturnType<typeof createNeedsGame>;

function gameWith(answer: (input: { goalChoice?: unknown }) => string, food = 1, hungerA = 40): NeedsGame {
  const game = createNeedsGame({
    episodeId: 'p0',
    initialState: buildNeedsWorld({ actorIds: ['npc_a', 'npc_c'], kitchenFood: food, hunger: { npc_a: hungerA, npc_b: 40, npc_c: 70 } }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({ decide: (input) => Promise.resolve(answer(input)) }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: G09_TIMEOUT_MS,
    actionSet: 'timed_wait', goalMode: 'negotiated', candidateSet: 'choice', playerId: 'npc_b',
  });
  const built = createGoalRequest({
    requestId: 'p0-req-1', episodeId: 'p0', to: 'npc_a', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
  });
  assert.ok(built.ok);
  const controller = game as unknown as { submitGoalRequest(r: unknown): { ok: boolean } };
  assert.equal(controller.submitGoalRequest(built.value).ok, true);
  return game;
}

function worldState(food: number) {
  return buildNeedsWorld({ actorIds: ['npc_a', 'npc_c'], kitchenFood: food, hunger: { npc_a: 40, npc_b: 40, npc_c: 70 } });
}

function session(game: NeedsGame) {
  return game.sessionsOf().find(entry => entry.actorId === 'npc_a')!.session;
}

test('P0-1a: yield violated at hunger 70 is never labelled goal_reached', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"eat"}' : '{"goal":"yield_once"}'), 2);
  await game.advance();
  await game.advance();
  const result = session(game).result();
  assert.equal(game.world.getState().npcs.npc_a?.hunger, 70, 'the NPC really is full');
  assert.equal(result.hungerNeedSatisfied, true);
  assert.equal(result.selectedGoalReached, false);
  assert.equal(result.goalReached, false);
  assert.equal(result.outcome, 'selected_goal_yield');
  assert.notEqual(result.outcome, 'goal_reached');
});

test('P0-1b: yield fulfilled at hunger 40 keeps the two axes separate', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"stop"}' : '{"goal":"yield_once"}'));
  await game.advance();
  await game.advance();
  game.playerLine('player eat');
  const result = session(game).result();
  assert.equal(result.outcome, 'goal_reached');
  assert.equal(result.selectedGoalReached, true);
  assert.equal(result.goalReached, true);
  assert.equal(result.hungerNeedSatisfied, false);
});

test('P0-1c: feed_self still follows the hunger rule', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"eat"}' : '{"goal":"feed_self"}'));
  await game.advance();
  await game.advance();
  const result = session(game).result();
  assert.equal(result.outcome, 'goal_reached');
  assert.equal(result.selectedGoalReached, false);
  assert.equal(result.hungerNeedSatisfied, true);
});

test('P0-1d: an invalid run stays invalid even after the hunger reaches 70', async () => {
  // Session-level: the label must not be recomputed from a later hunger.
  const engine = new Engine(worldState(2));
  const s = createAgentSession({
    world: engine, provider: { decide: async () => '{"goal":"not_a_goal"}' },
    actorId: 'npc_a', runId: 'p0:npc_a:c1', actionSet: 'timed_wait',
    goalProtocol: {
      arm: 'choice', requestId: 'p0-req-1', text: G09_REQUEST_TEXT,
      options: ['feed_self', 'yield_once'], expiresAtSimTime: 1, playerId: 'npc_b',
    },
  });
  await stepAgent(s);
  assert.equal(s.status, 'invalid_run');
  const eat = engine.submit({ commandId: 'p0-eat', actorId: 'npc_a', type: 'eat', payload: {} });
  assert.equal(eat.status, 'accepted', 'the hunger axis really moves to 70');
  const result = s.result();
  assert.equal(result.outcome, 'invalid_run');
  assert.equal(result.goalReached, false);
  assert.equal(result.hungerNeedSatisfied, true);
});

test('P0-2: an 80ms no-header timeout keeps exactly one real request body and a null response', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', () => {
      seen.push(raw);
      void res; // intentionally no headers, no body
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const collector = createWireCollector(fetch);
    const provider = createHttpProvider({
      url: `http://127.0.0.1:${port}/v1/chat/completions`, model: 'loopback-only', fetchImpl: collector.fetchImpl,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80);
    let message = '';
    try {
      await provider.decide({
        observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: ['dorm', 'kitchen'] },
        goal: { hungerAtLeast: 70 }, feedback: null, allowedActions: 'timed_wait',
      }, controller.signal);
      assert.fail('the 80ms timeout must reject');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    assert.match(message, /timeout|abort/i);
    assert.equal(seen.length, 1, 'exactly one POST reached the server');
    const capture = collector.take();
    assert.ok(capture, 'the request is captured before the response');
    assert.equal(capture.status, null);
    assert.equal(capture.responseBody, null, 'an absent response is null, never invented');
    assert.deepEqual(capture.requestBody, JSON.parse(seen[0]!), 'the captured body equals the server wire');
    const transport = provider.consumeTransport?.();
    assert.equal(transport?.status, null);
    assert.equal(transport?.usage, null);
    assert.deepEqual(transport?.requestBody, capture.requestBody, 'the transport record names the real body');
    assert.equal(G09_TIMEOUT_MS, 120_000, 'the production timeout stays 120s');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
