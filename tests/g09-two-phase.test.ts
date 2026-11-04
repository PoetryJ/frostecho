/**
 * G09 worker B tests — the two-phase session (goal choice → action) inside
 * ONE session and ONE budget.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld } from '../src';
import type { WorldState } from '../src/types';
import { createAgentSession, goalProtocolIssues, hydrateAgentSession, stepAgent } from '../src/agent/runner';
import type { DecideInput, GoalProtocolOptions, StepRecord } from '../src/agent/contracts';
import { exportSessionCheckpoint, restoreAgentSession } from '../src/agent/checkpoint';
import type { Result } from '../src/persistence/contracts';
import { G09_REQUEST_TEXT, G09_SESSION_SCHEMA, goalChoiceLine } from '../src/negotiation/contracts';
import { observe } from '../src/agent/observation';
import { countingWorld, scripted } from './agent-helpers';

const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${(r.issues ?? []).join('; ')}`);
  return r.value;
};

function g09World(satiety: number, food = 1): { eng: Engine; state: WorldState } {
  const state = initialWorld();
  state.simTime = 0;
  state.npcs.npc_a = { id: 'npc_a', location: 'kitchen', hunger: satiety };
  state.npcs.npc_b = { id: 'npc_b', location: 'kitchen', hunger: 20 };
  state.food = { dorm: 0, kitchen: food };
  return { eng: new Engine(structuredClone(state)), state };
}

function protocol(overrides: Partial<GoalProtocolOptions> = {}): GoalProtocolOptions {
  return {
    arm: 'choice',
    requestId: 'req-1',
    text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'],
    deadlineAfterRound: 1,
    playerId: 'npc_b',
    ...overrides,
  };
}

function session(eng: Engine, provider: ReturnType<typeof scripted>['provider'], overrides: Partial<GoalProtocolOptions> = {}) {
  return createAgentSession({
    world: countingWorld(eng),
    provider,
    actorId: 'npc_a',
    runId: 'g09-r1-s40-choice:npc_a:c1',
    actionSet: 'legacy',
    goalProtocol: protocol(overrides),
  });
}

test('the goal phase costs one call, submits nothing, and flips the phase', async () => {
  const { eng } = g09World(40);
  const seen: DecideInput[] = [];
  const script = scripted(['{"goal":"yield_once"}', '{"type":"eat"}'], seen);
  const world = countingWorld(eng);
  const s = createAgentSession({
    world, provider: script.provider, actorId: 'npc_a',
    runId: 'g09-r1-s40-choice:npc_a:c1', actionSet: 'legacy', goalProtocol: protocol(),
  });
  assert.equal(s.phase, 'goal_choice');
  const first = await stepAgent(s);
  assert.equal(first.status, 'ready');
  assert.equal(first.terminal, false);
  assert.equal(first.providerCalled, true);
  assert.equal(world.submits(), 0, 'the goal phase must not touch the world');
  assert.equal(s.phase, 'action');
  assert.equal(s.goalBinding?.goal, 'yield_once');
  assert.equal(s.goalBinding?.requestId, 'req-1');
  assert.equal(first.step?.goal?.parseOk, true);
  assert.equal(first.step?.goal?.goal, 'yield_once');
  // The frozen prompt was used, with the authoritative player satiety.
  assert.ok(seen[0]?.goalChoice !== undefined);
  assert.equal(seen[0]?.goalChoice?.arm, 'choice');
  assert.equal(seen[0]?.goalChoice?.playerSatiety, 20);
  assert.equal(seen[0]?.goalChoice?.simTime, 0);

  const second = await stepAgent(s);
  assert.equal(second.providerCalled, true);
  assert.equal(world.submits(), 1, 'the action phase submits one command');
  assert.equal(eng.getState().food.kitchen, 0, 'the action really changed the world');
  // The action prompt carries the frozen binding line, not the goal prompt.
  assert.equal(seen[1]?.goalLine, goalChoiceLine({ goal: 'yield_once', requestId: 'req-1' }));
  assert.equal(seen[1]?.goalChoice, undefined);
});

test('the protocol needs two calls: a one-call-remaining session stops before spending', async () => {
  const { eng } = g09World(40);
  const script = scripted(['{"goal":"feed_self"}'], []);
  const s = session(eng, script.provider);
  const steps: StepRecord[] = [1, 2, 3, 4].map(round => ({
    round, observation: observe(eng.getState(), 'npc_a'), raw: '{"type":"stop"}', parse: { ok: true, action: { type: 'stop' } },
  }));
  hydrateAgentSession(s, {
    round: 4, feedback: null, status: 'ready', providerCalls: 4, steps,
    terminalOutcome: null, initialState: eng.getState(), eventsBefore: 0, started: Date.now(), calls: [],
  });
  const result = await stepAgent(s);
  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.providerCalled, false);
  assert.equal(script.calls(), 0, 'a protocol that cannot finish must not spend a call');
  assert.equal(s.phase, 'goal_choice');
});

test('an invalid goal answer terminates the session without a retry', async () => {
  const { eng } = g09World(40);
  const seen: DecideInput[] = [];
  const script = scripted(['{"type":"eat"}', '{"goal":"feed_self"}'], seen);
  const world = countingWorld(eng);
  const s = createAgentSession({
    world, provider: script.provider, actorId: 'npc_a',
    runId: 'g09-r1-s40-choice:npc_a:c1', actionSet: 'legacy', goalProtocol: protocol(),
  });
  const result = await stepAgent(s);
  assert.equal(result.status, 'invalid_run');
  assert.equal(result.terminal, true);
  assert.equal(result.providerCalled, true);
  assert.equal(script.calls(), 1, 'no second chance in a two-phase budget');
  assert.equal(world.submits(), 0);
  assert.equal(s.goalBinding, null);
  assert.equal(result.step?.goal?.parseOk, false);
});

test('the self_only arm may not be answered with yield_once or offer it', async () => {
  const { eng } = g09World(40);
  const script = scripted(['{"goal":"yield_once"}'], []);
  const s = session(eng, script.provider, { arm: 'self_only', requestId: null, options: ['feed_self'], text: '本轮没有让食请求。' });
  const result = await stepAgent(s);
  assert.equal(result.status, 'invalid_run');
  assert.equal(s.goalBinding, null);

  // A protocol that offers yield in the self_only arm is refused at creation.
  const bad = createAgentSession({
    world: countingWorld(g09World(40).eng), provider: scripted(['{"goal":"feed_self"}']).provider,
    actorId: 'npc_a', runId: 'e:npc_a:c1', actionSet: 'legacy',
    goalProtocol: protocol({ arm: 'self_only', requestId: null, options: ['feed_self', 'yield_once'] }),
  });
  assert.equal(bad.status, 'invalid_run');
  assert.equal(bad.phase, 'goal_choice');

  // The structural rules themselves:
  assert.ok(goalProtocolIssues(protocol()).length === 0);
  assert.ok(goalProtocolIssues(protocol({ arm: 'self_only' })).length > 0);
  assert.ok(goalProtocolIssues(protocol({ requestId: null })).length > 0);
  assert.ok(goalProtocolIssues(protocol({ deadlineAfterRound: 0 })).length > 0);
});

test('a restored session keeps its binding and never chooses again', async () => {
  const { eng } = g09World(40);
  const first = scripted(['{"goal":"yield_once"}', '{"type":"stop"}'], []);
  const world = countingWorld(eng);
  const s = createAgentSession({
    world, provider: first.provider, actorId: 'npc_a',
    runId: 'g09-r1-s40-choice:npc_a:c1', actionSet: 'legacy', goalProtocol: protocol(),
  });
  await stepAgent(s);
  const saved = unwrap(exportSessionCheckpoint(s, 'g09'));
  assert.equal((saved as { schema: string }).schema, G09_SESSION_SCHEMA);
  const savedTyped = saved as unknown as { goalProtocol: GoalProtocolOptions; goalBinding: { goal: string } | null };
  assert.equal(savedTyped.goalBinding?.goal, 'yield_once');

  const seen: DecideInput[] = [];
  const second = scripted(['{"type":"eat"}'], seen);
  const restored = unwrap(restoreAgentSession(structuredClone(saved), {
    world: countingWorld(new Engine(structuredClone(eng.getState()))),
    provider: second.provider,
    commandIdFor: round => `g09-r1-s40-choice:npc_a:c1:${round}`,
  }));
  assert.equal(second.calls(), 0, 'restore spends nothing');
  assert.equal(restored.phase, 'action');
  assert.equal(restored.goalBinding?.goal, 'yield_once');
  const result = await stepAgent(restored);
  assert.equal(result.providerCalled, true);
  assert.equal(second.calls(), 1);
  assert.equal(seen[0]?.goalChoice, undefined, 'the restored session asks no goal');
  assert.equal(seen[0]?.goalLine, goalChoiceLine({ goal: 'yield_once', requestId: 'req-1' }));
});

test('the g09 checkpoint refuses a tampered binding', () => {
  const { eng } = g09World(40);
  const s = session(eng, scripted(['{"goal":"feed_self"}']).provider);
  const saved = unwrap(exportSessionCheckpoint(s, 'g09')) as unknown as Record<string, unknown>;
  const runtime = {
    world: countingWorld(eng), provider: scripted(['{"type":"stop"}']).provider,
    commandIdFor: (round: number) => `g09-r1-s40-choice:npc_a:c1:${round}`,
  };
  // No binding yet: a valid checkpoint restores as goal_choice.
  const pending = unwrap(restoreAgentSession(structuredClone(saved), runtime));
  assert.equal(pending.phase, 'goal_choice');

  // A binding whose raw does not parse to the recorded goal is refused.
  const tampered = {
    ...saved,
    goalBinding: {
      schema: 'frostecho.g09.goal-binding/1', episodeId: 'g09-r1-s40-choice', requestId: 'req-1',
      goal: 'yield_once', decidedRound: 1, decidedAtSimTime: 0, raw: '{"goal":"feed_self"}',
    },
  };
  const bad = restoreAgentSession(structuredClone(tampered), runtime);
  assert.equal(bad.ok, false);
  // A binding that names another request is refused too.
  const mismatched = { ...tampered, goalBinding: { ...(tampered.goalBinding as object), requestId: 'other', raw: '{"goal":"yield_once"}' } };
  assert.equal(restoreAgentSession(structuredClone(mismatched), runtime).ok, false);
  // A binding decided past the deadline is refused.
  const late = { ...tampered, goalBinding: { ...(tampered.goalBinding as object), decidedRound: 2, raw: '{"goal":"yield_once"}' } };
  assert.equal(restoreAgentSession(structuredClone(late), runtime).ok, false);
});
