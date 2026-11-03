/**
 * G08 worker C — checkpoint envelope + cross-process restore tests.
 *
 * Covers the frozen .g08.json contract: save/load round-trip with both
 * configuration axes, restoring a paused (timed_wait) session performs ZERO
 * provider calls and keeps the ORIGINAL deadline verbatim, the resumed
 * trajectory matches the never-interrupted one, runtime/config contradictions
 * are refused with CONFLICT before anything is rebuilt, foreign (.g06/.g07)
 * suffixes and tampered envelopes are rejected, existing slots are never
 * overwritten, and the play-g08 CLI restores across real processes.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createReactiveGame } from '../src/reactive/game';
import { buildNeedsWorld } from '../src/needs/game';
import { createMailbox } from '../src/communication/mailbox';
import {
  G08_CHECKPOINT_SCHEMA, G08_GAME_SCHEMA, G08_SESSION_SCHEMA,
} from '../src/temporal/contracts';
import {
  g08CheckpointPath, loadG08Checkpoint, restoreG08Game, saveG08Checkpoint,
} from '../src/temporal/checkpoint';
import { slotChecksum } from '../src/persistence/atomic-slot';
import type { Provider } from '../src/agent/contracts';
import type { WorldState } from '../src/types';

/** G08-R1: every save now carries one effective configuration. */
const REF_CONFIG = { mode: 'reference', requestModel: null, thinking: false, timeoutMs: 120000 } as const;

function queued(scripts: Record<string, string[]>, counters: Record<string, number>): (actorId: string) => Provider {
  return (actorId: string) => ({
    decide: async () => {
      const list = scripts[actorId] ?? ['{"type":"stop"}'];
      const index = counters[actorId] ?? 0;
      counters[actorId] = index + 1;
      return list[index % list.length];
    },
  });
}

function worldWith(hungerA: number, hungerC: number, kitchenFood = 3): WorldState {
  return buildNeedsWorld({ kitchenFood, hunger: { npc_a: hungerA, npc_c: hungerC } });
}

interface Built {
  game: ReturnType<typeof createReactiveGame>;
  mailbox: ReturnType<typeof createMailbox>;
  counters: Record<string, number>;
}

function newG08Game(episodeId: string, scripts: Record<string, string[]>): Built {
  const counters: Record<string, number> = {};
  return {
    counters,
    mailbox: createMailbox(),
    game: createReactiveGame({
      episodeId,
      initialState: worldWith(40, 40),
      actorIds: ['npc_a', 'npc_c'],
      providerFor: queued(scripts, counters),
      mode: 'reference',
      thinking: false,
      wakePolicy: 'event',
      actionSet: 'timed_wait',
    }),
  };
}

/** Both arms share this prefix: npc_a waits (deadline 1), npc_c stops. */
async function playToPause(built: Built): Promise<void> {
  const first = await built.game.advance();
  assert.equal((first as { actorId: string }).actorId, 'npc_a');
  assert.equal(built.game.actorStateOf('npc_a'), 'timed_wait');
  const second = await built.game.advance();
  assert.equal((second as { actorId: string }).actorId, 'npc_c');
  assert.equal(built.counters.npc_a, 1);
  assert.equal(built.counters.npc_c, 1);
}

