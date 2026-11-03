/**
 * G08 closeout worker C — a resumed slot must run with the SAVED configuration,
 * and a transport failure must leave real evidence (authoritative record,
 * session error, HTTP status and body) without touching the input slot.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createNeedsGame, buildNeedsWorld } from '../src/needs/game';
import { createMailbox } from '../src/communication/mailbox';
import { loadG08Checkpoint, restoreG08Game, saveG08Checkpoint } from '../src/temporal/checkpoint';

const CLI = resolve(__dirname, '../scripts/play-g08.js');

interface Endpoint {
  url: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

async function startEndpoint(mode: 'ok' | 'error'): Promise<Endpoint> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET') {
        if (req.url === '/health') { res.statusCode = 200; res.end('ok'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'model-alpha' }] }));
        return;
      }
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('CODEX_FAKE_HTTP500_CAUSE');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"type":"stop"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>(done => server.close(() => done())),
  };
}

interface RunResult { code: number; stdout: string; stderr: string }

function runCli(root: string, args: string[], endpoint: Endpoint, model = 'model-alpha'): Promise<RunResult> {
  return new Promise(done => {
    const child = spawn(process.execPath, [CLI, '--root', root, ...args], {
      env: { ...process.env, FROSTECHO_LLM_URL: endpoint.url, FROSTECHO_LLM_MODEL: model },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => done({ code: code ?? -1, stdout, stderr }));
  });
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-cli-c-'));
}

/** A valid slot created through the PUBLIC api with non-default values. */
function seedSavedSlot(root: string): { file: string; before: string } {
  const config = { mode: 'live' as const, requestModel: 'model-alpha', thinking: false, timeoutMs: 777 };
  const game = createNeedsGame({
    episodeId: 'closeout-saved-config',
    initialState: buildNeedsWorld({ kitchenFood: 3, hunger: { npc_a: 40, npc_c: 40 } }),
    providerFor: () => ({ decide: async () => '{"type":"stop"}' }),
    mode: 'live',
    requestModel: 'model-alpha',
    thinking: false,
    timeoutMs: 777,
    needPolicy: 'recurring',
    actionSet: 'timed_wait',
  });
  const saved = saveG08Checkpoint(root, 'saved-false', game, createMailbox(), 'timed_wait', 'off', config);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const file = join(root, 'saved-false.g08.json');
  return { file, before: readFileSync(file, 'utf8') };
}

test('a loaded slot runs with the SAVED thinking=false and keeps the saved timeout', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('ok');
  try {
    const { file, before } = seedSavedSlot(root);
    const loaded = await runCli(root, ['--slot', 'saved-false', '--load', '--live', '--actions', 'timed_wait', '--step', '1'], endpoint);
    assert.equal(loaded.code, 0, loaded.stderr);
    assert.equal(endpoint.requests.length, 1);
    const body = endpoint.requests[0] as {
      model?: unknown;
      chat_template_kwargs?: { enable_thinking?: unknown };
    };
    // The actual request must honour the saved config, not a hardcoded default.
    assert.equal(body.chat_template_kwargs?.enable_thinking, false);
    assert.equal(body.model, 'model-alpha');
    // The input slot is byte-identical after a read-only run.
    assert.equal(readFileSync(file, 'utf8'), before);
    // The restored game carries the saved 777 timeout (not a fresh default).
    const envelope = loadG08Checkpoint(file);
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    if (!envelope.ok) return;
    const restored = restoreG08Game(envelope.value, {
      providerFor: () => ({ decide: async () => '{"type":"stop"}' }),
      actionSet: 'timed_wait',
      messageMode: 'off',
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    if (!restored.ok) return;
    const snapshot = (restored.value as unknown as { snapshot(): { requestConfig: { timeoutMs: number } } }).snapshot();
    assert.equal(snapshot.requestConfig.timeoutMs, 777);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an HTTP 500 on --step exits 1 with the raw cause, the HTTP status and the failure state', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('error');
  try {
    const failed = await runCli(root, ['--slot', 'failed-step', '--new', '--live', '--actions', 'timed_wait', '--step', '1', '--save'], endpoint);
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(existsSync(join(root, 'failed-step.g08.json')), false, 'a failed run must not write the slot');
    const dir = join(root, 'failures', 'failed-step');
    assert.ok(existsSync(dir), 'failure evidence must be written');
    const files = readdirSync(dir).filter(name => name.endsWith('.json'));
    assert.ok(files.length > 0);
    const evidence = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, unknown>;
    assert.equal(evidence.schema, 'frostecho.g08.run-failure/2');
    // The real cause (the HTTP body) and the status survive.
    assert.ok(JSON.stringify(evidence).includes('CODEX_FAKE_HTTP500_CAUSE'));
    const errors = evidence.errors as { error?: string; transport?: { status?: number | null } }[];
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error, 'http 500');
    assert.equal(errors[0]?.transport?.status, 500);
    // The authoritative state is present: the actor failed, the config is known.
    const status = evidence.status as { actors?: Record<string, { state?: string }>; interrupted?: boolean };
    assert.equal(status.interrupted, true);
    assert.equal(status.actors?.npc_a?.state, 'failed');
    // A new live game: thinking on, the frozen wired timeout.
    assert.deepEqual(evidence.config, { mode: 'live', requestModel: 'model-alpha', thinking: true, timeoutMs: 120000 });
    assert.equal(evidence.actionSet, 'timed_wait');
    assert.deepEqual(evidence.actions, { step: 1, run: false, time: null, restock: null, move: null });
    // The record itself is persisted so the failure is replayable evidence.
    assert.ok(evidence.record !== null && evidence.record !== undefined);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an HTTP 500 on --run exits 1 through the same finalize', async () => {
  const root = tempRoot();
  const endpoint = await startEndpoint('error');
  try {
    const failed = await runCli(root, ['--slot', 'failed-run', '--new', '--live', '--actions', 'timed_wait', '--run'], endpoint);
    assert.equal(failed.code, 1, failed.stderr);
    const dir = join(root, 'failures', 'failed-run');
    const files = readdirSync(dir).filter(name => name.endsWith('.json'));
    assert.ok(files.length > 0);
    const evidence = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, unknown>;
    assert.ok(JSON.stringify(evidence).includes('CODEX_FAKE_HTTP500_CAUSE'));
    assert.equal((evidence.actions as { run: boolean }).run, true);
    assert.equal(existsSync(join(root, 'failed-run.g08.json')), false);
  } finally {
    await endpoint.close();
    rmSync(root, { recursive: true, force: true });
  }
});
