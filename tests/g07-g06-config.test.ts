/**
 * G07 worker C — the two G06 bounded follow-ups, verified against a fake HTTP
 * server (no real model calls).
 *
 * 1. New live saves record the actual model. A load reads the checkpoint first,
 *    validates mode AND model before constructing any provider: a mismatch or
 *    an unknown saved model exits 2 with zero POSTs. thinking/timeout come from
 *    the saved effective config, never from the CLI/environment.
 * 2. A save IO_ERROR makes the final exit non-zero; EXISTS stays an ordinary
 *    rejection with exit 0.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createNeedsGame, buildNeedsWorld } from '../src/needs/game';
import { exportGameCheckpoint } from '../src/reactive/checkpoint';
import { saveCheckpoint } from '../src/persistence/file-store';
import { createReferenceProvider } from '../src/agent/providers/reference';

const CLI = resolve('dist/scripts/play-g06.js');

interface Fake {
  url: string;
  posts: { body: Record<string, unknown> }[];
  close(): Promise<void>;
}

async function startFake(model: string, action = '{"type":"eat"}'): Promise<Fake> {
  const posts: { body: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; });
      req.on('end', () => {
        posts.push({ body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: action } }],
          usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    posts,
    close: () => new Promise<void>(r => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

interface Outcome { code: number | null; stdout: string; stderr: string }

async function runCli(args: string[], input: string, env: Record<string, string>): Promise<Outcome> {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c; });
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  child.stdin.end(input);
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  return { code, stdout, stderr };
}

/** Save a live episode, then drive one decision so a POST lands. */
async function saveLive(root: string, model: string): Promise<{ file: string; fake: Fake }> {
  const fake = await startFake(model);
  const env: Record<string, string> = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: model, FROSTECHO_LIVE_TIMEOUT_MS: '120000' };
  // Save first (nobody is deciding yet), then drive one decision so a POST lands.
  const out = await runCli(['--live', '--episode', 'g07-cfg', '--out', join(root, 'ep'), '--slots', join(root, 'slots')], 'world advance 2\nsave live1\nrun\nquit\n', env);
  assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
  const file = join(root, 'slots', 'live1.g06.json');
  assert.equal(existsSync(file), true, out.stdout);
  return { file, fake };
}

/** Build a live checkpoint through the library so thinking can be false. */
function libraryLiveCheckpoint(root: string, model: string, thinking: boolean): string {
  const game = createNeedsGame({
    episodeId: 'g07-lib',
    initialState: buildNeedsWorld({ kitchenFood: 4 }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'live',
    thinking,
    needPolicy: 'recurring',
    timeoutMs: 120000,
    requestModel: model,
  });
  game.worldAdvanceTime(2); // hunger 50: the next decision is a real one
  const exported = exportGameCheckpoint(game);
  assert.equal(exported.ok, true);
  const saved = saveCheckpoint(join(root, 'libslots'), 'lib', exported.value);
  assert.equal(saved.ok, true);
  return unwrapPath(saved);
}

function unwrapPath(r: { ok: true; value: { path: string } } | { ok: false; code: string; issues?: string[] }): string {
  if (!r.ok) throw new Error(`${r.code}: ${(r.issues ?? []).join('; ')}`);
  return r.value.path;
}

test('a new live save records the actual model, thinking and timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cfg-'));
  try {
    const { fake } = await saveLive(root, 'model-alpha');
    await fake.close();
    const file = JSON.parse(readFileSync(join(root, 'slots', 'live1.g06.json'), 'utf8')) as {
      payload: { mode: string; requestModel: string | null; thinking: boolean; timeoutMs: number };
    };
    assert.equal(file.payload.mode, 'live');
    assert.equal(file.payload.requestModel, 'model-alpha');
    assert.equal(file.payload.thinking, true, 'thinking is the effective saved value');
    assert.equal(file.payload.timeoutMs, 120000);
    assert.equal(fake.posts.length >= 1, true, 'the decision really happened through the fake server');
    const body = fake.posts[0].body as { model: string; chat_template_kwargs: { enable_thinking: boolean } };
    assert.equal(body.model, 'model-alpha');
    assert.equal(body.chat_template_kwargs.enable_thinking, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a model mismatch is refused before any provider request (zero POSTs)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cfg-'));
  try {
    const { file, fake } = await saveLive(root, 'model-alpha');
    const postsAfterSave = fake.posts.length;
    await fake.close();
    // Same endpoint, different model in the environment.
    const other = await startFake('model-beta');
    const out = await runCli(['--live', '--load', file, '--out', join(root, 'ep2'), '--slots', join(root, 'slots2')], 'status\nquit\n', {
      FROSTECHO_LLM_URL: other.url, FROSTECHO_LLM_MODEL: 'model-beta',
    });
    assert.equal(out.code, 2, `${out.stdout}\n${out.stderr}`);
    assert.match(out.stderr, /MODEL_CONFLICT/);
    assert.equal(other.posts.length, 0, 'validation happens before constructing the provider');
    assert.equal(postsAfterSave >= 1, true);
    await other.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resuming a live save uses the saved thinking value, not the environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cfg-'));
  try {
    // A live checkpoint saved with thinking=false (built through the library).
    const file = libraryLiveCheckpoint(root, 'model-alpha', false);
    // Environment says thinking=true: the saved effective config must win.
    const same = await startFake('model-alpha');
    const out = await runCli(['--live', '--load', file, '--out', join(root, 'ep3'), '--slots', join(root, 'slots3')], 'run\nquit\n', {
      FROSTECHO_LLM_URL: same.url, FROSTECHO_LLM_MODEL: 'model-alpha', FROSTECHO_LLM_THINKING: 'true',
    });
    assert.equal(out.code, 0, `${out.stdout}\n${out.stderr}`);
    assert.ok(same.posts.length >= 1, 'the resumed game made a real decision');
    for (const post of same.posts) {
      const body = post.body as { model: string; temperature: number; max_tokens: number; stream: boolean; chat_template_kwargs: { enable_thinking: boolean } };
      assert.equal(body.model, 'model-alpha');
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 1024);
      assert.equal(body.stream, false);
      assert.equal(body.chat_template_kwargs.enable_thinking, false, 'saved thinking=false, not the env true');
    }
    await same.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unwritable save path fails the exit code; EXISTS stays an ordinary rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g07-cfg-'));
  try {
    // A regular file where the slots directory should be: mkdir/write fail.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory\n');
    const io = await runCli(['--episode', 'g07-io', '--out', join(root, 'ep'), '--slots', join(blocked, 'nested')], 'save s1\nquit\n', {});
    assert.equal(io.code, 1, `${io.stdout}\n${io.stderr}`);
    assert.match(io.stdout, /\[save rejected\] IO_ERROR/);

    // Duplicate slot: ordinary rejection, exit 0, old bytes untouched.
    const slots = join(root, 'slots');
    mkdirSync(slots, { recursive: true });
    const first = await runCli(['--episode', 'g07-dup', '--out', join(root, 'ep2'), '--slots', slots], 'save twice\nquit\n', {});
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    const before = readFileSync(join(slots, 'twice.g06.json'), 'utf8');
    const second = await runCli(['--episode', 'g07-dup', '--out', join(root, 'ep3'), '--slots', slots], 'save twice\nquit\n', {});
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /\[save rejected\] EXISTS/);
    assert.equal(readFileSync(join(slots, 'twice.g06.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
