/**
 * G05-R1 workstream D — the same 12-trajectory matrix over a fake HTTP server.
 *
 * The fake server reimplements the reference policy from the prompt's
 * observation line (no production scenario/judge imports). It must receive
 * exactly 20 chat requests for the whole matrix, each with the frozen sampling
 * configuration, with at most one request in flight; the recorded metadata must
 * equal the actual request bodies. Also covers timeout priority plumbing.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runLiveBatch } from '../src/needs/eval';
import { verifyNeedsBatch } from '../src/needs/record';
import type { G05ScenarioRecord } from '../src/needs/scenarios';

interface SeenRequest {
  body: Record<string, unknown>;
  at: number;
}

interface FakeServer {
  server: Server;
  url: string;
  seen: SeenRequest[];
  maxInFlight: () => number;
  close: () => Promise<void>;
}

/** Reference policy, re-derived from CONTRACTS (not imported from scenarios). */
function policyFromPrompt(prompt: string): string {
  const match = /observation: (\{.*\})/.exec(prompt);
  assert.ok(match !== null, 'prompt carries an observation line');
  const observation = JSON.parse(match[1]) as { hunger: number; location: string; foodHere: number };
  if (observation.hunger >= 70) return '{"type":"stop"}';
  if (observation.location !== 'kitchen') return '{"type":"move","to":"kitchen"}';
  if (observation.foodHere > 0) return '{"type":"eat"}';
  return '{"type":"stop"}';
}

async function startFake(model: string): Promise<FakeServer> {
  const seen: SeenRequest[] = [];
  let inFlight = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ body, at: Date.now() });
        const messages = body.messages as { role: string; content: string }[];
        const action = policyFromPrompt(messages[0].content);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: action } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }));
        inFlight -= 1;
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    seen,
    maxInFlight: () => peak,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  };
}

test('fakeHTTP: the full matrix spends exactly 20 requests with frozen per-request config', async () => {
  const model = 'fake-g05-model';
  const fake = await startFake(model);
  const root = mkdtempSync(join(tmpdir(), 'g05-fakehttp-'));
  const env = { FROSTECHO_LLM_URL: fake.url, FROSTECHO_LLM_MODEL: model, FROSTECHO_LIVE_TIMEOUT_MS: '120000' };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const result = await runLiveBatch({ artifactsRoot: root, batchId: 'fakehttp', maxTotalCalls: 60 });
    assert.equal(result.aborted, undefined, `batch aborted: ${result.aborted ?? ''}`);
    assert.equal(result.scenarioPass, 12, result.runs.filter(r => !r.scenarioPass).map(r => `${r.scenario.id}: ${r.issues.join('; ')}`).join(' | '));
    assert.equal(fake.seen.length, 20, `the matrix must cost exactly 20 chat requests, got ${fake.seen.length}`);
    assert.equal(result.summary.totals.httpCalls, 20);
    assert.equal(result.summary.totals.decisionAttempts, 20, 'decision attempts come from the saved episode records');
    assert.ok(fake.maxInFlight() <= 1, 'at most one request in flight');
    for (const { body } of fake.seen) {
      assert.equal(body.model, model);
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 1024);
      assert.equal(body.stream, false);
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    }
    // Metadata equals the actual bodies and the effective timeout.
    for (const run of result.runs) {
      const record: G05ScenarioRecord = run.record;
      assert.equal(record.requestConfig.model, model);
      assert.equal(record.requestConfig.timeoutMs, 120000);
      assert.deepEqual(record.requestConfig.enableThinking, [true]);
      assert.equal(record.mode, 'live');
      assert.ok(record.replayMatches);
    }
    assert.notEqual(result.summary.promptFingerprint, 'unknown', 'a live batch binds the prompt fingerprint');
    const verification = verifyNeedsBatch(join(root, 'fakehttp'));
    assert.ok(verification.ok, verification.issues.join('; '));
    assert.equal(verification.httpCalls, 20);
  } finally {
    process.env = previous;
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('fakeHTTP: health precheck failure stops before any chat request', async () => {
  // Point at a closed port: no server, no requests, aborted with not_run everything.
  const root = mkdtempSync(join(tmpdir(), 'g05-fakehttp-'));
  const previous = { ...process.env };
  process.env.FROSTECHO_LLM_URL = 'http://127.0.0.1:9/v1/chat/completions';
  process.env.FROSTECHO_LLM_MODEL = 'unused';
  try {
    const result = await runLiveBatch({ artifactsRoot: root, batchId: 'dead', maxTotalCalls: 60 });
    assert.ok(result.aborted !== undefined && result.aborted.includes('health'));
    assert.equal(result.runs.length, 0);
    assert.equal(result.totalCalls, 0);
  } finally {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fakeHTTP: HTTP 500 interrupts the batch and keeps the failure on disk', async () => {
  const model = 'fake-g05-model';
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const root = mkdtempSync(join(tmpdir(), 'g05-fakehttp-'));
  const previous = { ...process.env };
  process.env.FROSTECHO_LLM_URL = `http://127.0.0.1:${port}/v1/chat/completions`;
  process.env.FROSTECHO_LLM_MODEL = model;
  try {
    const result = await runLiveBatch({ artifactsRoot: root, batchId: 'http500', maxTotalCalls: 60 });
    assert.ok(result.aborted !== undefined, 'a transport failure aborts the batch');
    assert.equal(result.summary.totals.notRun > 0, true, 'remaining trajectories are not_run');
    // ac/t1/one-shot passes with zero requests first; the recurring trajectory
    // then interrupts on its first chat request and is persisted as such.
    assert.equal(result.runs.length, 2);
    assert.equal(result.runs[0].scenario.id, 'ac/t1/one-shot');
    assert.equal(result.runs[0].record.stopReason !== 'interrupted', true);
    assert.equal(result.runs[1].record.stopReason, 'interrupted');
  } finally {
    process.env = previous;
    await new Promise<void>(r => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});
