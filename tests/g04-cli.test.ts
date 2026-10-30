/**
 * G04 workstream B — the lifecycle CLI as a real child process.
 *
 * Covers the contract points that only a subprocess can prove: one finalize
 * path that persists exactly once (quit / EOF / interrupted), exit 0 on a
 * normal end, 1 on HTTP failure or timeout, 2 on missing configuration, a
 * restock after idle re-pumping the scheduler, legacy never waking, and
 * `status` issuing no provider request at all.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifyReactiveEpisode } from '../src/reactive/record';
import type { ReactiveRecord } from '../src/reactive/contracts';

const CLI = resolve('dist/scripts/play-g04.js');

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

async function runCli(args: string[], input: string, env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return runCliSteps(args, [{ line: input }], env);
}

/**
 * Feed lines one at a time. When `until` is set, wait for that marker to appear
 * before writing the next line, so a test can observe "idle, then restock"
 * instead of racing an in-flight run (the CLI is meant to accept both).
 */
async function runCliSteps(
  args: string[],
  steps: { line: string; until?: string }[],
  env: NodeJS.ProcessEnv = {},
): Promise<CliRun> {
  const outDir = mkdtempSync(join(tmpdir(), 'g04-cli-'));
  const child = spawn(process.execPath, [CLI, '--out', outDir, '--episode', 'ep', ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let seen = 0;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const waitFor = async (marker: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const next = stdout.indexOf(marker, seen);
      if (next >= 0) { seen = next + marker.length; return; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(marker)}\n${stdout}`);
      await new Promise(r => setTimeout(r, 10));
    }
  };
  for (const step of steps) {
    child.stdin.write(step.line);
    if (step.until !== undefined) await waitFor(step.until);
  }
  child.stdin.end();
  const code = await new Promise<number | null>(resolveExit => child.on('exit', c => resolveExit(c)));
  return { code, stdout, stderr, outDir };
}

const savedLines = (stdout: string): number => stdout.split('\n').filter(line => line.includes('saved ') && !line.includes('[save]')).length;

function readSaved(outDir: string): { record: ReactiveRecord; dir: string; verification: ReturnType<typeof verifyReactiveEpisode> } {
  const episodeDir = join(outDir, 'ep', 'episodes', 'ep');
  const gameFile = join(episodeDir, 'game.json');
  assert.ok(existsSync(gameFile), `game.json must be saved under ${episodeDir}`);
  const record = JSON.parse(readFileSync(gameFile, 'utf8')) as ReactiveRecord;
  return { record, dir: episodeDir, verification: verifyReactiveEpisode(episodeDir) };
}

const totalCalls = (record: ReactiveRecord): number => Object.values(record.actors).reduce((sum, actor) => sum + actor.providerCalls, 0);

function chatServer(handler: () => { status: number; body: string } | 'hang', counter?: { chats: number }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
      return;
    }
    if (counter) counter.chats += 1;
    const answer = handler();
    if (answer === 'hang') return;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  return new Promise(resolveListen => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolveListen({ server, url: `http://127.0.0.1:${address.port}/v1/chat/completions` });
    });
  });
}

test('missing live configuration exits 2 and names both environment variables', async () => {
  const run = await runCli(['--live'], 'quit\n', { FROSTECHO_LLM_URL: '', FROSTECHO_LLM_MODEL: '' });
  assert.equal(run.code, 2, run.stdout);
  assert.ok(run.stderr.includes('FROSTECHO_LLM_URL') && run.stderr.includes('FROSTECHO_LLM_MODEL'), run.stderr);
  assert.deepEqual(readdirSync(run.outDir), [], 'nothing to save without a game');
  rmSync(run.outDir, { recursive: true, force: true });
});

