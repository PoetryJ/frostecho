import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld } from '../src';
import {
  createAgentSession, createReferenceProvider, deterministicRecord, runAgent, stepAgent,
} from '../src/agent';
import { scripted } from './agent-helpers';

test('stepAgent is the same execution path as runAgent', async () => {
  const lines = ['not json', '{"type":"fly"}', '{"type":"move","to":"kitchen"}', '{"type":"eat"}'];
  const viaRun = await runAgent({
    world: new Engine(initialWorld()),
    provider: scripted(lines).provider,
    actorId: 'npc_a',
    runId: 'same-path',
    now: () => 0,
  });
  const session = createAgentSession({
    world: new Engine(initialWorld()),
    provider: scripted(lines).provider,
    actorId: 'npc_a',
    runId: 'same-path',
    now: () => 0,
  });
  assert.equal(session.round, 0);
  assert.equal(session.feedback, null);
  assert.equal(session.status, 'ready');
  while (session.status === 'ready') {
    const step = await stepAgent(session);
    assert.notEqual(step.status, 'busy');
    assert.equal(step.providerCalled, step.step !== undefined);
  }
  assert.deepEqual(deterministicRecord(session.result()), deterministicRecord(viaRun));
  assert.equal(session.result().goalReached, true);
  assert.equal(session.providerCalls, 4);
  assert.equal(session.steps[2].command?.commandId, 'same-path:3');
  assert.equal(session.steps[3].command?.commandId, 'same-path:4');
});

test('each step makes at most one call and the session stops at five', async () => {
  const script = scripted(Array.from({ length: 8 }, () => 'nope'));
  const session = createAgentSession({
    world: new Engine(initialWorld()),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'budget-session',
    now: () => 0,
  });
  for (let i = 0; i < 5; i++) {
    const step = await stepAgent(session);
    assert.equal(step.providerCalled, true);
    assert.equal(session.providerCalls, i + 1);
  }
  assert.equal(session.status, 'budget_exhausted');
  const extra = await stepAgent(session);
  assert.equal(extra.providerCalled, false);
  assert.equal(extra.status, 'budget_exhausted');
  assert.equal(script.calls(), 5);
  assert.equal(session.result().error, 'provider call budget exhausted');
  assert.equal(session.result().goalReached, false);
});

test('a second step while deciding is busy and does not call the provider', async () => {
  let calls = 0;
  let release: (value: string) => void = () => {};
  const session = createAgentSession({
    world: new Engine(initialWorld()),
    actorId: 'npc_a',
    runId: 'busy-session',
    now: () => 0,
    provider: {
      decide() {
        calls += 1;
        return new Promise(resolve => { release = resolve; });
      },
    },
  });
  const first = stepAgent(session);
  assert.equal(session.status, 'deciding');
  assert.equal(session.round, 1);
  assert.equal(calls, 1);
  const second = await stepAgent(session);
  assert.equal(second.status, 'busy');
  assert.equal(second.providerCalled, false);
  assert.equal(calls, 1);
  release('{"type":"stop"}');
  const done = await first;
  assert.equal(done.status, 'stopped');
  assert.equal(done.providerCalled, true);
  assert.equal(calls, 1);
  assert.equal(session.result().goalReached, false);
});

test('a player command during the wait is what Engine.submit sees', async () => {
  const world = new Engine(initialWorld());
  world.submit({ commandId: 'setup', actorId: 'npc_a', type: 'move', payload: { to: 'kitchen' } });
  let release: (value: string) => void = () => {};
  let observedFood = -1;
  const session = createAgentSession({
    world,
    actorId: 'npc_a',
    runId: 'stale-session',
    now: () => 0,
    provider: {
      decide(input) {
        observedFood = input.observation.foodHere;
        return new Promise(resolve => { release = resolve; });
      },
    },
  });
  const pending = stepAgent(session);
  assert.equal(session.status, 'deciding');
  assert.equal(observedFood, 1);
  world.submit({ commandId: 'b-move', actorId: 'npc_b', type: 'move', payload: { to: 'kitchen' } });
  const eaten = world.submit({ commandId: 'b-eat', actorId: 'npc_b', type: 'eat', payload: {} });
  assert.equal(eaten.status, 'accepted');
  release('{"type":"eat"}');
  const step = await pending;
  assert.equal(step.step?.observation.foodHere, 1);
  assert.equal(step.step?.command?.actorId, 'npc_a');
  assert.equal(step.step?.exec?.status, 'rejected');
  assert.equal(step.step?.exec?.reason, 'NO_FOOD');
  assert.equal(world.getState().npcs.npc_a.hunger, 40);
  assert.equal(world.getState().food.kitchen, 0);
  assert.equal(session.feedback?.reason, 'NO_FOOD');
});

test('timeout drops a late eat and submits nothing', async () => {
  const world = new Engine(initialWorld());
  let fire: () => void = () => {};
  let late = false;
  const session = createAgentSession({
    world,
    actorId: 'npc_a',
    runId: 'late-session',
    timeoutMs: 15000,
    now: () => 0,
    scheduleTimeout(fn) {
      fire = fn;
      return { cancel() {} };
    },
    provider: {
      decide(_input, signal) {
        return new Promise(resolve => {
          signal.addEventListener('abort', () => {
            late = true;
            resolve('{"type":"eat"}');
          });
        });
      },
    },
  });
  const pending = stepAgent(session);
  assert.equal(session.status, 'deciding');
  assert.equal(late, false);
  fire();
  const step = await pending;
  assert.equal(late, true);
  assert.equal(step.status, 'timeout');
  assert.equal(step.step?.command, undefined);
  assert.equal(step.step?.raw, '');
  assert.equal(world.getEvents().length, 0);
  assert.equal(world.getState().npcs.npc_a.hunger, 40);
  assert.equal(world.getState().npcs.npc_a.location, 'dorm');
  assert.equal(session.result().goalReached, false);
  assert.equal(session.result().outcome, 'timeout');
});

test('reference session still reaches the goal without a player', async () => {
  const session = createAgentSession({
    world: new Engine(initialWorld()),
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'ref-session',
    now: () => 0,
  });
  while (session.status === 'ready') await stepAgent(session);
  assert.equal(session.result().goalReached, true);
  assert.equal(session.result().finalState.npcs.npc_a.hunger, 70);
  assert.equal(session.providerCalls, 2);
});
