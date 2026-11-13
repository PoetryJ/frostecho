/**
 * G08 worker A — timed-wait session tests.
 *
 * Covers the frozen contracts in src/temporal/contracts.ts on the session
 * side: the wait action parse boundary, deadline = authoritative simTime + 1,
 * budget precedence, resume-if-due without a provider call, the episode
 * budget hook, and the G08 session checkpoint round trip (including the old
 * schema refusing a waiting_time payload).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld } from '../src';
import type { WorldState } from '../src/types';
import { createAgentSession, stepAgent } from '../src/agent/runner';
import { parseAction } from '../src/agent/parser';
import type { DecideInput } from '../src/agent/contracts';
import { exportSessionCheckpoint, restoreAgentSession } from '../src/agent/checkpoint';
import type { SessionCheckpoint } from '../src/persistence/contracts';
import { G08_SESSION_SCHEMA } from '../src/temporal/contracts';
import { countingWorld, scripted } from './agent-helpers';

function timedWorld(simSteps: number): { eng: Engine; state: WorldState } {
  const state = initialWorld();
  const eng = new Engine(state);
  if (simSteps > 0) {
    const exec = eng.submit({
      commandId: 'w:advance:1',
      actorId: 'world',
      type: 'advance_time',
      payload: { steps: simSteps },
    });
    assert.equal(exec.status, 'accepted');
  }
  return { eng, state };
}

test('legacy parser rejects wait with the unchanged legacy error', () => {
  const legacy = parseAction('{"type":"wait"}');
  assert.equal(legacy.ok, false);
  assert.equal((legacy as { error: string }).error, 'type must be move, eat, or stop');
});

test('timed_wait parser accepts exactly {"type":"wait"}', () => {
  const ok = parseAction('{"type":"wait"}', 'timed_wait');
  assert.deepEqual(ok, { ok: true, action: { type: 'wait' } });
  const extra = parseAction('{"type":"wait","x":1}', 'timed_wait');
  assert.equal((extra as { error: string }).error, 'wait must be exactly {"type":"wait"}');
  const unknown = parseAction('{"type":"fly"}', 'timed_wait');
  assert.equal((unknown as { error: string }).error, 'type must be move, eat, stop, or wait');
});

test('an accepted wait sets waiting_time with deadline simTime+1 and survives re-stepping', async () => {
  const { eng } = timedWorld(5);
  const seen: DecideInput[] = [];
  const script = scripted(['{"type":"wait"}'], seen);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-basic',
    now: () => 0,
    actionSet: 'timed_wait',
  });
  const step = await stepAgent(session);
  assert.equal(step.status, 'waiting_time');
  assert.equal(step.terminal, false);
  assert.equal(step.providerCalled, true);
  assert.equal(session.status, 'waiting_time');
  assert.equal(session.wakeAtSimTime, 6);
  assert.equal(session.providerCalls, 1);
  assert.equal(session.actionSet, 'timed_wait');
  assert.deepEqual(session.feedback, { round: 1, kind: 'accepted', detail: 'wait' });
  assert.equal(session.steps[0].wait?.wakeAtSimTime, 6);
  // The G08 capability line reached the provider input.
  assert.equal(seen[0].allowedActions, 'timed_wait');
  // Stepping a paused session neither resumes it nor calls the provider.
  const again = await stepAgent(session);
  assert.equal(again.status, 'waiting_time');
  assert.equal(again.providerCalled, false);
  assert.equal(script.calls(), 1);
});

test('resumeIfDue only fires once at the deadline and costs no provider call', async () => {
  const { eng } = timedWorld(2);
  const script = scripted(['{"type":"wait"}', '{"type":"stop"}']);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-resume',
    now: () => 0,
    actionSet: 'timed_wait',
  });
  await stepAgent(session);
  assert.equal(session.resumeIfDue(2), false, 'simTime 2 has not reached deadline 3');
  assert.equal(session.resumeIfDue(3), true, 'simTime 3 reaches deadline 3');
  assert.equal(session.status, 'ready');
  assert.equal(session.wakeAtSimTime, null);
  assert.deepEqual(session.waitState(), {
    actionSet: 'timed_wait',
    status: 'ready',
    wakeAtSimTime: null,
    providerCalls: 1,
    resumedOnce: true,
  });
  assert.equal(session.resumeIfDue(4), false, 'one resume per wait, never a second');
  // The resumed session continues the SAME session: round and feedback survive.
  const step = await stepAgent(session);
  assert.equal(step.status, 'stopped');
  assert.equal(session.providerCalls, 2);
  assert.equal(session.steps.length, 2);
});

test('a wait on the last session call ends budget_exhausted with no deadline', async () => {
  const { eng } = timedWorld(1);
  const script = scripted([
    '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}', '{"type":"wait"}',
  ]);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-budget',
    now: () => 0,
    actionSet: 'timed_wait',
  });
  for (let i = 0; i < 4; i += 1) {
    const step = await stepAgent(session);
    assert.equal(step.status, 'waiting_time');
    assert.ok(session.resumeIfDue(session.wakeAtSimTime ?? 0), `resume ${i + 1}`);
  }
  const fifth = await stepAgent(session);
  assert.equal(fifth.status, 'budget_exhausted');
  assert.equal(fifth.terminal, true);
  assert.equal(session.wakeAtSimTime, null);
  assert.equal(session.steps[4].wait?.wakeAtSimTime, null);
  assert.equal(session.result().outcome, 'budget_exhausted');
});

test('a world without simTime rejects the wait as a protocol failure (G08-R1: no ?? 0 fallback)', async () => {
  const { eng } = timedWorld(0);
  const script = scripted(['{"type":"wait"}']);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-zero',
    now: () => 0,
    actionSet: 'timed_wait',
  });
  const result = await stepAgent(session);
  // The call already happened, but the wait is NOT accepted: no fallback
  // deadline is invented from a missing authoritative clock.
  assert.equal(result.status, 'invalid_run');
  assert.equal(session.wakeAtSimTime, null);
  assert.equal(session.status, 'invalid_run');
});

test('exhaustBudget terminates a paused session and clears its deadline', async () => {
  const { eng } = timedWorld(4);
  const script = scripted(['{"type":"wait"}']);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-exhaust',
    now: () => 0,
    actionSet: 'timed_wait',
  });
  await stepAgent(session);
  assert.equal(session.status, 'waiting_time');
  session.exhaustBudget('episode call budget exhausted');
  assert.equal(session.status, 'budget_exhausted');
  assert.equal(session.wakeAtSimTime, null);
  assert.equal(session.resumeIfDue(99), false);
  assert.equal(session.result().error, 'episode call budget exhausted');
  // Terminal sessions never revive through the hook.
  session.exhaustBudget('again');
  assert.equal(session.status, 'budget_exhausted');
});

test('a legacy session exposes the same control surface without wait capability', async () => {
  const { eng } = timedWorld(3);
  const script = scripted(['{"type":"wait"}']);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'legacy-surface',
    now: () => 0,
  });
  assert.equal(session.actionSet, 'legacy');
  const step = await stepAgent(session);
  assert.equal(step.status, 'ready');
  assert.deepEqual(session.feedback, { round: 1, kind: 'invalid_output', detail: 'type must be move, eat, or stop' });
  assert.equal(session.resumeIfDue(99), false);
  assert.equal(session.wakeAtSimTime, null);
});

test('G08 session checkpoint round trips a paused session with its deadline', async () => {
  const { eng } = timedWorld(7);
  const script = scripted(['{"type":"wait"}']);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-save',
    now: () => 0,
    commandIdScheme: 'run-round',
    actionSet: 'timed_wait',
  });
  await stepAgent(session);
  const exported = exportSessionCheckpoint(session, 'g08');
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const data = exported.value as unknown as Record<string, unknown>;
  assert.equal(data.schema, G08_SESSION_SCHEMA);
  assert.equal(data.actionSet, 'timed_wait');
  assert.equal(data.wakeAtSimTime, 8);
  assert.equal(data.status, 'waiting_time');

  const restored = restoreAgentSession(exported.value, {
    world: countingWorld(eng),
    provider: script.provider,
    now: () => 0,
    commandIdFor: (round: number) => `wait-save:${round}`,
  });
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  const back = restored.value;
  assert.equal(back.status, 'waiting_time');
  assert.equal(back.wakeAtSimTime, 8);
  assert.equal(back.providerCalls, 1);
  assert.equal(back.actionSet, 'timed_wait');
  assert.equal(script.calls(), 1, 'restore made no provider call');
  assert.equal(back.resumeIfDue(8), true);
  assert.equal(back.status, 'ready');
});

test('the legacy session schema refuses a waiting_time payload', async () => {
  const { eng } = timedWorld(7);
  const script = scripted(['{"type":"wait"}']);
  const session = createAgentSession({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'wait-old-schema',
    now: () => 0,
    commandIdScheme: 'run-round',
    actionSet: 'timed_wait',
  });
  await stepAgent(session);
  const g06 = exportSessionCheckpoint(session, 'g06');
  assert.equal(g06.ok, true);
  if (!g06.ok) return;
  // A G06-shaped payload carrying waiting_time must be refused at restore.
  const forged: SessionCheckpoint = {
    ...(g06.value as SessionCheckpoint),
    status: 'waiting_time' as SessionCheckpoint['status'],
  };
  const restored = restoreAgentSession(forged, {
    world: countingWorld(eng),
    provider: script.provider,
    now: () => 0,
    commandIdFor: (round: number) => `wait-old-schema:${round}`,
  });
  assert.equal(restored.ok, false);
  assert.equal(restored.code, 'INVALID_CHECKPOINT');
});

test('a G08 payload without actionSet or with an inconsistent deadline is refused', async () => {
  const { eng } = timedWorld(7);
  const runtime = {
    world: countingWorld(eng),
    provider: scripted(['{"type":"stop"}']).provider,
    now: () => 0,
    commandIdFor: (round: number) => `broken:${round}`,
  };
  const g08 = exportSessionCheckpoint(createAgentSession({
    world: countingWorld(eng),
    provider: scripted(['{"type":"stop"}']).provider,
    actorId: 'npc_a',
    runId: 'broken',
    now: () => 0,
    commandIdScheme: 'run-round',
    actionSet: 'timed_wait',
  }), 'g08');
  assert.equal(g08.ok, true);
  if (!g08.ok) return;
  const base = g08.value as unknown as Record<string, unknown>;
  const noActionSet = { ...base } as Record<string, unknown>;
  delete noActionSet.actionSet;
  const refused = restoreAgentSession(noActionSet, runtime);
  assert.equal(refused.ok, false);
  const strayDeadline = { ...base, wakeAtSimTime: 9 } as Record<string, unknown>;
  const refused2 = restoreAgentSession(strayDeadline, runtime);
  assert.equal(refused2.ok, false);
});
