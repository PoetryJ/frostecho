/**
 * G06 worker B — ReactiveGame checkpoint self-tests (in-process; D does the
 * real cross-process pairs).
 *
 * Export/restore preserves world, lifecycle states, cycles+turns, sessions,
 * rotation cursor, player/world id counters, closed/interrupted flags and
 * budgets. Restoring never opens a cycle, calls a provider or submits a
 * command; a closed save restores closed; busy exports are SAVE_BUSY; corrupt
 * or inconsistent data is rejected with issues and no half-restored object.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../src/needs/game';
import { exportGameCheckpoint, restoreNeedsGame } from '../src/reactive/checkpoint';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { GameCheckpoint } from '../src/persistence/contracts';
import type { ReactiveRecord } from '../src/reactive/contracts';
import type { WorldState } from '../src/types';

const providerFor = () => createReferenceProvider();

function newGame(episodeId: string, world: WorldState, actorIds: string[] = ['npc_a', 'npc_c']): NeedsGame {
  return createNeedsGame({
    episodeId,
    initialState: world,
    actorIds,
    providerFor,
    mode: 'reference',
    needPolicy: 'recurring',
  });
}

const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; code: string; issues?: string[] }): T => {
  if (!r.ok) throw new Error(`${r.code}: ${(r.issues ?? []).join('; ')}`);
  return r.value;
};

function exportOf(game: NeedsGame): GameCheckpoint {
  return unwrap(exportGameCheckpoint(game));
}

function restoreOf(data: GameCheckpoint): NeedsGame {
  return unwrap(restoreNeedsGame(JSON.parse(JSON.stringify(data)), { providerFor })) as NeedsGame;
}

/** Everything D compares, minus wall-clock timing. */
function comparable(record: ReactiveRecord): unknown {
  const clone = structuredClone(record);
  delete (clone as { timing?: unknown }).timing;
  return clone;
}

test('mid-active save: restored game continues identically; no cycle opened, no call on restore', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-mid', world);
  await game.advance(); // first NPC decision (eat → 70)
  const checkpoint = exportOf(game);
  assert.equal(checkpoint.states.npc_a, 'satisfied');
  assert.equal(checkpoint.states.npc_c, 'active');
  assert.equal(checkpoint.totalCalls, 1);
  const cyclesBefore = { a: game.cyclesOf('npc_a'), c: game.cyclesOf('npc_c') };

  const restored = restoreOf(checkpoint);
  assert.equal(restored.cyclesOf('npc_a'), cyclesBefore.a);
  assert.equal(restored.cyclesOf('npc_c'), cyclesBefore.c);
  assert.equal(restored.snapshot().transitions.length, game.snapshot().transitions.length, 'no new transition on restore');

  // Both continue with the same action sequence.
  const continuousTail = async (g: NeedsGame): Promise<void> => {
    await g.runUntilIdle(); // second NPC eats
    g.worldRestock('kitchen', 2);
    await g.runUntilIdle();
    g.playerLine('player eat');
    g.worldAdvanceTime(2);
    await g.runUntilIdle();
  };
  await continuousTail(game);
  await continuousTail(restored);
  assert.deepEqual(comparable(restored.snapshot()), comparable(game.snapshot()));
  // Command ids continue their sequences rather than restarting.
  const restoredIds = restored.snapshot().commands.map(c => c.command.commandId);
  assert.ok(restoredIds.some(id => id.includes(':player:npc_b:')), 'player command present');
  assert.deepEqual(restoredIds, game.snapshot().commands.map(c => c.command.commandId));
});

