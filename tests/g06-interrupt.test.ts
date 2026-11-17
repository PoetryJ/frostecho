/**
 * G06 worker D — real subprocess interruption of the G05 live runner.
 *
 * A fake HTTP server accepts the first model request and then never answers.
 * Once the attempt's begin record is durably on disk, the child is SIGKILLed —
 * a genuine crash mid-request, not an in-process simulation. Assertions:
 *   - begin without finish stays an unresolved attempt (conservatively spent);
 *   - rebuilding the summary from disk reports unresolvedAttempts=1,
 *     httpAttempts=0 and totalTokens=null (the G06 correction: an in-flight
 *     request's unknown cost must not be reported as a confident number);
 *   - episodes that finished before the crash are intact on disk;
 *   - verification of the crashed batch exits non-zero — never a success.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { rebuildSummary } from '../src/needs/eval';

const EVAL_G05 = resolve('dist/scripts/eval-g05.js');

async function startHangingServer(): Promise<{ url: string; posts: number; close: () => Promise<void> }> {
  let posts = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-g06-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      posts += 1;
      req.on('data', () => undefined);
      // Never respond: the request hangs until the child is killed.
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    get posts() { return posts; },
    close: () => new Promise<void>(r => server.close(() => r())),
  } as { url: string; posts: number; close: () => Promise<void> };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

test('SIGKILL mid-request: unresolved attempt kept, totalTokens=null, crashed batch verifies non-zero', async () => {
  const server = await startHangingServer();
  const root = mkdtempSync(join(tmpdir(), 'g06-kill-'));
  const batch = 'intr';
  const dir = join(root, batch);
  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, [EVAL_G05, '--live', '--out', root, '--batch', batch, '--max-calls', '4', '--chain', 'ac'], {
      env: { ...process.env, FROSTECHO_LLM_URL: server.url, FROSTECHO_LLM_MODEL: 'fake-g06-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' },
    });
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', () => undefined);
    const beginSeen = await waitFor(() => existsSync(join(dir, 'attempts', 'att-0001.begin.json')), 30_000);
    assert.equal(beginSeen, true, 'the first attempt begin record landed on disk');
    // Give the HTTP request a beat to actually reach the server.
    await waitFor(() => server.posts >= 1, 5_000);
    assert.equal(server.posts, 1, 'exactly one request is in flight');
    child.kill('SIGKILL');
    await new Promise<void>(r => { child?.on('close', () => r()); });
    child = null;

    const attempts = readdirSync(join(dir, 'attempts'));
    assert.ok(attempts.includes('att-0001.begin.json'));
    assert.equal(attempts.some(f => f === 'att-0001.finish.json'), false, 'no finish was ever written');

    const summary = rebuildSummary(dir, batch, 'live', { limit: 4, spent: 1, blocked: 0 }, [], 0) as {
      totals: {
        episodes: number;
        httpAttempts: number;
        unresolvedAttempts: number;
        knownTokenSum: number;
        usageUnknownCount: number;
        totalTokens: number | null;
      };
    };
    assert.equal(summary.totals.unresolvedAttempts, 1, 'the in-flight request stays unresolved, not dropped');
    assert.equal(summary.totals.httpAttempts, 0, 'no finished attempt exists');
    assert.equal(summary.totals.knownTokenSum, 0);
    assert.equal(summary.totals.usageUnknownCount, 0);
    assert.equal(summary.totals.totalTokens, null, 'G06 correction: unresolved poisons the confident token total');
    assert.ok(summary.totals.episodes >= 1, 'the zero-call episode finished before the crash is intact');
    const episodes = readdirSync(join(dir, 'episodes'));
    assert.ok(episodes.length >= 1);
    for (const name of episodes) {
      const record = JSON.parse(readFileSync(join(dir, 'episodes', name, 'game.json'), 'utf8')) as { stopReason: string; commands: unknown[] };
      assert.ok(record.commands.length > 0, `${name} is a complete record`);
    }

    // Verification of the crashed batch must not report success.
    const verify = spawn(process.execPath, [EVAL_G05, '--verify', '--out', root, '--batch', batch]);
    let stderr = '';
    verify.stderr.on('data', (c: Buffer) => { stderr += c; });
    verify.stdout.on('data', () => undefined);
    const code = await new Promise<number | null>(r => verify.on('close', c => r(c)));
    assert.notEqual(code, 0, `a crashed batch must never verify as success (stderr: ${stderr})`);
  } finally {
    child?.kill('SIGKILL');
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
