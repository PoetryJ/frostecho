/**
 * G06 worker A — AgentSession checkpoint self-tests.
 *
 * Round-trip fidelity against a continuous branch on the same engine: the next
 * DecideInput, commandId, execution result and final run record are identical
 * (timing aside). Budget boundaries survive restore; deciding sessions refuse
 * SAVE_BUSY; deep copies both ways; corrupt/foreign/mismatched data is
 * rejected with issues and never yields a half-restored session.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../src/engine';
import { createAgentSession, stepAgent } from '../src/agent/runner';
import { exportSessionCheckpoint, parseG06RunId, restoreAgentSession } from '../src/agent/checkpoint';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { MAX_PROVIDER_CALLS, type AgentSession, type DecideInput, type RunResult } from '../src/agent/contracts';
import type { SessionCheckpoint } from '../src/persistence/contracts';
import type { Result } from '../src/persistence/contracts';
import { countingWorld, scripted } from './agent-helpers';
import type { WorldState } from '../src/types';

const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${(r.issues ?? []).join('; ')}`);
  return r.value;
};

const state = (): WorldState => ({
  npcs: {
    npc_a: { id: 'npc_a', location: 'kitchen', hunger: 40 },
    npc_b: { id: 'npc_b', location: 'dorm', hunger: 70 },
    npc_c: { id: 'npc_c', location: 'kitchen', hunger: 40 },
  },
  food: { kitchen: 4, dorm: 0 },
  tick: 0,
});

const g06CommandId = (episodeId: string, actorId: string, cycle: number) => (round: number): string =>
  `${episodeId}:npc:${actorId}:${cycle}:${round}`;

async function driveToHunger(session: AgentSession, hunger: number): Promise<void> {
  while (session.status === 'ready') {
    const engineState = session.result;
    void engineState;
    const world = (session as unknown as { options: { world: { getState: () => WorldState } } }).options.world;
    if (world.getState().npcs[session.actorId].hunger >= hunger) break;
    const step = await stepAgent(session);
    if (step.status === 'busy') break;
  }
}

test('ready session round-trips; next DecideInput/command/result identical to the continuous branch', async () => {
  const engineA = new Engine(state());
  const engineB = new Engine(state());
  const worldA = countingWorld(engineA);
  const worldB = countingWorld(engineB);
  const seenA: DecideInput[] = [];
  const seenB: DecideInput[] = [];
  const mk = (world: ReturnType<typeof countingWorld>, seen: DecideInput[]) => createAgentSession({
    world, provider: scripted(['{"type":"eat"}', '{"type":"stop"}'], seen).provider,
    runId: 'ep1:npc_a:c1', actorId: 'npc_a',
    commandIdFor: g06CommandId('ep1', 'npc_a', 1), commandIdScheme: 'g06-episode-cycle',
  });
  const continuous = mk(worldA, seenA);
  const checkpointed = exportSessionCheckpoint(mk(worldB, seenB));
  assert.equal(checkpointed.ok, true);
  const saved = unwrap(checkpointed);
  const restored = restoreAgentSession(structuredClone(saved), {
    world: worldB, provider: scripted(['{"type":"eat"}', '{"type":"stop"}'], seenB).provider,
    commandIdFor: g06CommandId('ep1', 'npc_a', 1),
  });
  assert.equal(restored.ok, true, restored.ok ? '' : restored.issues?.join('; ') ?? '');
  // Independent engines with the same initial world: the restored branch must
  // behave exactly like the continuous one.
  const stepContinuous = await stepAgent(continuous);
  const stepRestored = await stepAgent(restored.value);
  assert.equal(stepRestored.providerCalled, true);
  assert.deepEqual(stripTiming(stepRestored), stripTiming(stepContinuous));
  assert.deepEqual(seenB[0], seenA[0], 'identical provider input after restore');
  assert.deepEqual((restored.value as AgentSession).steps.map(s => s.command), continuous.steps.map(s => s.command));
  // And the follow-up stop round agrees too.
  const stopContinuous = await stepAgent(continuous);
  const stopRestored = await stepAgent(restored.value);
  assert.equal(stopRestored.status, stopContinuous.status);
  assert.deepEqual(seenB[1], seenA[1]);
});

test('partially completed session restores; final record equals the continuous branch (timing aside)', async () => {
  const engineA = new Engine(state());
  const engineB = new Engine(state());
  const mkSession = (engine: Engine, runId: string): AgentSession => createAgentSession({
    world: countingWorld(engine), provider: createReferenceProvider(),
    runId, actorId: 'npc_a',
    commandIdFor: g06CommandId('ep1', 'npc_a', 1), commandIdScheme: 'g06-episode-cycle',
  });
  const continuous = mkSession(engineA, 'ep1:npc_a:c1');
  await stepAgent(continuous); // eat 40→70
  assert.equal(continuous.status, 'goal_reached');
  const toSave = mkSession(engineB, 'ep1:npc_a:c1');
  await stepAgent(toSave);
  const saved = exportSessionCheckpoint(toSave);
  assert.equal(saved.ok, true);
  const restored = restoreAgentSession(JSON.parse(JSON.stringify(unwrap(saved))), {
    world: countingWorld(engineB), provider: createReferenceProvider(),
    commandIdFor: g06CommandId('ep1', 'npc_a', 1),
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.value.status, 'goal_reached');
  assert.equal(restored.value.providerCalls, 1);
  const a = withoutTiming(continuous.result());
  const b = withoutTiming(restored.value.result());
  assert.deepEqual(b, a);
});

test('stopped and terminal sessions restore without ever calling the provider again', async () => {
  const engine = new Engine(state());
  const script = scripted(['{"type":"eat"}']);
  const session = createAgentSession({
    world: countingWorld(engine), provider: script.provider,
    runId: 'ep1:npc_c:c1', actorId: 'npc_c',
    commandIdFor: g06CommandId('ep1', 'npc_c', 1), commandIdScheme: 'g06-episode-cycle',
  });
  await stepAgent(session);
  assert.equal(session.status, 'goal_reached');
  const saved = exportSessionCheckpoint(session);
  assert.equal(saved.ok, true);
  const callsBefore = script.calls();
  const restored = restoreAgentSession(unwrap(saved), {
    world: countingWorld(engine), provider: script.provider,
    commandIdFor: g06CommandId('ep1', 'npc_c', 1),
  });
  assert.equal(restored.ok, true);
  const step = await stepAgent(restored.value);
  assert.equal(step.providerCalled, false, 'terminal restore must not call the provider');
  assert.equal(script.calls(), callsBefore);
  assert.equal(step.terminal, true);
});

test('budget boundary: restored session keeps its remaining calls and reports budget_exhausted', async () => {
  const engine = new Engine(state());
  // Rejection feedback keeps the session alive without submitting: invalid output.
  const lines = Array.from({ length: MAX_PROVIDER_CALLS + 2 }, () => 'not-json');
  const script = scripted(lines);
  const session = createAgentSession({
    world: countingWorld(engine), provider: script.provider,
    runId: 'ep1:npc_a:c1', actorId: 'npc_a',
    commandIdFor: g06CommandId('ep1', 'npc_a', 1), commandIdScheme: 'g06-episode-cycle',
    timeoutMs: 5000,
  });
  for (let i = 0; i < MAX_PROVIDER_CALLS - 1; i += 1) {
    await stepAgent(session);
    assert.equal(session.status, 'ready');
  }
  const saved = exportSessionCheckpoint(session);
  assert.equal(saved.ok, true);
  assert.equal((saved as { value: SessionCheckpoint }).value.providerCalls, MAX_PROVIDER_CALLS - 1);
  const restored = restoreAgentSession(saved.value, {
    world: countingWorld(engine), provider: script.provider,
    commandIdFor: g06CommandId('ep1', 'npc_a', 1),
  });
  assert.equal(restored.ok, true);
  const last = await stepAgent(restored.value);
  assert.equal(last.providerCalled, true, 'exactly one remaining call');
  assert.equal(restored.value.status, 'budget_exhausted');
  assert.equal(restored.value.providerCalls, MAX_PROVIDER_CALLS);
  const beyond = await stepAgent(restored.value);
  assert.equal(beyond.providerCalled, false);
  assert.equal(beyond.status, 'budget_exhausted');
  assert.equal(script.calls(), MAX_PROVIDER_CALLS);
});

test('export is a deep copy in both directions; deciding refuses SAVE_BUSY', async () => {
  const engine = new Engine(state());
  const script = scripted(['{"type":"eat"}']);
  const session = createAgentSession({
    world: countingWorld(engine), provider: script.provider,
    runId: 'ep1:npc_a:c1', actorId: 'npc_a',
    commandIdFor: g06CommandId('ep1', 'npc_a', 1), commandIdScheme: 'g06-episode-cycle',
  });
  const saved = exportSessionCheckpoint(session);
  assert.equal(saved.ok, true);
  (unwrap(saved).steps as unknown[]).push({ round: 99 } as never);
  assert.equal(session.steps.length, 0, 'mutating the checkpoint does not touch the session');
  const again = exportSessionCheckpoint(session);
  assert.equal(unwrap(again).steps.length, 0);

  // SAVE_BUSY: park the session inside decide, then export must refuse.
  const slow = { calls: 0, provider: { decide: async (): Promise<string> => new Promise(() => undefined) } };
  const busy = createAgentSession({
    world: countingWorld(engine), provider: slow.provider as never,
    runId: 'ep1:npc_c:c1', actorId: 'npc_c',
    commandIdFor: g06CommandId('ep1', 'npc_c', 1), commandIdScheme: 'g06-episode-cycle',
    timeoutMs: 50,
  });
  const inflight = stepAgent(busy);
  await busy.whenDeciding();
  const denied = exportSessionCheckpoint(busy);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'SAVE_BUSY');
  await inflight; // the 50ms timeout resolves it; result irrelevant
  busy.onDeciding = undefined;
});

test('restore rejects bad versions, shapes, ranges, torn step chains and formula mismatches', async () => {
  const engine = new Engine(state());
  const world = countingWorld(engine);
  const session = createAgentSession({
    world, provider: createReferenceProvider(), runId: 'ep1:npc_a:c1', actorId: 'npc_a',
    commandIdFor: g06CommandId('ep1', 'npc_a', 1), commandIdScheme: 'g06-episode-cycle',
  });
  const good = exportSessionCheckpoint(session);
  assert.equal(good.ok, true);
  const base = unwrap(good);
  const runtime = { world, provider: createReferenceProvider(), commandIdFor: g06CommandId('ep1', 'npc_a', 1) };
  const expectReject = (data: unknown, fragment: string): void => {
    const r = restoreAgentSession(data, runtime);
    assert.equal(r.ok, false, `expected rejection containing '${fragment}'`);
    assert.ok((r.issues ?? []).some(i => i.includes(fragment)) || r.code === 'SCHEMA_MISMATCH' || r.code === 'INVALID_CHECKPOINT', JSON.stringify(r));
  };
  expectReject(null, '');
  expectReject([1, 2], '');
  expectReject({ ...base, schema: 'frostecho.g03.snapshot/1' }, '');
  expectReject({ ...base, runId: '' }, 'runId');
  expectReject({ ...base, providerCalls: -1 }, 'providerCalls');
  expectReject({ ...base, providerCalls: MAX_PROVIDER_CALLS + 1 }, 'providerCalls');
  expectReject({ ...base, status: 'paused' }, 'status');
  expectReject({ ...base, status: 'deciding' }, 'deciding');
  expectReject({ ...base, timeoutMs: 0 }, 'timeoutMs');
  expectReject({ ...base, steps: [{ round: 2 }] }, 'steps');
  expectReject({ ...base, eventsBefore: -3 }, 'eventsBefore');
  expectReject({ ...base, feedback: { round: 0, kind: 'accepted', detail: 'x' } }, 'feedback');
  // Formula mismatch: saved scheme is g06-episode-cycle but the runtime
  // injects the G01 default formula — must be refused, not silently re-derived.
  const wrongFormula = restoreAgentSession(base, {
    world, provider: createReferenceProvider(),
    commandIdFor: (round: number) => `ep1:npc_a:c1:${round}`,
  });
  assert.equal(wrongFormula.ok, false);
  assert.equal(wrongFormula.code, 'INVALID_CHECKPOINT');
  assert.ok((wrongFormula.issues ?? []).some(i => i.includes('commandIdFor')), 'names the formula mismatch');
  // Actor not present in the restored world.
  const foreignWorld = countingWorld(new Engine(state()));
  const ghost = restoreAgentSession({ ...base, actorId: 'npc_z', runId: 'ep1:npc_z:c1' }, {
    world: foreignWorld, provider: createReferenceProvider(), commandIdFor: g06CommandId('ep1', 'npc_z', 1),
  });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.code, 'INVALID_CHECKPOINT');
});

test('a session with an undeclared custom formula refuses export instead of guessing', () => {
  const engine = new Engine(state());
  const session = createAgentSession({
    world: countingWorld(engine), provider: createReferenceProvider(),
    runId: 'custom-run', actorId: 'npc_a',
    commandIdFor: (round: number) => `weird-${round}`,
  });
  assert.equal(session.commandIdScheme, 'unknown');
  const r = exportSessionCheckpoint(session);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_CHECKPOINT');
  assert.ok((r.issues ?? []).some(i => i.includes('commandId')));
});

test('parseG06RunId parses episode ids containing colons and rejects malformed ones', () => {
  assert.deepEqual(parseG06RunId('g05-ac-t1-recurring:npc_a:c2', 'npc_a'), { episodeId: 'g05-ac-t1-recurring', cycle: 2 });
  assert.deepEqual(parseG06RunId('a:b:npc_a:c10', 'npc_a'), { episodeId: 'a:b', cycle: 10 });
  assert.equal(parseG06RunId('g05:npc_a:c0', 'npc_a'), null);
  assert.equal(parseG06RunId('g05:npc_a:c', 'npc_a'), null);
  assert.equal(parseG06RunId('npc_a:c1', 'npc_a'), null);
});

/* ---------------- comparison helpers (timing excluded) ---------------- */

function stripTiming(step: { status: string; terminal?: boolean; providerCalled: boolean }): unknown {
  return { status: step.status, terminal: step.terminal, providerCalled: step.providerCalled };
}

function withoutTiming(result: RunResult): RunResult {
  const clone = structuredClone(result);
  delete (clone as { timing?: unknown }).timing;
  return clone;
}

void driveToHunger;