test('reference event run saves once, exits 0, and both NPCs wait on an empty kitchen', async () => {
  const run = await runCli([], 'run\nquit\n');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedLines(run.stdout), 1, run.stdout);
  const { record, verification } = readSaved(run.outDir);
  assert.equal(record.wakePolicy, 'event');
  assert.equal(record.thinking, true);
  assert.equal(verification.ok, true, verification.issues.join('; '));
  assert.equal(totalCalls(record), 2);
  assert.equal(record.actors.npc_a.providerCalls, 1);
  assert.equal(record.actors.npc_c.providerCalls, 1);
  for (const id of ['npc_a', 'npc_c']) {
    assert.equal(record.actors[id].goalReached, false);
    assert.equal(record.finalState.npcs[id].hunger, 40);
    const transitions = record.transitions.filter(t => t.actorId === id);
    assert.equal(transitions.at(-1)?.to, 'waiting', `${id} must be waiting, not stopped`);
  }
  assert.equal(record.finalState.food.kitchen, 0);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('a restock after idle wakes both NPCs under the event policy', async () => {
  const run = await runCliSteps([], [
    { line: 'run\n', until: '[run idle]' },
    { line: 'world restock kitchen 2\n', until: '[world accepted]' },
    { line: 'run\n', until: '[run idle]' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedLines(run.stdout), 1, run.stdout);
  const { record, verification } = readSaved(run.outDir);
  assert.equal(verification.ok, true, verification.issues.join('; '));
  assert.equal(totalCalls(record), 4);
  for (const id of ['npc_a', 'npc_c']) {
    assert.equal(record.finalState.npcs[id].hunger, 70);
    assert.equal(record.actors[id].state, 'satisfied');
    assert.equal(record.actors[id].cycles, 2, `${id} needs a second cycle`);
  }
  assert.equal(record.finalState.food.kitchen, 0);
  assert.equal(record.replayMatches, true);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('the legacy policy never wakes a stopped NPC after a restock', async () => {
  const run = await runCliSteps(['--policy', 'legacy'], [
    { line: 'run\n', until: '[run idle]' },
    { line: 'world restock kitchen 2\n', until: '[world accepted]' },
    { line: 'run\n', until: '[run idle]' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record, verification } = readSaved(run.outDir);
  assert.equal(verification.ok, true, verification.issues.join('; '));
  assert.equal(totalCalls(record), 2);
  for (const id of ['npc_a', 'npc_c']) {
    assert.equal(record.finalState.npcs[id].hunger, 40);
    assert.equal(record.actors[id].cycles, 1);
    assert.equal(record.actors[id].state, 'stopped');
  }
  assert.equal(record.finalState.food.kitchen, 2, 'the restock itself still lands');
  rmSync(run.outDir, { recursive: true, force: true });
});

test('an out-of-range restock is rejected and leaves the world unchanged', async () => {
  const run = await runCliSteps([], [
    { line: 'run\n', until: '[run idle]' },
    { line: 'world restock kitchen 99\n', until: '[world rejected]' },
    { line: 'world restock dorm 0\n', until: '[world rejected]' },
    { line: 'quit\n' },
  ]);
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  const { record } = readSaved(run.outDir);
  assert.equal(record.finalState.food.kitchen, 0);
  assert.equal(record.finalState.food.dorm, 0);
  // Rejected commands are still in the world ledger; none may be accepted.
  assert.equal(record.commands.some(entry => entry.command.type === 'restock' && entry.result.status === 'accepted'), false);
  assert.equal((run.stdout.match(/\[world rejected\]/g) ?? []).length, 2, run.stdout);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('EOF without quit still saves exactly once and exits 0', async () => {
  const run = await runCli([], 'run\n');
  assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(savedLines(run.stdout), 1, run.stdout);
  const { record } = readSaved(run.outDir);
  assert.ok(['completed', 'user_closed'].includes(record.stopReason), record.stopReason);
  rmSync(run.outDir, { recursive: true, force: true });
});

test('HTTP 500 exits 1 and still persists one interrupted record', async () => {
  const { server, url } = await chatServer(() => ({ status: 500, body: JSON.stringify({ error: 'boom' }) }));
  try {
    const run = await runCli(['--live'], 'run\nquit\n', { FROSTECHO_LLM_URL: url, FROSTECHO_LLM_MODEL: 'qwen3.8-27b' });
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
    assert.equal(savedLines(run.stdout), 1, run.stdout);
    const { record } = readSaved(run.outDir);
    assert.equal(record.stopReason, 'interrupted');
    assert.equal(record.mode, 'live');
    rmSync(run.outDir, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test('HTTP timeout exits 1 and still persists one interrupted record', async () => {
  const { server, url } = await chatServer(() => 'hang');
  try {
    const run = await runCli(['--live', '--timeout', '300'], 'run\nquit\n', { FROSTECHO_LLM_URL: url, FROSTECHO_LLM_MODEL: 'qwen3.8-27b' });
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
    assert.equal(savedLines(run.stdout), 1, run.stdout);
    const { record } = readSaved(run.outDir);
    assert.equal(record.stopReason, 'interrupted');
    rmSync(run.outDir, { recursive: true, force: true });
  } finally {
    server.close();
  }
});

test('status only reads: a live session issues no chat request for status, and quit saves', async () => {
  const counter = { chats: 0 };
  const { server, url } = await chatServer(() => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"type":"stop"}' } }] }) }), counter);
  try {
    const run = await runCliSteps(['--live'], [
      { line: 'status\n', until: 'commands=' },
      { line: 'status\n', until: 'commands=' },
      { line: 'quit\n' },
    ], { FROSTECHO_LLM_URL: url, FROSTECHO_LLM_MODEL: 'qwen3.8-27b' });
    assert.equal(run.code, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(counter.chats, 0, 'status must not call the model');
    assert.equal(savedLines(run.stdout), 1, run.stdout);
    const { record } = readSaved(run.outDir);
    assert.equal(totalCalls(record), 0);
    assert.equal(record.stopReason, 'user_closed');
    rmSync(run.outDir, { recursive: true, force: true });
  } finally {
    server.close();
  }
});
