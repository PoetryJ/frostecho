/**
 * G03-R1 regression (D) — the interactive CLI as a real child process.
 *
 * Old defect: `rl.on('close', () => process.exit(0))` exited 0 without saving
 * on EOF, and an interrupted episode also exited 0. Now every termination path
 * goes through one finalize(): exactly one record, exit 0 for a normal end,
 * 1 for interrupted/failed, 2 for missing configuration.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const CLI = resolve('dist/scripts/play-g03.js');

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

async function runCli(args: string[], input: string, env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  const outDir = mkdtempSync(join(tmpdir(), 'g03-cli-'));
  const child = spawn(process.execPath, [CLI, '--out', outDir, '--episode', 'ep', ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(input);
  const code = await new Promise<number | null>(resolveExit => child.on('exit', c => resolveExit(c)));
  return { code, stdout, stderr, outDir };
}

const savedLines = (stdout: string): number => stdout.split('\n').filter(line => line.startsWith('saved ')).length;

function readSaved(outDir: string): { record: Record<string, unknown>; files: string[] } {
  const files = readdirSync(outDir);
  assert.equal(files.length, 1, `expected exactly one episode directory, got ${files.join(',')}`);
  const gameFile = join(outDir, files[0], 'game.json');
  assert.ok(existsSync(gameFile), 'game.json must be saved');
  return { record: JSON.parse(readFileSync(gameFile, 'utf8')), files: readdirSync(outDir) };
}

function chatServer(text: () => { status: number; body: string } | 'hang'): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
      return;
    }
    const answer = text();
    if (answer === 'hang') return; // never responds: the client must time out
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
  assert.equal(readdirSync(run.outDir).length, 0, 'nothing to save without a game');
  rmSync(run.outDir, { recursive: true, force: true });
});

test('normal reference run saves exactly once and exits 0', async () => {
  const run = await runCli([], 'run\nquit\n');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(savedLines(run.stdout), 1, run.stdout);
  const { record } = readSaved(run.outDir);
  // quit lands while the background run is still in flight: user_closed is correct.
  assert.ok(['completed', 'user_closed'].includes(String(record.stopReason)), String(record.stopReason));
  rmSync(run.outDir, { recursive: true, force: true });
});

test('EOF without quit still saves exactly once and exits 0', async () => {
  const run = await runCli([], 'run\n');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(savedLines(run.stdout), 1, run.stdout);
  const { record } = readSaved(run.outDir);
  assert.ok(['completed', 'user_closed'].includes(String(record.stopReason)), String(record.stopReason));
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