test('save/load round-trip: paused session restores with zero provider calls and the original deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-cp-'));
  try {
    const built = newG08Game('g08-c-rt', {
      npc_a: ['{"type":"wait"}', '{"type":"eat"}', '{"type":"stop"}'],
      npc_c: ['{"type":"stop"}'],
    });
    await playToPause(built);
    const saved = saveG08Checkpoint(root, 'paused', built.game, built.mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok, (saved as { issues?: string[] }).issues?.join('; '));
    assert.equal(existsSync(join(root, 'paused.g08.json')), true);

    const onDisk = JSON.parse(readFileSync(g08CheckpointPath(root, 'paused'), 'utf8')).payload as {
      schema: string; actionSet: string; messageMode: string;
      game: { schema: string; states: Record<string, string>; wakeAtSimTime: Record<string, number | null>; totalCalls: number };
    };
    assert.equal(onDisk.schema, G08_CHECKPOINT_SCHEMA);
    assert.equal(onDisk.actionSet, 'timed_wait');
    assert.equal(onDisk.messageMode, 'off');
    assert.equal(onDisk.game.schema, G08_GAME_SCHEMA);
    assert.equal(onDisk.game.states.npc_a, 'timed_wait');
    assert.equal(onDisk.game.wakeAtSimTime.npc_a, 1, 'deadline exported verbatim');
    assert.equal(onDisk.game.wakeAtSimTime.npc_c, null);
    assert.equal(onDisk.game.totalCalls, 2);

    const loaded = loadG08Checkpoint(g08CheckpointPath(root, 'paused'));
    assert.ok(loaded.ok, (loaded as { issues?: string[] }).issues?.join('; '));
    assert.equal(loaded.value.envelope.schema, G08_CHECKPOINT_SCHEMA);

    const restoreCalls: Record<string, number> = {};
    const restored = restoreG08Game(loaded.value, {
      providerFor: queued({
        npc_a: ['{"type":"eat"}', '{"type":"stop"}'],
        npc_c: ['{"type":"stop"}'],
      }, restoreCalls),
      actionSet: 'timed_wait',
      messageMode: 'off',
    });
    assert.ok(restored.ok, (restored as { issues?: string[] }).issues?.join('; '));
    assert.deepEqual(restoreCalls, {}, 'restore itself never calls the provider');
    assert.equal(restored.value.actorStateOf('npc_a'), 'timed_wait');
    assert.equal(restored.value.status().wakeAtSimTime?.npc_a, 1, 'ORIGINAL deadline preserved verbatim');
    const restoredData = (restored.value as unknown as { checkpointData(): { totalCalls: number } }).checkpointData();
    assert.equal(restoredData.totalCalls, 2, 'budget untouched by restore');
    const savedSession = (restored.value as unknown as {
      checkpointData(): { cycles: Record<string, { session: { schema: string; status: string; wakeAtSimTime: number | null } }[]> };
    }).checkpointData().cycles.npc_a.at(-1)?.session;
    assert.equal(savedSession?.schema, G08_SESSION_SCHEMA);
    assert.equal(savedSession?.status, 'waiting_time');
    assert.equal(savedSession?.wakeAtSimTime, 1);
    await restored.value.close();
    await built.game.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resumed trajectory matches the never-interrupted one: wake, continue, identical final state', async () => {
  const scripts = {
    npc_a: ['{"type":"wait"}', '{"type":"eat"}', '{"type":"stop"}'],
    npc_c: ['{"type":"stop"}'],
  };
  // Continuous arm: pause, jump time, continue to the end.
  const continuous = newG08Game('g08-c-cont', scripts);
  await playToPause(continuous);
  const jump = continuous.game.worldAdvanceTime(1);
  assert.equal(jump.ok, true);
  assert.equal(continuous.game.actorStateOf('npc_a'), 'active');
  await continuous.game.runUntilIdle();
  const finalContinuous = continuous.game.status();

  // Resumed arm: save at the pause, restore in a FRESH runtime, then the same
  // world time jump and run. The provider restarts its script list, so npc_a
  // decides wait again — also a legal continuation — and the invariant is the
  // equality of every mechanical field the checkpoint owns.
  const root = mkdtempSync(join(tmpdir(), 'g08-cp-'));
  try {
    const interrupted = newG08Game('g08-c-res', scripts);
    await playToPause(interrupted);
    const saved = saveG08Checkpoint(root, 'res', interrupted.game, interrupted.mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);
    const loaded = loadG08Checkpoint(g08CheckpointPath(root, 'res'));
    assert.ok(loaded.ok);
    const restored = restoreG08Game(loaded.value, {
      providerFor: queued({
        npc_a: ['{"type":"eat"}', '{"type":"stop"}'],
        npc_c: ['{"type":"stop"}'],
      }, {}),
      actionSet: 'timed_wait',
      messageMode: 'off',
    });
    assert.ok(restored.ok, (restored as { issues?: string[] }).issues?.join('; '));
    const resumedJump = restored.value.worldAdvanceTime(1);
    assert.equal(resumedJump.ok, true);
    assert.equal(restored.value.actorStateOf('npc_a'), 'active', 'deadline survived the restart and still wakes');
    await restored.value.runUntilIdle();
    const finalResumed = restored.value.status();
    const totalOf = (s: { actors: Record<string, { providerCalls: number }> }): number =>
      Object.values(s.actors).reduce((sum, a) => sum + a.providerCalls, 0);
    assert.equal(finalResumed.simTime, finalContinuous.simTime);
    assert.equal(totalOf(finalResumed), totalOf(finalContinuous), 'same budget spend: wait never adds calls');
    assert.deepEqual(finalResumed.actors.npc_a.cycle, finalContinuous.actors.npc_a.cycle, 'the SAME cycle continues after restore');
    assert.equal(finalResumed.actors.npc_a.providerCalls, finalContinuous.actors.npc_a.providerCalls);
    assert.deepEqual(
      finalResumed.player, finalContinuous.player,
      'identical world outcome for the player',
    );
    assert.equal(restored.value.actorStateOf('npc_a'), continuous.game.actorStateOf('npc_a'));
    await restored.value.close();
    await interrupted.game.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  await continuous.game.close();
});

