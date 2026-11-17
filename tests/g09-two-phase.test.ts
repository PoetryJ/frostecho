/**
 * G09-R1 worker B tests — the two-phase session against the corrected
 * contract: logical-time receive points, insufficient budget without spend,
 * the selected-yield goal, and one request consumed per game.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/engine';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { createAgentSession, hydrateAgentSession, stepAgent } from '../src/agent/runner';
import { observe } from '../src/agent/observation';
import { MAX_PROVIDER_CALLS, type AgentSession, type GoalProtocolOptions } from '../src/agent/contracts';
import { G09_REQUEST_TEXT } from '../src/negotiation/contracts';
import { createGoalRequest } from '../src/negotiation/requests';

function world(satiety = 40) {
  return buildNeedsWorld({ actorIds: ['npc_a'], kitchenFood: 1, hunger: { npc_a: satiety, npc_b: 40, npc_c: 70 } });
}

function countingWorld(engine: Engine) {
  let submits = 0;
  return {
    submits: () => submits,
    getState: () => engine.getState(),
    getEvents: () => engine.getEvents(),
    submit: (command: unknown) => { submits += 1; return engine.submit(command); },
    logLength: () => engine.logLength(),
  };
}

function scripted(lines: string[]) {
  let index = 0;
  const seen: string[] = [];
  const provider = {
    async decide(input: { goalChoice?: unknown }) {
      const line = lines[Math.min(index, lines.length - 1)]!;
      index += 1;
      seen.push(input.goalChoice === undefined ? 'action' : 'goal');
      return line;
    },
  };
  return { provider, seen, calls: () => index };
}

function advance(engine: Engine): void {
  engine.submit({ commandId: 'world:1', actorId: 'world', type: 'advance_time', payload: { steps: 1 } });
}

function outcomeOf(session: AgentSession): string | null {
  return (session as unknown as { terminalOutcome: string | null }).terminalOutcome;
}

function protocol(overrides: Partial<GoalProtocolOptions> = {}): GoalProtocolOptions {
  return {
    arm: 'choice', requestId: 'req-1', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], expiresAtSimTime: 1, playerId: 'npc_b', ...overrides,
  };
}

test('goal then action in ONE session, each counted, action submits', async () => {
  const engine = new Engine(world());
  const worldPort = countingWorld(engine);
  const script = scripted(['{"goal":"yield_once"}', '{"type":"eat"}']);
  const session = createAgentSession({
    world: worldPort as never, provider: script.provider as never, actorId: 'npc_a',
    runId: 'ep:npc_a:c1', actionSet: 'timed_wait', goalProtocol: protocol(),
  });
  assert.equal(session.phase, 'goal_choice');
  const goal = await stepAgent(session);
  assert.equal(goal.providerCalled, true);
  assert.equal(goal.step?.goal?.goal, 'yield_once');
  assert.equal(worldPort.submits(), 0, 'the goal decision is not a world command');
  assert.equal(session.phase, 'action');
  assert.equal(session.goalBinding?.expiresAtSimTime, 1);
  const action = await stepAgent(session);
  assert.equal(action.providerCalled, true);
  assert.equal(script.calls(), 2);
  assert.equal(worldPort.submits(), 1);
  assert.equal(engine.getState().food?.kitchen, 0);
  assert.equal(outcomeOf(session), 'selected_goal_yield');
});

test('a late goal answer is discarded: no binding, no submit, the call stays spent', async () => {
  const engine = new Engine(world());
  const worldPort = countingWorld(engine);
  const script = scripted(['{"goal":"yield_once"}']);
  const session = createAgentSession({
    world: worldPort as never, provider: script.provider as never, actorId: 'npc_a',
    runId: 'ep:npc_a:c1', actionSet: 'timed_wait', goalProtocol: protocol(),
  });
  // Time moves past the expiry while the request is in flight.
  advance(engine);
  const goal = await stepAgent(session);
  assert.equal(goal.providerCalled, true);
  assert.equal(session.goalBinding, null, 'no active binding after the expiry');
  assert.equal(session.status, 'failed');
  assert.equal(outcomeOf(session), 'request_expired');
  assert.equal(worldPort.submits(), 0);
  assert.equal(worldPort.getState().food?.kitchen, 1, 'the world must not move');
});

test('a late yield action is discarded: no submit, no wait deadline', async () => {
  const engine = new Engine(world());
  const worldPort = countingWorld(engine);
  const script = scripted(['{"goal":"yield_once"}', '{"type":"wait"}']);
  const session = createAgentSession({
    world: worldPort as never, provider: script.provider as never, actorId: 'npc_a',
    runId: 'ep:npc_a:c1', actionSet: 'timed_wait', goalProtocol: protocol(),
  });
  await stepAgent(session);
  advance(engine); // the request expires before the action answer lands
  const action = await stepAgent(session);
  assert.equal(action.providerCalled, true);
  assert.equal(worldPort.submits(), 0, 'a late action submits nothing');
  assert.equal(session.status, 'failed');
  assert.equal(outcomeOf(session), 'request_expired');
  assert.equal((session as unknown as { wakeAtSimTime: number | null }).wakeAtSimTime, null, 'no new wait deadline');
});

test('insufficient budget spends nothing and leaves the remaining call intact', async () => {
  const engine = new Engine(world());
  const worldPort = countingWorld(engine);
  const script = scripted(['{"goal":"feed_self"}', '{"type":"eat"}']);
  const session = createAgentSession({
    world: worldPort as never, provider: script.provider as never, actorId: 'npc_a',
    runId: 'ep:npc_a:c1', actionSet: 'timed_wait', goalProtocol: protocol(),
  });
  // Four calls already spent: one remains, the protocol needs two.
  hydrateAgentSession(session, {
    round: MAX_PROVIDER_CALLS - 1, feedback: null, status: 'ready',
    providerCalls: MAX_PROVIDER_CALLS - 1, steps: [], terminalOutcome: null,
    initialState: engine.getState(), eventsBefore: 0, started: Date.now(), calls: [],
  } as never);
  const result = await stepAgent(session);
  assert.equal(result.providerCalled, false);
  assert.equal(result.status, 'stopped');
  assert.equal(outcomeOf(session), 'insufficient_budget');
  assert.equal(session.providerCalls, MAX_PROVIDER_CALLS - 1, 'the remaining call is NOT consumed');
  assert.equal(script.calls(), 0);
});

test('a new recurring cycle never re-asks the processed request', async () => {
  const state = world(40);
  const seen: string[] = [];
  let index = 0;
  const game = createNeedsGame({
    episodeId: 'ep',
    initialState: state,
    actorIds: ['npc_a'],
    providerFor: () => ({
      async decide(input: { goalChoice?: unknown }) {
        const isGoal = input.goalChoice !== undefined;
        seen.push(isGoal ? 'goal' : 'action');
        index += 1;
        return isGoal ? '{"goal":"feed_self"}' : '{"type":"eat"}';
      },
    }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: 1000,
    actionSet: 'timed_wait', goalMode: 'negotiated', candidateSet: 'choice', playerId: 'npc_b',
  });
  const built = createGoalRequest({
    requestId: 'req-1', episodeId: 'ep', to: 'npc_a', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
  });
  assert.ok(built.ok);
  assert.equal((game as unknown as { submitGoalRequest(r: unknown): { ok: boolean } }).submitGoalRequest(built.value).ok, true);
  await game.advance(); // goal
  await game.advance(); // action
  assert.deepEqual(seen, ['goal', 'action']);
  const store = (game as unknown as { goalRequests(): { processed: string[] } }).goalRequests();
  assert.deepEqual(store.processed, ['req-1']);
  // Further cycles get no protocol for the same request.
  await game.advance();
  const sessions = game.sessionsOf();
  assert.ok(sessions.every(entry => entry.session.goalProtocol === null || entry.session.goalDecision !== null));
  assert.equal(seen.filter(kind => kind === 'goal').length, 1, 'the request is asked exactly once');
  void index;
});

test('the goal step observation is the frozen local one', async () => {
  const engine = new Engine(world(60));
  const script = scripted(['{"goal":"feed_self"}']);
  const session = createAgentSession({
    world: countingWorld(engine) as never, provider: script.provider as never, actorId: 'npc_a',
    runId: 'ep:npc_a:c1', actionSet: 'timed_wait',
    goalProtocol: protocol({ arm: 'self_only', options: ['feed_self'] }),
  });
  const goal = await stepAgent(session);
  assert.deepEqual(goal.step?.observation, observe(engine.getState(), 'npc_a'));
  assert.equal(session.goalDecision?.goal, 'feed_self');
  assert.equal(session.goalBinding, null, 'a control choice binds no yield promise');
  void (session as AgentSession);
});