test('rotation cursor survives restore: the next actor is the other NPC', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-rot', world);
  const first = await game.advance();
  assert.equal(first.kind, 'stepped');
  const firstActor = first.kind === 'stepped' ? first.actorId : '';
  const checkpoint = exportOf(game);
  const restored = restoreOf(checkpoint);
  const next = await restored.advance();
  assert.equal(next.kind, 'stepped');
  assert.equal(next.kind === 'stepped' ? next.actorId : '', 'npc_c', `after ${firstActor}, the other NPC must be next`);
  // And the continuous branch picks the same actor.
  const nextContinuous = await game.advance();
  assert.equal(nextContinuous.kind === 'stepped' ? nextContinuous.actorId : '', 'npc_c');
});

test('waiting state round-trips: restock wakes the restored game without replaying old turns', async () => {
  const world = buildNeedsWorld({ kitchenFood: 0, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-wait', world);
  await game.runUntilIdle(); // both stop hungry with an empty kitchen → waiting
  assert.equal(game.actorStateOf('npc_a'), 'waiting');
  const checkpoint = exportOf(game);
  const restored = restoreOf(checkpoint);
  assert.equal(restored.actorStateOf('npc_a'), 'waiting');
  assert.equal(restored.actorStateOf('npc_c'), 'waiting');
  const callsBefore = restored.snapshot().actors.npc_a.providerCalls;
  restored.worldRestock('kitchen', 2);
  await restored.runUntilIdle();
  assert.equal(restored.snapshot().finalState.npcs.npc_a.hunger, 70);
  assert.equal(restored.snapshot().finalState.npcs.npc_c.hunger, 70);
  assert.equal(restored.snapshot().actors.npc_a.providerCalls, callsBefore + 1, 'exactly one new call, old turns not replayed');
});

test('closed save restores closed; interrupted save restores interrupted', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-closed', world);
  await game.advance();
  await game.close();
  const checkpoint = exportOf(game);
  assert.equal(checkpoint.closed, true);
  const restored = restoreOf(checkpoint);
  assert.equal(restored.isClosed(), true);
  const outcome = await restored.advance();
  assert.equal(outcome.kind, 'closed', 'a closed checkpoint never restores to an open game');
  assert.equal(restored.playerLine('player eat').ok, false);

  // Interrupted: a provider that throws interrupts the episode.
  const failing = createNeedsGame({
    episodeId: 'g06-b-fail',
    initialState: world,
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({ decide: async () => { throw new Error('transport down'); } }),
    mode: 'reference',
    needPolicy: 'recurring',
  });
  await failing.runUntilIdle();
  assert.equal(failing.isInterrupted(), true);
  const failedCheckpoint = exportOf(failing);
  assert.equal(failedCheckpoint.interrupted, true);
  assert.equal(failedCheckpoint.lastInterruptedActor, 'npc_a');
  const restoredFailed = restoreOf(failedCheckpoint);
  assert.equal(restoredFailed.isInterrupted(), true);
  const out = await restoredFailed.advance();
  assert.equal(out.kind, 'interrupted');
});

test('satisfied terminal cycles restore without re-opening or calling the provider', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-sat', world);
  await game.runUntilIdle(); // both eat to 70 → satisfied
  const checkpoint = exportOf(game);
  assert.equal(checkpoint.states.npc_a, 'satisfied');
  assert.equal(checkpoint.states.npc_c, 'satisfied');
  const restored = restoreOf(checkpoint);
  const outcome = await restored.advance();
  assert.equal(outcome.kind, 'idle', 'terminal actors do not run again');
  assert.equal(restored.snapshot().actors.npc_a.providerCalls, 1);
  assert.equal(restored.cyclesOf('npc_a'), 1, 'no new cycle after restore');
});

test('budget_exhausted lifecycle state round-trips', async () => {
  const world = buildNeedsWorld({ kitchenFood: 0, hunger: { npc_a: 40, npc_c: 40 } });
  // Invalid output forever → each session burns its 5-call budget.
  const game = createNeedsGame({
    episodeId: 'g06-b-budget',
    initialState: world,
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({ decide: async () => 'not-json' }),
    mode: 'reference',
    needPolicy: 'recurring',
  });
  await game.runUntilIdle();
  const checkpoint = exportOf(game);
  assert.equal(checkpoint.states.npc_a, 'budget_exhausted');
  const restored = restoreOf(checkpoint);
  assert.equal(restored.actorStateOf('npc_a'), 'budget_exhausted');
  assert.equal(restored.snapshot().actors.npc_a.providerCalls, 5);
  const out = await restored.advance();
  assert.equal(out.kind, 'idle');
});

