/**
 * G08-R1 worker B — CLI configuration binding, failure evidence, exit codes.
 *
 * Every case spawns the real dist/scripts/play-g08.js as a subprocess against
 * a local fake HTTP endpoint, exactly like the frozen cli-probe: the process
 * exit code, the requests the endpoint saw, and the files on disk are the
 * only witnesses.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { slotChecksum } from '../src/persistence/atomic-slot';

// dist/tests/<this file>.js → dist/scripts/play-g08.js
const CLI = resolve(__dirname, '../scripts/play-g08.js');

interface FakeEndpoint {
  url: string;
  requests: { model?: unknown; thinking?: unknown }[];
  close(): Promise<void>;
}

type Mode = 'ok' | 'error';

async function startEndpoint(mode: Mode = 'ok'): Promise<FakeEndpoint> {
  const requests: FakeEndpoint['requests'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      let body: { model?: unknown; chat_template_kwargs?: { enable_thinking?: unknown } } = {};
      try { body = JSON.parse(raw) as typeof body; } catch { /* keep {} */ }
      requests.push({ model: body.model, thinking: body.chat_template_kwargs?.enable_thinking });
      res.setHeader('content-type', 'application/json');
      if (mode === 'error') {
        res.statusCode = 500;
        res.end('{"error":"boom"}');
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"type":"stop"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolveClose, reject) => server.close(err => (err ? reject(err) : resolveClose()))),
  };
}

interface RunResult { code: number; stdout: string; stderr: string }

