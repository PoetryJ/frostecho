/**
 * G09-R1 worker C tests — save/restore v2 and the playable CLI:
 * zero-call restore, no re-choice, save-as, mode conflicts, failure finalization.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import {
  g09CheckpointPath, loadG09Checkpoint, restoreG09Game, saveG09Checkpoint,
} from '../src/negotiation/checkpoint';
import { createGoalRequest, createRequestStore } from '../src/negotiation/requests';
import { G09_CHECKPOINT_SCHEMA, G09_REQUEST_TEXT, G09_TIMEOUT_MS } from '../src/negotiation/contracts';
import type { G08EffectiveConfig } from '../src/temporal/contracts';

const CONFIG: G08EffectiveConfig = { mode: 'reference', requestModel: null, thinking: true, timeoutMs: G09_TIMEOUT_MS };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g09r1-slot-'));
}

function gameWith(goalAnswer: 'feed_self' | 'yield_once') {
  const game = createNeedsGame({
    episodeId: 'ep',
    initialState: buildNeedsWorld({ actorIds: ['npc_a', 'npc_c'], kitchenFood: 1, hunger: { npc_a: 40, npc_b: 40, npc_c: 70 } }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({
      async decide(input: { goalChoice?: unknown }) {
        return input.goalChoice === undefined ? '{"type":"eat"}' : JSON.stringify({ goal: goalAnswer });
      },
    }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: G09_TIMEOUT_MS,
    actionSet: 'timed_wait', goalMode: 'negotiated', candidateSet: 'choice', playerId: 'npc_b',
  });
  const built = createGoalRequest({
    requestId: 'req-1', episodeId: 'ep', to: 'npc_a', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
  });
  assert.ok(built.ok);
  assert.equal((game as unknown as { submitGoalRequest(r: unknown): { ok: boolean } }).submitGoalRequest(built.value).ok, true);
  return { game, store: createRequestStore() };
}

test('a decided slot round-trips with the request store and the binding', async () => {
  const root = tempRoot();
  try {
    const { game } = gameWith('yield_once');
    await game.advance(); // goal
    const session = game.sessionsOf().find(entry => entry.actorId === 'npc_a')!.session;
    const binding = session.goalBinding;
    assert.equal(binding?.goal, 'yield_once');
    const store = (game as unknown as { goalRequests(): { requests: Record<string, never>; processed: string[] } }).goalRequests();
    // Fold the decision into the store exactly as the eval does.
    const stored = { ...(store.requests['req-1'] as Record<string, unknown>), status: 'accepted', decision: { goal: 'yield_once', round: 1, decidedAtSimTime: 0, raw: '{"goal":"yield_once"}' }, acceptedAfterSeq: binding!.acceptedAfterSeq };
    const requests = { requests: { 'req-1': stored }, processed: store.processed };
    const saved = saveG09Checkpoint(root, 'slot-a', game, { arm: 'choice', satiety: 40, requests: requests as never, binding }, CONFIG);
    assert.ok(saved.ok, saved.ok ? '' : saved.issues?.join('; '));
    const loaded = loadG09Checkpoint(g09CheckpointPath(root, 'slot-a'));
    assert.ok(loaded.ok);
    assert.equal(loaded.value.envelope.schema, G09_CHECKPOINT_SCHEMA);
    assert.equal(loaded.value.envelope.binding?.goal, 'yield_once');
    assert.deepEqual(loaded.value.envelope.requests.processed, ['req-1']);
    assert.deepEqual(loaded.value.envelope.effectiveConfig, CONFIG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore spends ZERO calls, keeps the phase and never re-chooses', async () => {
  const root = tempRoot();
  try {
    const { game } = gameWith('yield_once');
    await game.advance();
    const session = game.sessionsOf().find(entry => entry.actorId === 'npc_a')!.session;
    const binding = session.goalBinding!;
    const requests = {
      requests: { 'req-1': { ...((game as unknown as { goalRequests(): { requests: Record<string, object> } }).goalRequests().requests['req-1']), status: 'accepted', decision: { goal: 'yield_once', round: 1, decidedAtSimTime: 0, raw: binding.raw }, acceptedAfterSeq: binding.acceptedAfterSeq } },
      processed: ['req-1'],
    };
    assert.ok(saveG09Checkpoint(root, 'slot-b', game, { arm: 'choice', satiety: 40, requests: requests as never, binding }, CONFIG).ok);
    const loaded = loadG09Checkpoint(g09CheckpointPath(root, 'slot-b'));
    assert.ok(loaded.ok);
    let called = 0;
    const restored = restoreG09Game(loaded.value, {
      providerFor: () => ({ async decide() { called += 1; return '{"type":"stop"}'; } }) as never,
      now: Date.now,
    });
    assert.ok(restored.ok, restored.ok ? '' : restored.issues?.join('; '));
    assert.equal(called, 0, 'restore must not call the provider');
    const session2 = restored.value.game.sessionsOf().find(entry => entry.actorId === 'npc_a')!.session;
    assert.equal(session2.phase, 'action');
    assert.equal(session2.goalBinding?.goal, 'yield_once');
    assert.equal(session2.providerCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tampered or contradictory slot is refused before any game exists', async () => {
  const root = tempRoot();
  try {
    const { game } = gameWith('feed_self');
    await game.advance();
    const requests = { requests: {}, processed: [] as string[] };
    assert.ok(saveG09Checkpoint(root, 'slot-c', game, { arm: 'choice', satiety: 40, requests: requests as never, binding: null }, CONFIG).ok);
    const path = g09CheckpointPath(root, 'slot-c');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { payload: { schema: string } };
    raw.payload.schema = 'frostecho.g09.checkpoint/1';
    writeFileSync(path, JSON.stringify(raw, null, 2));
    assert.equal(loadG09Checkpoint(path).ok, false, 'a v1 slot must not be silently reinterpreted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function cliAsync(root: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dist/scripts/play-g09.js', '--root', root, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>(resolveExit => {
      child.on('exit', code => resolveExit(code));
    });
    let out = '';
    child.stdout?.on('data', chunk => { out += String(chunk); });
    child.stderr?.on('data', chunk => { out += String(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
    void exited.then(code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

function cli(root: string, ...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['dist/scripts/play-g09.js', '--root', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

test('the CLI runs the real protocol, saves, loads and save-as', () => {
  const root = tempRoot();
  try {
    const created = cli(root, '--new', '--slot', 'play', '--goals', 'negotiated', '--candidates', 'choice', '--request', 'npc_a=yield_once', '--step', '--save');
    assert.equal(created.code, 0, created.out);
    assert.match(created.out, /saved -> /);
    const loaded = cli(root, '--load', '--path', g09CheckpointPath(root, 'play'), '--status');
    assert.match(loaded.out, /zero calls, no re-choice/);
    const again = cli(root, '--load', '--path', g09CheckpointPath(root, 'play'), '--step', '--save-as', 'copy');
    assert.equal(again.code, 0, again.out);
    assert.ok(existsSync(g09CheckpointPath(root, 'copy')), 'save-as writes a new slot');
    assert.ok(existsSync(g09CheckpointPath(root, 'play')), 'the source slot is untouched');
    // A conflicting model is refused before any HTTP.
    const conflict = cli(root, '--load', '--path', g09CheckpointPath(root, 'play'), '--model', 'other-model', '--step');
    assert.notEqual(conflict.code, 0);
    assert.match(conflict.out, /model conflict/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a 500 step exits nonzero, writes the failure record and keeps the slot bytes', async () => {
  const root = tempRoot();
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const http = `http://127.0.0.1:${port}/v1/chat/completions`;
  try {
    const created = await cliAsync(root, ['--new', '--slot', 'fail', '--live', '--http', http, '--model', 'm', '--goals', 'negotiated', '--request', 'npc_a=yield_once', '--save']);
    assert.equal(created.code, 0, created.out);
    const slotPath = g09CheckpointPath(root, 'fail');
    const before = readFileSync(slotPath);
    const failed = await cliAsync(root, ['--load', '--path', slotPath, '--live', '--http', http, '--model', 'm', '--step']);
    assert.notEqual(failed.code, 0, 'a 500 step must exit nonzero');
    assert.ok(hits >= 1, 'the in-process server must actually return 500');
    assert.equal(readFileSync(slotPath).equals(before), true, 'the input slot bytes must not change');
    assert.ok(existsSync(`${slotPath.replace(/\.g09\.json$/, '')}.failure.json`), 'the failure record is written separately');
    const record = JSON.parse(readFileSync(`${slotPath.replace(/\.g09\.json$/, '')}.failure.json`, 'utf8')) as { schema: string; reason: string };
    assert.equal(record.schema, 'frostecho.g09.run-failure/2');
    assert.match(record.reason, /500|http/i);
    assert.equal(/timeout/i.test(record.reason) && !/500|http/i.test(record.reason), false);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