test('a runtime axis contradiction is refused with CONFLICT before any restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-cp-'));
  try {
    const built = newG08Game('g08-c-conf', {
      npc_a: ['{"type":"wait"}', '{"type":"stop"}'],
      npc_c: ['{"type":"stop"}'],
    });
    await playToPause(built);
    const saved = saveG08Checkpoint(root, 'axes', built.game, built.mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);
    const loaded = loadG08Checkpoint(g08CheckpointPath(root, 'axes'));
    assert.ok(loaded.ok);

    const wrongActionSet = restoreG08Game(loaded.value, {
      providerFor: queued({}, {}),
      actionSet: 'legacy',
      messageMode: 'off',
    });
    assert.equal(wrongActionSet.ok, false);
    assert.equal((wrongActionSet as { code: string }).code, 'CONFLICT');

    const wrongMessages = restoreG08Game(loaded.value, {
      providerFor: queued({}, {}),
      actionSet: 'timed_wait',
      messageMode: 'on',
    });
    assert.equal(wrongMessages.ok, false);
    assert.equal((wrongMessages as { code: string }).code, 'CONFLICT');
    await built.game.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreign suffixes (.g06/.g07) and tampered envelopes are rejected, existing slots never overwritten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-cp-'));
  try {
    // Foreign suffix: refused by name before any file content is parsed.
    const g06Path = join(root, 'foreign.g06.json');
    writeFileSync(g06Path, JSON.stringify({ schema: G08_CHECKPOINT_SCHEMA, actionSet: 'timed_wait', messageMode: 'off' }), 'utf8');
    const foreign = loadG08Checkpoint(g06Path);
    assert.equal(foreign.ok, false);
    assert.equal((foreign as { code: string }).code, 'SCHEMA_MISMATCH');
    const g07Path = join(root, 'foreign.g07.json');
    writeFileSync(g07Path, '{}', 'utf8');
    assert.equal((loadG08Checkpoint(g07Path) as { code: string }).code, 'SCHEMA_MISMATCH');

    const built = newG08Game('g08-c-guard', {
      npc_a: ['{"type":"wait"}', '{"type":"stop"}'],
      npc_c: ['{"type":"stop"}'],
    });
    await playToPause(built);
    const saved = saveG08Checkpoint(root, 'guard', built.game, built.mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.ok(saved.ok);

    // Tampered payloads are rewritten with a FRESH checksum, so the guard
    // under test is loadG08Checkpoint's own semantic validation — not the
    // sha256 layer G06 already covers.
    const raw = JSON.parse(readFileSync(g08CheckpointPath(root, 'guard'), 'utf8')) as {
      schema: string; sha256: string; payload: Record<string, unknown>;
    };
    const rewrite = (mutate: (envelope: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(raw)) as typeof raw;
      mutate(copy.payload);
      copy.sha256 = slotChecksum(copy.payload);
      const p = join(root, `tampered.g08.json`);
      writeFileSync(p, JSON.stringify(copy), 'utf8');
      return p;
    };
    const loadResult = (p: string): { ok: boolean; code?: string } => loadG08Checkpoint(p) as { ok: boolean; code?: string };

    // Cross-field contradictions and foreign schemas are refused at LOAD time.
    assert.equal(loadResult(rewrite(e => { e.actionSet = 'legacy'; })).ok, false,
      'envelope actionSet contradicting the embedded game must be refused');
    assert.equal(loadResult(rewrite(e => { e.schema = 'frostecho.g07.checkpoint/1'; })).ok, false,
      'a foreign envelope schema must be refused');
    assert.equal(loadResult(rewrite(e => { (e.game as { schema: string }).schema = 'frostecho.g06.game/2'; })).ok, false,
      'a foreign embedded game schema must be refused');
    // messageMode is a valid axis value: load accepts it, RESTORE must refuse.
    const resealed = loadResult(rewrite(e => { e.messageMode = 'on'; }));
    assert.equal(resealed.ok, true, 'a structurally valid messageMode passes load');
    assert.equal((loadG08Checkpoint(rewrite(e => { e.messageMode = 'maybe'; })) as { code: string }).code, 'SCHEMA_MISMATCH',
      'a non-axis messageMode value is refused at load');

    // Second save into the SAME slot is refused; the file keeps the first bytes.
    const before = readFileSync(g08CheckpointPath(root, 'guard'), 'utf8');
    const again = saveG08Checkpoint(root, 'guard', built.game, built.mailbox, 'timed_wait', 'off', REF_CONFIG);
    assert.equal(again.ok, false);
    assert.equal(readFileSync(g08CheckpointPath(root, 'guard'), 'utf8'), before, 'the existing slot is untouched');
    await built.game.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Cross-process CLI: real fresh node processes, zero in-process state  */
/* ------------------------------------------------------------------ */

interface CliOutcome { code: number | null; stdout: string; stderr: string }

async function runCli(args: string[]): Promise<CliOutcome> {
  const child = spawn(process.execPath, [resolve('dist/scripts/play-g08.js'), ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c; });
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  return { code, stdout, stderr };
}

test('play-g08 CLI: cross-process restore keeps the deadline, spends zero calls, then wakes on time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g08-cli-'));
  try {
    const created = await runCli(['--root', root, '--slot', 'xproc', '--new', '--actions', 'timed_wait', '--step', '2', '--save']);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /saved/, 'the save path is reported');

    // Fresh process, status only: paused actor, original deadline, no new calls.
    const status = await runCli(['--root', root, '--slot', 'xproc', '--load', '--actions', 'timed_wait', '--status']);
    assert.equal(status.code, 0, status.stderr);
    const paused = JSON.parse(status.stdout) as {
      simTime: number; totalCalls: number; paused: string;
      actors: Record<string, { state: string; providerCalls: number }>;
    };
    assert.equal(paused.actors.npc_a.state, 'timed_wait');
    assert.equal(paused.paused, 'npc_a->simTime 1');
    assert.equal(paused.totalCalls, 2, 'restore spent zero provider calls');

    // Fresh process: advance the world clock; the paused session wakes with
    // ZERO provider calls (still awaiting round-robin) in the SAME cycle.
    const woken = await runCli(['--root', root, '--slot', 'xproc', '--load', '--actions', 'timed_wait', '--time', '1', '--status']);
    assert.equal(woken.code, 0, woken.stderr);
    const resumed = JSON.parse(woken.stdout) as {
      simTime: number; totalCalls: number; paused: string;
      actors: Record<string, { state: string; cycle: number }>;
    };
    assert.equal(resumed.simTime, 1);
    assert.equal(resumed.actors.npc_a.state, 'active', 'the wake itself performs no decide; round-robin schedules it next');
    assert.equal(resumed.paused, '(none)', 'the deadline is consumed by the single resume');
    assert.equal(resumed.actors.npc_a.cycle, 1, 'the SAME cycle continues after the cross-process restart');
    assert.equal(resumed.totalCalls, 2, 'the wake spent zero provider calls');

    // A wrong runtime axis is refused by the CLI too.
    const conflict = await runCli(['--root', root, '--slot', 'xproc', '--load', '--actions', 'legacy', '--status']);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /CONFLICT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
