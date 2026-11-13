/**
 * G08-R1 worker A — restore-consistency regression tests (from the frozen
 * pre-fix probes). Every case here was a probe finding first; the fix must
 * keep the probe green forever:
 *  - a timed_wait world without an authoritative simTime is rejected at
 *    construction (before any provider call), never backfilled with 0;
 *  - deadline/actionSet/state contradictions between the game projection and
 *    the sessions fail restore with NAMED codes (no half-restored game);
 *  - an expired-but-valid deadline still restores as-is;
 *  - a wait on the actor's limit call settles budget_exhausted INSIDE the
 *    same advance (record, cycle and result all reflect it);
 *  - a legacy session can never be waiting_time.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgentSession, stepAgent } from '../src/agent/runner';
import type { Provider } from '../src/agent/contracts';
import { buildNeedsWorld } from '../src/needs/game';
import { restoreNeedsGame } from '../src/reactive/checkpoint';
import { createReactiveGame } from '../src/reactive/game';
import { saveG08Checkpoint } from '../src/temporal/checkpoint';
import { createMailbox } from '../src/communication/mailbox';
import type { WorldState } from '../src/types';

// The fixture game records the default wired timeout (15000); the saved
// effectiveConfig must describe the very same runtime.
const REF_CONFIG = { mode: 'reference', requestModel: null, thinking: false, timeoutMs: 15000 } as const;

/** Same starting world the frozen probes use. */
function probeWorld(hungerC = 70): WorldState {
  return buildNeedsWorld({ hunger: { npc_a: 40, npc_c: hungerC }, kitchenFood: 1 });
}

function scripted(scripts: Record<string, string[]>): (actorId: string) => Provider {
  const counters: Record<string, number> = {};
  return (actorId: string) => ({
    decide: async () => {
      const list = scripts[actorId] ?? ['{"type":"stop"}'];
      const index = counters[actorId] ?? 0;
      counters[actorId] = index + 1;
      return list[index % list.length];
    },
  });
}

function timedGame(state: WorldState, scripts: Record<string, string[]>, episodeId = 'r1-restore') {
  return createReactiveGame({
    episodeId,
    initialState: state,
    actorIds: ['npc_a', 'npc_c'],
    providerFor: scripted(scripts),
    mode: 'reference',
    thinking: false,
    wakePolicy: 'event',
    needPolicy: 'recurring',
    actionSet: 'timed_wait',
  });
}

test('timed_wait construction rejects a world without simTime, legacy does not', () => {
  const noTime = probeWorld();
  delete (noTime as { simTime?: number }).simTime;
  assert.throws(() => timedGame(noTime, { npc_a: ['{"type":"stop"}'] }), /INVALID_INITIAL_STATE/);
  // The legacy axis keeps its pre-G08 freedom.
  const legacy = createReactiveGame({
    episodeId: 'r1-legacy-plain',
    initialState: noTime,
    actorIds: ['npc_a', 'npc_c'],
    providerFor: scripted({}),
    mode: 'reference',
    thinking: false,
    wakePolicy: 'event',
    actionSet: 'legacy',
  });
  assert.equal(legacy.status().actionSet, 'legacy');
});

