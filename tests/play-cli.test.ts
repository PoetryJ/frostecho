import assert from 'node:assert/strict';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replay } from '../src';

const PLAY = join('dist', 'scripts', 'play.js');

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['FROSTECHO_LLM_URL', 'FROSTECHO_LLM_MODEL', 'FROSTECHO_LLM_API_KEY', 'FROSTECHO_G02_ARTIFACT_DIR', 'FROSTECHO_LLM_THINKING', 'FROSTECHO_LIVE_TIMEOUT_MS']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface PlayChild {
  child: ChildProcessWithoutNullStreams;
  wait(pattern: RegExp): Promise<void>;
  stdout(): string;
  done(): Promise<{ code: number; stdout: string; stderr: string }>;
}

function startPlay(args: string[], env: NodeJS.ProcessEnv): PlayChild {
  const child = spawn(process.execPath, [PLAY, ...args], { env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const waiters: { pattern: RegExp; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = [];
  const scan = () => {
    for (const waiter of waiters) {
      if (waiter.pattern.test(out)) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; scan(); });
  child.stderr.on('data', (chunk: string) => { err += chunk; });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`play timed out\n${out}\n${err}`));
    }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: err });
    });
  });
  return {
    child,
    stdout: () => out,
    done: () => done,
    wait(pattern: RegExp) {
      if (pattern.test(out)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`waiting for ${pattern}\n${out}\n${err}`)), 8000);
        waiters.push({ pattern, resolve, reject, timer });
      });
    },
  };
}

test('play without --live ignores live env and does not call the network', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.statusCode = 500;
    res.end('{}');
  });
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'frostecho-play-'));
  const play = startPlay([], childEnv({
    FROSTECHO_LLM_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
    FROSTECHO_LLM_MODEL: 'live-model',
    FROSTECHO_LLM_API_KEY: 'sekret-play',
    FROSTECHO_G02_ARTIFACT_DIR: dir,
  }));
  try {
    await play.wait(/commands:/);
    play.child.stdin.write('npc step\n');
    await play.wait(/action=move/);
    play.child.stdin.write('status\n');
    await play.wait(/goalReached=false/);
    play.child.stdin.write('npc step\n');
    await play.wait(/action=eat/);
    play.child.stdin.write('status\n');
    await play.wait(/goalReached=true/);
    play.child.stdin.write('quit\n');
    const result = await play.done();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(hits, 0);
    assert.equal(result.stdout.includes('sekret-play'), false);
    assert.match(result.stdout, /mode=reference/);
    assert.match(result.stdout, /thinking=n\/a/);
    const saved = result.stdout.match(/quit saved=(\S+) outcome=goal_reached goalReached=true/);
    assert.ok(saved);
    const game = JSON.parse(readFileSync(join(saved[1], 'game.json'), 'utf8'));
    assert.equal(game.finalState.npcs.npc_a.hunger, 70);
    assert.equal(game.finalState.food.kitchen, 0);
    assert.equal(game.commands.every((entry: { role: string }) => entry.role === 'npc'), true);
    assert.deepEqual(replay(game.initialState, game.events), game.finalState);
  } finally {
    if (play.child.exitCode === null) play.child.kill('SIGKILL');
    await close(server);
  }
});

test('play --live without config exits 2 and does not call the network', async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits += 1; res.end('{}'); });
  const port = await listen(server);
  const play = startPlay(['--live'], childEnv({
    FROSTECHO_LLM_URL: '   ',
    FROSTECHO_LLM_MODEL: '',
  }));
  try {
    const result = await play.done();
    assert.equal(result.code, 2);
    assert.match(result.stderr, /FROSTECHO_LLM_URL/);
    assert.match(result.stderr, /FROSTECHO_LLM_MODEL/);
    assert.equal(hits, 0);
    assert.equal(port > 0, true);
  } finally {
    await close(server);
  }
});