test('in-flight save is SAVE_BUSY and serializes nothing', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  let release: () => void = () => undefined;
  const gate = new Promise<void>(r => { release = r; });
  const game = createNeedsGame({
    episodeId: 'g06-b-busy',
    initialState: world,
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({ decide: async () => { await gate; return '{"type":"eat"}'; } }),
    mode: 'reference',
    needPolicy: 'recurring',
  });
  const inflight = game.advance();
  // Wait until the provider call is genuinely in flight.
  await new Promise(r => setTimeout(r, 10));
  const denied = exportGameCheckpoint(game);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'SAVE_BUSY');
  release();
  await inflight;
  const after = exportGameCheckpoint(game);
  assert.equal(after.ok, true, 'save works again at the decision boundary');
});

test('corrupt or inconsistent checkpoints are rejected with issues, never half-restored', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-corrupt', world);
  await game.advance();
  const good = exportOf(game);
  const expectReject = (mutate: (d: GameCheckpoint) => void, fragment: string): void => {
    const data = structuredClone(good);
    mutate(data);
    const r = restoreNeedsGame(data, { providerFor });
    assert.equal(r.ok, false, `expected rejection for ${fragment}`);
    assert.ok((r.issues ?? []).some(i => i.includes(fragment)), `${fragment}: ${(r.issues ?? []).join('; ')}`);
  };
  expectReject(d => { d.busy = true; }, 'busy');
  expectReject(d => { d.cursor = 99; }, 'cursor');
  expectReject(d => { d.totalCalls = 99; }, 'totalCalls');
  expectReject(d => { d.cycles.npc_a[0].cycle = 7; }, 'cycle');
  expectReject(d => { d.cycles.npc_a[0].session.runId = 'other'; }, 'runId');
  expectReject(d => { d.cycles.npc_a[0].session.commandIdScheme = 'run-round'; }, 'commandIdScheme');
  expectReject(d => { d.states.npc_a = 'paused' as never; }, 'states');
  expectReject(d => { d.playerSeq = 0; }, 'playerSeq');
  expectReject(d => { d.worldSeq = 0; }, 'worldSeq');
  expectReject(d => { d.needPolicy = 'sometimes' as never; }, 'needPolicy');
  // Engine corruption: saved state no longer matches the event replay.
  expectReject(d => { d.engine.state.npcs.npc_a.hunger = 5; }, '');
  const wrongSchema = restoreNeedsGame({ ...good, schema: 'frostecho.g03.snapshot/1' }, { providerFor });
  assert.equal(wrongSchema.ok, false);
  assert.equal(wrongSchema.code, 'SCHEMA_MISMATCH');
  const nullInput = restoreNeedsGame(null, { providerFor });
  assert.equal(nullInput.ok, false);
});

test('restore makes no world command and no provider call at all', async () => {
  const world = buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } });
  const game = newGame('g06-b-pure', world);
  await game.advance();
  const checkpoint = exportOf(game);
  let providerCalls = 0;
  const restored = unwrap(restoreNeedsGame(JSON.parse(JSON.stringify(checkpoint)), {
    providerFor: () => ({
      decide: async () => { providerCalls += 1; return '{"type":"stop"}'; },
    }),
  }));
  assert.equal(providerCalls, 0, 'restore itself never decides');
  const before = restored.snapshot();
  assert.equal(before.commands.length, game.snapshot().commands.length, 'no command submitted during restore');
  assert.equal(before.events.length, game.snapshot().events.length);
});