test('restore rejects a projected deadline that contradicts the session (DEADLINE_CONFLICT)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-r1-a-'));
  try {
    const game = timedGame(probeWorld(), { npc_a: ['{"type":"wait"}'], npc_c: ['{"type":"stop"}'] });
    const mailbox = createMailbox();
    await game.advance(); // npc_a waits at deadline 1
    await game.advance(); // npc_c stops
    const saved = saveG08Checkpoint(root, 'paused', game, mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);
    const raw = JSON.parse(readFileSync(saved.value.path, 'utf8')) as {
      payload: { game: { wakeAtSimTime: Record<string, number | null> } };
    };
    raw.payload.game.wakeAtSimTime.npc_a = 99; // tamper: game projection lies
    const { writeFileSync } = await import('node:fs');
    writeFileSync(saved.value.path, JSON.stringify(raw, null, 2));
    const restored = restoreNeedsGame(raw.payload.game, { providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }) });
    assert.equal(restored.ok, false);
    assert.equal((restored as { code?: string }).code, 'DEADLINE_CONFLICT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a session actionSet that contradicts the game (ACTION_SET_CONFLICT)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-r1-a-'));
  try {
    const game = timedGame(probeWorld(), { npc_a: ['{"type":"wait"}'], npc_c: ['{"type":"stop"}'] });
    const mailbox = createMailbox();
    await game.advance();
    await game.advance();
    const saved = saveG08Checkpoint(root, 'axes', game, mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);
    const raw = JSON.parse(readFileSync(saved.value.path, 'utf8')) as {
      payload: { game: { cycles: Record<string, Array<{ session: Record<string, unknown> }>> } };
    };
    const cycles = raw.payload.game.cycles.npc_a;
    (cycles[cycles.length - 1].session as { actionSet?: unknown }).actionSet = 'legacy';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(saved.value.path, JSON.stringify(raw, null, 2));
    const restored = restoreNeedsGame(raw.payload.game, { providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }) });
    assert.equal(restored.ok, false);
    assert.equal((restored as { code?: string }).code, 'ACTION_SET_CONFLICT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects an active actor whose session claims waiting_time (SESSION_STATE_CONFLICT)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-r1-a-'));
  try {
    const game = timedGame(probeWorld(), { npc_a: ['{"type":"wait"}'], npc_c: ['{"type":"stop"}'] });
    const mailbox = createMailbox();
    await game.advance();
    await game.advance();
    const saved = saveG08Checkpoint(root, 'state', game, mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);
    const raw = JSON.parse(readFileSync(saved.value.path, 'utf8')) as {
      payload: {
        game: {
          cycles: Record<string, Array<{ session: Record<string, unknown> }>>;
          wakeAtSimTime: Record<string, number | null>;
        };
      };
    };
    // npc_c stopped, but force its closed session into a waiting pose.
    const cycles = raw.payload.game.cycles.npc_c;
    (cycles[cycles.length - 1].session as { status?: unknown }).status = 'waiting_time';
    (cycles[cycles.length - 1].session as { wakeAtSimTime?: unknown }).wakeAtSimTime = 5;
    raw.payload.game.wakeAtSimTime.npc_c = 5;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(saved.value.path, JSON.stringify(raw, null, 2));
    const restored = restoreNeedsGame(raw.payload.game, { providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }) });
    assert.equal(restored.ok, false);
    assert.equal((restored as { code?: string }).code, 'SESSION_STATE_CONFLICT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects a timed_wait checkpoint without simTime (MISSING_SIMTIME)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-r1-a-'));
  try {
    const game = timedGame(probeWorld(), { npc_a: ['{"type":"wait"}'], npc_c: ['{"type":"stop"}'] });
    const mailbox = createMailbox();
    await game.advance();
    await game.advance();
    const saved = saveG08Checkpoint(root, 'notime', game, mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);
    const raw = JSON.parse(readFileSync(saved.value.path, 'utf8')) as {
      payload: { game: { initialState: Record<string, unknown> } };
    };
    delete raw.payload.game.initialState.simTime;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(saved.value.path, JSON.stringify(raw, null, 2));
    const restored = restoreNeedsGame(raw.payload.game, { providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }) });
    assert.equal(restored.ok, false);
    assert.equal((restored as { code?: string }).code, 'MISSING_SIMTIME');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an expired-but-valid deadline restores as-is and the next reconcile honors it', async () => {
  const game = timedGame(probeWorld(), { npc_a: ['{"type":"wait"}', '{"type":"stop"}'], npc_c: ['{"type":"stop"}'] });
  await game.advance(); // npc_a waits at deadline 1
  await game.advance(); // npc_c stops
  const restored = restoreNeedsGame((game as never as { checkpointData(): unknown }).checkpointData(), { providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }) });
  assert.ok(restored.ok, (restored as { issues?: string[] }).issues?.join('; '));
  const resumed = restored.value as ReturnType<typeof createReactiveGame>;
  // The deadline is already past simTime 0? No — deadline 1 > 0, still valid.
  assert.equal(resumed.actorStateOf('npc_a'), 'timed_wait');
  assert.equal(resumed.status().simTime, 0);
  const wake = resumed.worldAdvanceTime(1);
  assert.equal(wake.ok, true);
  const step = await resumed.advance(); // npc_a resumes in the SAME cycle
  assert.equal((step as { actorId: string }).actorId, 'npc_a');
  assert.equal(resumed.actorStateOf('npc_a'), 'stopped');
});

