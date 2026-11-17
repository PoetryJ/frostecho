/**
 * G05-live workstream D — independent subprocess guards against a fake HTTP
 * server. Nothing here imports the live batch plumbing; the CLI is spawned for
 * real (build first, node --test runs against dist/).
 *
 * cap 1 → at most 1 POST and a budget stop with non-zero exit; cap 4 on the ac
 * head → 4 requests, 4×11=44 tokens, zero-usage mode → usageUnknownCount and
 * totalTokens=null; HTTP 500 / timeout → complete records on disk, non-zero
 * exit; the same batch name exits 2 without touching a byte; ca-only live is
 * rejected; zero-call trajectories actually ran (events/commands on disk).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const CLI = resolve('dist/scripts/eval-g05.js');

interface FakeOptions {
  model?: string;
  delayMs?: number;
  status?: number;
  includeUsage?: boolean;
}

interface FakeServer {
  url: string;
  requests: { at: number; body: unknown }[];
  close(): Promise<void>;
}

async function startFake(options: FakeOptions = {}): Promise<FakeServer> {
  const model = options.model ?? 'fake-g05-model';
  const delayMs = options.delayMs ?? 0;
  const status = options.status ?? 200;
  const includeUsage = options.includeUsage ?? true;
  const requests: { at: number; body: unknown }[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        requests.push({ at: Date.now(), body: JSON.parse(raw) });
        setTimeout(() => {
          if (status !== 200) {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
          }
          const body = JSON.parse(raw) as { messages: { content: string }[] };
          const match = /observation: (\{.*\})/.exec(body.messages[0].content);
          assert.ok(match !== null, 'prompt carries an observation line');
          const observation = JSON.parse(match[1]) as { hunger: number; location: string; foodHere: number };
          const action = observation.hunger >= 70 ? '{"type":"stop"}'
            : observation.location !== 'kitchen' ? '{"type":"move","to":"kitchen"}'
            : observation.foodHere > 0 ? '{"type":"eat"}'
            : '{"type":"stop"}';
          const payload: Record<string, unknown> = { choices: [{ message: { content: action } }] };
          if (includeUsage) payload.usage = { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        }, delayMs);
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
    requests,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

interface CliOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runEvalAsync(args: string[], env: Record<string, string>): Promise<CliOutcome> {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c; });
  child.stderr.on('data', (c: Buffer) => { stderr += c; });
  const code = await new Promise<number | null>(r => child.on('close', c => r(c)));
  return { code, stdout, stderr };
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

test('cap 1: at most one POST, budget stop, non-zero exit, ledger complete', async () => {
  const fake = await startFake();
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' };
  try {
    const out = await runEvalAsync(['--live', '--out', root, '--batch', 'cap1', '--max-calls', '1', '--chain', 'ac'], env);
    assert.equal(out.code, 1, `${out.stdout}\n${out.stderr}`);
    assert.equal(fake.requests.length, 1, `exactly one POST, got ${fake.requests.length}`);
    const dir = join(root, 'cap1');
    const summary = readJson(join(dir, 'summary.json')) as { totals: { httpAttempts: number; budgetBlocked: number; episodes: number } };
    assert.equal(summary.totals.httpAttempts, 1);
    assert.equal(summary.totals.budgetBlocked >= 1, true);
    assert.equal(summary.totals.episodes, 2, 'the zero-call episode plus the interrupted one are both on disk');
    const attempts = readdirSync(join(dir, 'attempts'));
    assert.ok(attempts.some(f => f === 'att-0001.begin.json'));
    assert.ok(attempts.some(f => f === 'att-0001.finish.json'));
    assert.ok(attempts.some(f => f.startsWith('blocked-')));
    const interrupted = readdirSync(join(dir, 'episodes')).map(name => {
      const record = readJson(join(dir, 'episodes', name, 'game.json')) as { episodeId: string; stopReason: string };
      return record;
    }).find(r => r.stopReason === 'interrupted');
    assert.ok(interrupted !== undefined, 'the budget-stopped episode is persisted');
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cap 4 on the ac head: 4 requests, 4×11=44 tokens, then a clean budget stop', async () => {
  const fake = await startFake();
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' };
  try {
    const out = await runEvalAsync(['--live', '--out', root, '--batch', 'cap4', '--max-calls', '4', '--chain', 'ac'], env);
    // t1/recurring spends exactly 4 (a clean judge), then t3/recurring is
    // denied its first request: the batch stops with a budget stop (exit 1).
    assert.equal(out.code, 1, `${out.stdout}\n${out.stderr}`);
    assert.equal(fake.requests.length, 4);
    const summary = readJson(join(root, 'cap4', 'summary.json')) as { totals: { httpAttempts: number; knownTokenSum: number; usageUnknownCount: number; totalTokens: number | null; episodes: number; scenarioPass: number; budgetBlocked: number } };
    assert.equal(summary.totals.httpAttempts, 4);
    assert.equal(summary.totals.knownTokenSum, 44);
    assert.equal(summary.totals.usageUnknownCount, 0);
    assert.equal(summary.totals.totalTokens, 44);
    assert.equal(summary.totals.episodes, 6);
    assert.equal(summary.totals.scenarioPass, 5, 'five pass; the budget-stopped t3/recurring is the sixth');
    assert.ok(summary.totals.budgetBlocked >= 1);
    // Zero-call trajectories really ran: their episode records carry events and commands.
    let zeroCallChecked = 0;
    for (const name of readdirSync(join(root, 'cap4', 'episodes'))) {
      const record = readJson(join(root, 'cap4', 'episodes', name, 'game.json')) as { events: unknown[]; commands: unknown[] };
      assert.ok(record.events.length > 0 && record.commands.length > 0, `${name} has world activity`);
      zeroCallChecked += 1;
    }
    assert.equal(zeroCallChecked, 6);
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing usage: usageUnknownCount counts, totalTokens=null', async () => {
  const fake = await startFake({ includeUsage: false });
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' };
  try {
    const out = await runEvalAsync(['--live', '--out', root, '--batch', 'noUsage', '--max-calls', '4', '--chain', 'ac'], env);
    assert.equal(out.code, 1); // same budget stop as cap4; the assertions below are about usage
    const summary = readJson(join(root, 'noUsage', 'summary.json')) as { totals: { usageUnknownCount: number; totalTokens: number | null } };
    assert.equal(summary.totals.usageUnknownCount, 4);
    assert.equal(summary.totals.totalTokens, null);
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP 500: first real request fails, episode persisted, non-zero exit', async () => {
  const fake = await startFake({ status: 500 });
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' };
  try {
    const out = await runEvalAsync(['--live', '--out', root, '--batch', 'http500', '--max-calls', '60', '--chain', 'ac'], env);
    assert.equal(out.code, 1);
    const finish = readJson(join(root, 'http500', 'attempts', 'att-0001.finish.json')) as { outcome: string; status: number | null };
    assert.equal(finish.outcome, 'http_error');
    assert.equal(finish.status, 500);
    const episodes = readdirSync(join(root, 'http500', 'episodes')).map(n => readJson(join(root, 'http500', 'episodes', n, 'game.json')) as { episodeId: string; stopReason: string });
    assert.equal(episodes.length, 2, 'the zero-call head plus the failed one');
    assert.ok(episodes.some(r => r.stopReason === 'interrupted'));
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout: the request is ledgered as timeout and the batch stops', async () => {
  const fake = await startFake({ delayMs: 500 });
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' };
  try {
    const out = await runEvalAsync(['--live', '--out', root, '--batch', 'slow', '--max-calls', '60', '--timeout', '200', '--chain', 'ac'], env);
    assert.equal(out.code, 1);
    const finish = readJson(join(root, 'slow', 'attempts', 'att-0001.finish.json')) as { outcome: string };
    assert.equal(finish.outcome, 'timeout');
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same batch name exits 2 and leaves every old byte untouched', async () => {
  const fake = await startFake();
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model', FROSTECHO_LIVE_TIMEOUT_MS: '60000' };
  try {
    const first = await runEvalAsync(['--live', '--out', root, '--batch', 'dupname', '--max-calls', '4', '--chain', 'ac'], env);
    assert.equal(first.code, 1); // budget stop on t3/recurring; the batch itself is complete
    const summaryPath = join(root, 'dupname', 'summary.json');
    const before = readFileSync(summaryPath, 'utf8');
    const second = await runEvalAsync(['--live', '--out', root, '--batch', 'dupname', '--max-calls', '4', '--chain', 'ac'], env);
    assert.equal(second.code, 2, `${second.stdout}\n${second.stderr}`);
    assert.ok(second.stderr.includes('cannot be created'), 'the refusal explains itself');
    assert.equal(readFileSync(summaryPath, 'utf8'), before);
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ca-only live is rejected before anything runs', async () => {
  const fake = await startFake();
  const root = mkdtempSync(join(tmpdir(), 'g05-guard-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: 'fake-g05-model' };
  try {
    const out = await runEvalAsync(['--live', '--out', root, '--batch', 'caonly', '--chain', 'ca'], env);
    assert.equal(out.code, 2);
    assert.equal(fake.requests.length, 0);
    assert.equal(existsSync(join(root, 'caonly')), false, 'nothing was created');
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});