test('player commands apply while the NPC request is in flight, then the stale eat is NO_FOOD', async () => {
  const pending: { index: number; end: (body: string) => void }[] = [];
  let hits = 0;
  const arrived: Array<() => void> = [];
  const server = createServer((req, res) => {
    const index = hits++;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const notify = arrived[index];
      if (index === 0) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"type":"move","to":"kitchen"}' } }] }));
        notify?.();
        return;
      }
      pending.push({
        index,
        end: (body: string) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content: body } }] }));
        },
      });
      notify?.();
    });
  });
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'frostecho-play-live-'));
  const play = startPlay(['--live', '--thinking', 'false'], childEnv({
    FROSTECHO_LLM_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
    FROSTECHO_LLM_MODEL: 'live-model',
    FROSTECHO_LLM_API_KEY: 'sekret-play',
    FROSTECHO_G02_ARTIFACT_DIR: dir,
  }));
  const waitHit = (index: number) => new Promise<void>(resolve => { arrived[index] = resolve; });
  try {
    await play.wait(/thinking=false/);
    play.child.stdin.write('npc step\n');
    await play.wait(/action=move/);
    const second = waitHit(1);
    play.child.stdin.write('npc step\n');
    await second;
    assert.equal(play.stdout().includes('NO_FOOD'), false);
    play.child.stdin.write('player move kitchen\nplayer eat\n');
    await play.wait(/player eat accepted/);
    assert.equal(play.stdout().includes('NO_FOOD'), false);
    const held = pending.find(item => item.index === 1);
    assert.ok(held);
    held.end('{"type":"eat"}');
    await play.wait(/NO_FOOD/);
    const third = waitHit(2);
    play.child.stdin.write('npc step\n');
    await third;
    pending.find(item => item.index === 2)?.end('{"type":"stop"}');
    await play.wait(/action=stop/);
    play.child.stdin.write('quit\n');
    const result = await play.done();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(hits, 3);
    assert.equal(result.stdout.includes('sekret-play'), false);
    const saved = result.stdout.match(/quit saved=(\S+)/);
    assert.ok(saved);
    const game = JSON.parse(readFileSync(join(saved[1], 'game.json'), 'utf8'));
    assert.equal(game.goalReached, false);
    assert.equal(game.outcome, 'stopped');
    assert.equal(game.finalState.npcs.npc_a.hunger, 40);
    assert.equal(game.finalState.npcs.npc_b.hunger, 50);
    assert.equal(game.thinking, false);
    const labels = game.commands.map((entry: { role: string; command: { type: string; actorId: string; commandId: string }; exec: { reason?: string; seq: number } }) =>
      `${entry.role}:${entry.command.actorId}:${entry.command.type}:${entry.exec.reason ?? 'ok'}`);
    assert.deepEqual(labels, [
      'npc:npc_a:move:ok',
      'player:npc_b:move:ok',
      'player:npc_b:eat:ok',
      'npc:npc_a:eat:NO_FOOD',
    ]);
    assert.deepEqual(replay(game.initialState, game.events), game.finalState);
    const text = readFileSync(join(saved[1], 'commands.json'), 'utf8') + readFileSync(join(saved[1], 'steps.json'), 'utf8');
    assert.equal(text.includes('sekret-play'), false);
    assert.equal(text.includes(`http://127.0.0.1:${port}`), false);
  } finally {
    if (play.child.exitCode === null) play.child.kill('SIGKILL');
    await close(server);
  }
});

test('quit rejects new commands and waits out the current step before saving', async () => {
  let release: (() => void) | undefined;
  let hits = 0;
  const arrived = new Promise<void>(resolve => {
    release = resolve;
  });
  let respond: (body: string) => void = () => {};
  const server = createServer((req, res) => {
    hits += 1;
    req.on('data', () => undefined);
    req.on('end', () => {
      respond = (body: string) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: body } }] }));
      };
      release?.();
    });
  });
  const port = await listen(server);
  const dir = mkdtempSync(join(tmpdir(), 'frostecho-play-quit-'));
  const play = startPlay(['--live'], childEnv({
    FROSTECHO_LLM_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
    FROSTECHO_LLM_MODEL: 'live-model',
    FROSTECHO_G02_ARTIFACT_DIR: dir,
  }));
  let code: number | null = null;
  play.child.on('close', value => { code = value; });
  try {
    await play.wait(/commands:/);
    play.child.stdin.write('npc step\nquit\nplayer eat\n');
    await arrived;
    await play.wait(/rejected closed/);
    assert.equal(code, null);
    assert.equal(hits, 1);
    respond('{"type":"stop"}');
    const result = await play.done();
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(hits, 1);
    const saved = result.stdout.match(/quit saved=(\S+)/);
    assert.ok(saved);
    const game = JSON.parse(readFileSync(join(saved[1], 'game.json'), 'utf8'));
    assert.equal(game.commands.length, 0);
    assert.equal(game.finalState.food.kitchen, 1);
    assert.equal(game.finalState.npcs.npc_a.hunger, 40);
    assert.equal(game.outcome, 'stopped');
    assert.equal(game.goalReached, false);
    assert.equal(game.thinking, true);
  } finally {
    if (play.child.exitCode === null) play.child.kill('SIGKILL');
    await close(server);
  }
});
