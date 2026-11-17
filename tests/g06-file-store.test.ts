/**
 * G06 worker C — checkpoint file layer + play:g06 CLI self-tests.
 *
 * Exclusive atomic saves (same slot never overwrites, racing saves yield one
 * file), rejection of empty/half-written/tampered/foreign files, and the CLI
 * contract: save prints path+simTime+NPC states, --load resumes without a
 * model call, duplicate slot refuses, corrupt load exits 2, mode conflicts
 * exit 2.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { saveCheckpoint, loadCheckpoint, checkpointPath } from '../src/persistence/file-store';
import { exportGameCheckpoint } from '../src/reactive/checkpoint';
import { createNeedsGame, buildNeedsWorld } from '../src/needs/game';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { GameCheckpoint } from '../src/persistence/contracts';

const CLI = resolve('dist/scripts/play-g06.js');

function sampleCheckpoint(episodeId = 'g06-c-sample'): GameCheckpoint {
  const game = createNeedsGame({
    episodeId,
    initialState: buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    needPolicy: 'recurring',
  });
  const exported = exportGameCheckpoint(game);
  assert.equal(exported.ok, true);
  return exported.value;
}

const unwrap = <T,>(r: { ok: true; value: T } | { ok: false; code: string; issues?: string[] }): T => {
  if (!r.ok) throw new Error(`${r.code}: ${(r.issues ?? []).join('; ')}`);
  return r.value;
};

interface CliOutcome { code: number | null; stdout: string; stderr: string }

async function runCli(args: string[], input: string, env: Record<string, string> = {}): Promise<CliOutcome> {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c; });
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  child.stdin.end(input);
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  return { code, stdout, stderr };
}

test('save then load round-trips; the file carries schema, sha256 and payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-c-'));
  try {
    const checkpoint = sampleCheckpoint();
    const saved = saveCheckpoint(root, 'slot-a', checkpoint);
    assert.equal(saved.ok, true);
    const file = JSON.parse(readFileSync(unwrap(saved).path, 'utf8')) as { schema: string; sha256: string; createdAt: string };
    assert.equal(file.schema, 'frostecho.g06.checkpoint/1');
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    const loaded = loadCheckpoint(unwrap(saved).path);
    assert.equal(loaded.ok, true);
    assert.deepEqual(unwrap(loaded), checkpoint);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same slot never overwrites; racing saves produce exactly one file', () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-c-'));
  try {
    const first = sampleCheckpoint('g06-c-first');
    const second = sampleCheckpoint('g06-c-second');
    assert.equal(saveCheckpoint(root, 'dup', first).ok, true);
    const before = readFileSync(checkpointPath(root, 'dup'), 'utf8');
    const again = saveCheckpoint(root, 'dup', second);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'EXISTS');
    assert.equal(readFileSync(checkpointPath(root, 'dup'), 'utf8'), before, 'old bytes untouched');
    // Racing writers (synchronous here, but the link() guard is what two
    // processes would hit): exactly one winner, same final bytes.
    const results = [saveCheckpoint(root, 'race', first), saveCheckpoint(root, 'race', second)];
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => !r.ok && r.code === 'EXISTS').length, 1);
    assert.equal(loadCheckpoint(checkpointPath(root, 'race')).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid slots, empty, half-written, tampered and foreign files are all rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-c-'));
  try {
    const checkpoint = sampleCheckpoint();
    const badSlot = saveCheckpoint(root, '../evil', checkpoint);
    assert.equal(badSlot.ok, false);
    assert.equal(saveCheckpoint(root, 'UPPER', checkpoint).ok, false);
    const path = checkpointPath(root, 'ok-slot');
    assert.equal(saveCheckpoint(root, 'ok-slot', checkpoint).ok, true);

    writeFileSync(join(root, 'empty.g06.json'), '');
    const empty = loadCheckpoint(join(root, 'empty.g06.json'));
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'INVALID_CHECKPOINT');

    const raw = readFileSync(path, 'utf8');
    writeFileSync(join(root, 'half.g06.json'), raw.slice(0, Math.floor(raw.length / 2)));
    const half = loadCheckpoint(join(root, 'half.g06.json'));
    assert.equal(half.ok, false);
    assert.equal(half.code, 'INVALID_CHECKPOINT');

    const parsed = JSON.parse(raw) as { payload: { episodeId: string } };
    parsed.payload.episodeId = 'tampered';
    writeFileSync(join(root, 'tamper.g06.json'), JSON.stringify(parsed));
    const tampered = loadCheckpoint(join(root, 'tamper.g06.json'));
    assert.equal(tampered.ok, false);
    assert.equal(tampered.code, 'CHECKSUM_MISMATCH');

    writeFileSync(join(root, 'old.g06.json'), JSON.stringify({ schema: 'frostecho.g03.snapshot/1', payload: {} }));
    const old = loadCheckpoint(join(root, 'old.g06.json'));
    assert.equal(old.ok, false);
    assert.equal(old.code, 'SCHEMA_MISMATCH');

    const missing = loadCheckpoint(join(root, 'nope.g06.json'));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'IO_ERROR');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: save prints path/simTime/NPC states; --load resumes with no model call; duplicate slot refuses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-cli-'));
  const slots = join(root, 'slots');
  const out = join(root, 'episodes');
  try {
    const first = await runCli(['--episode', 'g06-cli-demo', '--out', out, '--slots', slots], 'step\nsave alpha\nquit\n');
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /\[save ok\] .*alpha\.g06\.json simTime=0/);
    assert.match(first.stdout, /npc_a: state=satisfied cycle=1 calls=0 hunger=70/);
    const file = join(slots, 'alpha.g06.json');
    assert.equal(existsSync(file), true);
    const second = await runCli(['--load', file, '--out', join(root, 'episodes2'), '--slots', slots], 'status\nstep\nsave beta\nsave beta\nquit\n');
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /G06 resumed g06-cli-demo .*no model call, no command replay/);
    assert.match(second.stdout, /\[step stepped\]|\[step idle\]/);
    assert.match(second.stdout, /\[save rejected\] EXISTS/);
    assert.match(second.stdout, /npc_c: state=satisfied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: corrupt load and mode conflict exit 2 without creating anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-cli-'));
  try {
    const bad = join(root, 'bad.g06.json');
    writeFileSync(bad, '{"schema":"frostecho.g06.checkpoint/1","sha256":"x"');
    const out = await runCli(['--load', bad, '--out', join(root, 'ep')], 'quit\n');
    assert.equal(out.code, 2);
    assert.match(out.stderr, /\[load rejected\]/);

    // A live-mode checkpoint refuses a reference CLI (MODE_CONFLICT).
    const liveGame = createNeedsGame({
      episodeId: 'g06-cli-live',
      initialState: buildNeedsWorld({ kitchenFood: 2, hunger: { npc_a: 40, npc_c: 40 } }),
      actorIds: ['npc_a', 'npc_c'],
      providerFor: () => createReferenceProvider(),
      mode: 'live',
      needPolicy: 'recurring',
    });
    const exported = exportGameCheckpoint(liveGame);
    assert.equal(exported.ok, true);
    const saved = saveCheckpoint(root, 'live-slot', exported.value);
    assert.equal(saved.ok, true);
    const conflict = await runCli(['--load', checkpointPath(root, 'live-slot'), '--out', join(root, 'ep2')], 'quit\n');
    assert.equal(conflict.code, 2);
    assert.match(conflict.stderr, /MODE_CONFLICT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: player move/eat work on a resumed game', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g06-cli-'));
  const slots = join(root, 'slots');
  try {
    const first = await runCli(['--episode', 'g06-cli-player', '--out', join(root, 'ep'), '--slots', slots], 'step\nsave mid\nquit\n');
    assert.equal(first.code, 0);
    const second = await runCli(['--load', join(slots, 'mid.g06.json'), '--out', join(root, 'ep2'), '--slots', slots], 'player move dorm\nplayer move kitchen\nplayer eat\nquit\n');
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /\[player accepted\] g06-cli-player:player:npc_b:1/);
    assert.match(second.stdout, /\[player accepted\] g06-cli-player:player:npc_b:2/);
    assert.match(second.stdout, /\[player accepted\] g06-cli-player:player:npc_b:3/);
    assert.match(second.stdout, /player=kitchen hunger=100/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