function runCli(root: string, args: string[], endpoint: FakeEndpoint | null, model: string): Promise<RunResult> {
  return new Promise<RunResult>((resolveRun) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (endpoint !== null) env.FROSTECHO_LLM_URL = endpoint.url;
    env.FROSTECHO_LLM_MODEL = model;
    const child = spawn(process.execPath, [CLI, '--root', root, ...args], { cwd: resolve(__dirname, '../..'), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('close', code => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

function statusOf(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return {};
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-cli-'));
}

test('a live slot saves its model and refuses to load under another model (exit 2, zero requests)', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('ok');
  try {
    const created = await runCli(root, ['--slot', 'live-seed', '--new', '--live', '--actions', 'timed_wait', '--step', '1', '--save'], endpoint, 'model-alpha');
    assert.equal(created.code, 0, created.stderr);
    const saved = JSON.parse(readFileSync(join(root, 'live-seed.g08.json'), 'utf8')) as {
      payload: { effectiveConfig: { mode: string; requestModel: string; thinking: boolean; timeoutMs: number }; game: { mode: string; requestModel: string; timeoutMs: number; thinking: boolean } };
    };
    assert.equal(saved.payload.effectiveConfig.mode, 'live');
    assert.equal(saved.payload.effectiveConfig.requestModel, 'model-alpha');
    assert.equal(saved.payload.effectiveConfig.timeoutMs, 120000);
    assert.equal(saved.payload.effectiveConfig.thinking, true);
    // The game record and the envelope describe the same runtime.
    assert.equal(saved.payload.game.requestModel, 'model-alpha');
    assert.equal(saved.payload.game.timeoutMs, 120000);
    assert.equal(saved.payload.game.mode, 'live');
    assert.equal(saved.payload.game.thinking, true);

    const before = endpoint.requests.length;
    const changed = await runCli(root, ['--slot', 'live-seed', '--load', '--live', '--actions', 'timed_wait', '--time', '1', '--step', '1'], endpoint, 'model-beta');
    assert.equal(changed.code, 2, changed.stderr);
    assert.match(changed.stderr, /model-beta|model-alpha/);
    assert.equal(endpoint.requests.length, before, 'a model conflict must not touch the endpoint');
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live slot will not silently load with the script provider (exit 2, zero requests)', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('ok');
  try {
    const created = await runCli(root, ['--slot', 'live-seed', '--new', '--live', '--actions', 'timed_wait', '--step', '1', '--save'], endpoint, 'model-alpha');
    assert.equal(created.code, 0, created.stderr);
    const before = endpoint.requests.length;
    const asScript = await runCli(root, ['--slot', 'live-seed', '--load', '--actions', 'timed_wait', '--time', '1', '--step', '1'], endpoint, 'model-alpha');
    assert.equal(asScript.code, 2, asScript.stderr);
    assert.match(asScript.stderr, /--live/);
    assert.equal(endpoint.requests.length, before);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a reference slot refuses a --live upgrade (exit 2)', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('ok');
  try {
    const created = await runCli(root, ['--slot', 'script-seed', '--new', '--actions', 'legacy', '--script', 'npc_a=stop', '--step', '1', '--save'], null, '');
    assert.equal(created.code, 0, created.stderr);
    const upgraded = await runCli(root, ['--slot', 'script-seed', '--load', '--live'], endpoint, 'model-alpha');
    assert.equal(upgraded.code, 2, upgraded.stderr);
    assert.equal(endpoint.requests.length, 0);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an HTTP 500 on --step exits 1, writes failure evidence, and never saves the slot', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('error');
  try {
    const failed = await runCli(root, ['--slot', 'error-step', '--new', '--live', '--actions', 'timed_wait', '--step', '1', '--save'], endpoint, 'model-alpha');
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(existsSync(join(root, 'error-step.g08.json')), false, 'a failed run must not write the slot');
    const failureDir = join(root, 'failures', 'error-step');
    assert.ok(existsSync(failureDir), 'failure evidence directory must exist');
    const files = readdirSync(failureDir);
    assert.equal(files.length, 1);
    const record = JSON.parse(readFileSync(join(failureDir, files[0]), 'utf8')) as { schema: string; kind: string; slot: string };
    assert.equal(record.schema, 'frostecho.g08.run-failure/1');
    assert.match(record.kind, /interrupted-step/);
    assert.equal(record.slot, 'error-step');
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an HTTP 500 on --run exits 1, writes evidence, and never saves the slot', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('error');
  try {
    const failed = await runCli(root, ['--slot', 'error-run', '--new', '--live', '--actions', 'timed_wait', '--run', '--save'], endpoint, 'model-alpha');
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(existsSync(join(root, 'error-run.g08.json')), false, 'a failed run must not write the slot');
    assert.ok(existsSync(join(root, 'failures', 'error-run')), 'failure evidence must be written');
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the printed totalCalls equals the authoritative record on disk', async () => {
  const root = tempRoot();
  try {
    const ran = await runCli(root, ['--slot', 'run-count', '--new', '--actions', 'legacy', '--script', 'npc_a=stop', '--script', 'npc_c=stop', '--run', '--save'], null, '');
    assert.equal(ran.code, 0, ran.stderr);
    const printed = Number(statusOf(ran.stdout).totalCalls);
    const saved = JSON.parse(readFileSync(join(root, 'run-count.g08.json'), 'utf8')) as { payload: { game: { totalCalls: number } } };
    assert.equal(printed, 2);
    assert.equal(printed, saved.payload.game.totalCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pre-R1 envelope without effectiveConfig is refused at load (never migrated)', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('ok');
  try {
    const created = await runCli(root, ['--slot', 'old', '--new', '--actions', 'legacy', '--script', 'npc_a=stop', '--step', '1', '--save'], null, '');
    assert.equal(created.code, 0, created.stderr);
    const file = join(root, 'old.g08.json');
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { sha256: string; payload: Record<string, unknown> };
    delete envelope.payload.effectiveConfig;
    // Re-seal so the test reaches the semantic check, not the checksum gate.
    envelope.sha256 = slotChecksum(envelope.payload);
    writeFileSync(file, JSON.stringify(envelope, null, 2));
    const loaded = await runCli(root, ['--slot', 'old', '--load'], endpoint, '');
    assert.equal(loaded.code, 1, loaded.stderr);
    assert.match(loaded.stderr, /effectiveConfig|SCHEMA_MISMATCH/);
    assert.equal(endpoint.requests.length, 0);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});