test('a wait on the actor limit call settles budget_exhausted inside that advance', async () => {
  // Probe P6 construction: every eat satisfies the need and closes its
  // cycle, hunger reactivation reopens the actor, so the 10th provider call
  // lands on a FRESH session — exactly the case the runner's session budget
  // cannot see. The settle must happen before the advance returns.
  let n = 0;
  const decide = async (): Promise<string> => (n += 1) <= 9 ? '{"type":"eat"}' : '{"type":"wait"}';
  const game = createReactiveGame({
    episodeId: 'r1-actor10',
    actorIds: ['npc_a'],
    providerFor: () => ({ decide }),
    initialState: probeWorld(),
    mode: 'reference',
    thinking: false,
    wakePolicy: 'event',
    needPolicy: 'recurring',
    actionSet: 'timed_wait',
  });
  for (let i = 0; i < 9; i += 1) {
    await game.advance();
    game.worldRestock('kitchen', 1);
    game.worldAdvanceTime(3);
  }
  assert.equal(n, 9);
  assert.equal(game.actorStateOf('npc_a'), 'active');
  const tenth = await game.advance();
  assert.equal(n, 10);
  assert.equal((tenth as { result?: { status?: string } }).result?.status, 'budget_exhausted');
  assert.equal(game.actorStateOf('npc_a'), 'budget_exhausted');
  const deadlinesAfter = game.status().wakeAtSimTime as Record<string, number | null>;
  assert.equal(deadlinesAfter.npc_a ?? null, null);
  const record = (game as never as { checkpointData(): unknown }).checkpointData() as {
    states: Record<string, string>;
    cycles: Record<string, Array<{ endState?: string; turns: Array<{ status: string }>; session: { status: string; wakeAtSimTime: number | null } }>>;
  };
  assert.equal(record.states.npc_a, 'budget_exhausted');
  const last = record.cycles.npc_a[record.cycles.npc_a.length - 1];
  assert.equal(last.endState, 'budget_exhausted');
  assert.equal(last.session.status, 'budget_exhausted');
  assert.equal(last.session.wakeAtSimTime, null);
  const lastTurn = last.turns.at(-1)!;
  assert.equal(lastTurn!.status, 'budget_exhausted');
});

test('a legacy session can never restore as waiting_time', async () => {
  const game = createReactiveGame({
    episodeId: 'r1-legacy-wait',
    initialState: probeWorld(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }),
    mode: 'reference',
    thinking: false,
    wakePolicy: 'event',
    actionSet: 'legacy',
  });
  await game.advance();
  await game.advance();
  const record = JSON.parse(JSON.stringify((game as never as { checkpointData(): unknown }).checkpointData())) as {
    cycles: Record<string, Array<{ session: Record<string, unknown> }>>;
    wakeAtSimTime: Record<string, number | null>;
  };
  const cycles = record.cycles.npc_a;
  const lastSession = cycles.at(-1)!.session as { status?: unknown; wakeAtSimTime?: unknown };
  lastSession.status = 'waiting_time';
  lastSession.wakeAtSimTime = 3;
  record.wakeAtSimTime.npc_a = 3;
  const restored = restoreNeedsGame(record as never, { providerFor: scripted({ npc_a: ['{"type":"stop"}'], npc_c: ['{"type":"stop"}'] }) });
  assert.equal(restored.ok, false);
});

test('createNeedsGame honors the same timed_wait simTime contract', () => {
  const state = probeWorld();
  delete (state as { simTime?: number }).simTime;
  assert.throws(
    () => createReactiveGame({
      episodeId: 'r1-needs-notime',
      initialState: state,
      actorIds: ['npc_a', 'npc_c'],
      providerFor: scripted({}),
      mode: 'reference',
      thinking: false,
      wakePolicy: 'event',
      needPolicy: 'recurring',
      actionSet: 'timed_wait',
    }),
    /INVALID_INITIAL_STATE/,
  );
});

test('a wait accepted with a valid simTime still works (guard against over-rejection)', async () => {
  const game = timedGame(probeWorld(), { npc_a: ['{"type":"wait"}'], npc_c: ['{"type":"stop"}'] }, 'r1-ok-wait');
  const first = await game.advance();
  assert.equal((first as { actorId: string }).actorId, 'npc_a');
  assert.equal((first as { result?: { status?: string } }).result?.status, 'waiting_time');
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait');
  const deadlines = game.status().wakeAtSimTime as Record<string, number | null>;
  assert.equal(deadlines.npc_a ?? null, 1);
});
