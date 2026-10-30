/** Workstream D — acceptance tests for the reliable G02 harness. Offline: fake servers on 127.0.0.1 only. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse, createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { HTTP_SAMPLING } from '../src/agent';
import { HealthCheck, TaskRecord, checkLlmHealth, classifyTransport, createBatchStore, readTasks } from '../src/eval';
import { planG02, runG02Eval, verifyG02Batch } from '../src/play';

const MODEL = 'qwen-fake';
const okHealth: HealthCheck = async config => ({
  ok: true, checkedAt: '1970-01-01T00:00:00.000Z', modelsUrlPath: '/v1/models', status: 200, models: [config.model],
  expectedModel: config.model, modelMatch: true, kind: null, error: null, latencyMs: 0,
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g02-rel-'));
}

function actionFor(prompt: string): string {
  const line = prompt.split('\n').find(item => item.startsWith('observation: '));
  if (!line) return '{"type":"stop"}';
  const o = JSON.parse(line.slice('observation: '.length)) as { hunger: number; location: string; foodHere: number };
  if (o.hunger >= 70) return '{"type":"stop"}';
  if (o.location !== 'kitchen') return '{"type":"move","to":"kitchen"}';
  if (o.foodHere > 0) return '{"type":"eat"}';
  return '{"type":"stop"}';
}

interface FakeOpts {
  /** Called per chat request (1-based). Return 'ok', 'drop' (destroy socket), 'hang', or 'no-usage'. */
  behave?: (n: number) => 'ok' | 'drop' | 'hang' | 'no-usage';
  models?: string[];
}

async function fakeServer(opts: FakeOpts = {}) {
  const thinking: boolean[] = [];
  let chat = 0;
  let health = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      health += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: (opts.models ?? [MODEL]).map(id => ({ id })) }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      chat += 1;
      const mode = opts.behave?.(chat) ?? 'ok';
      if (mode === 'drop') { req.socket.destroy(); return; }
      if (mode === 'hang') return;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      thinking.push(body.chat_template_kwargs.enable_thinking);
      const payload: Record<string, unknown> = { choices: [{ message: { content: actionFor(body.messages[0].content) } }] };
      if (mode === 'ok') payload.usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    thinking,
    get chat() { return chat; },
    get health() { return health; },
    async close() { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); },
  };
}

function env(url: string) {
  return { FROSTECHO_LLM_URL: url, FROSTECHO_LLM_MODEL: MODEL };
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p).toString('base64'));
    }
  };
  walk(dir);
  return out;
}

test('transport classification separates infrastructure kinds and the local budget', () => {
  assert.equal(classifyTransport('network error: ECONNREFUSED'), 'connect');
  assert.equal(classifyTransport('timeout'), 'timeout');
  assert.equal(classifyTransport('http 503'), 'http_5xx');
  assert.equal(classifyTransport('http 404'), 'http_4xx');
  assert.equal(classifyTransport('invalid response json'), 'invalid_json');
  assert.equal(classifyTransport('missing message content'), 'missing_content');
  assert.equal(classifyTransport('provider call cap'), 'budget');
  assert.equal(classifyTransport('NO_FOOD'), null);
});

test('health check confirms the served model via an injected fetch without network', async () => {
  const fetchImpl: typeof fetch = async input => {
    assert.match(String(input), /\/v1\/models$/);
    return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
  };
  const ok = await checkLlmHealth({ url: 'http://fixture.invalid/v1/chat/completions', model: 'm1' }, { fetchImpl });
  assert.equal(ok.ok, true);
  const bad = await checkLlmHealth({ url: 'http://fixture.invalid/v1/chat/completions', model: 'm2' }, { fetchImpl });
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'model_mismatch');
  const down = await checkLlmHealth({ url: 'http://fixture.invalid/v1/chat/completions', model: 'm1' }, {
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
  });
  assert.equal(down.kind, 'connect');
});

test('health failure (wrong model) sends zero chat requests and marks every task not_run', async () => {
  const srv = await fakeServer({ models: ['other-model'] });
  const root = tempDir();
  try {
    const out = await runG02Eval({ mode: 'live', root, batchId: 'health-bad', env: env(srv.url), fetchImpl: globalThis.fetch });
    assert.equal(out.exitCode, 2);
    assert.equal(srv.chat, 0);
    assert.equal(srv.health, 1);
    assert.equal(out.summary.stopReason, 'health_failed');
    const tasks = readTasks(join(root, 'health-bad'));
    assert.equal(tasks.length, 18);
    assert.ok(tasks.every(t => t.status === 'not_run' && t.notRunReason === 'health_failed'));
  } finally { await srv.close(); }
});

test('6 successful requests then a dropped 7th connection ends the batch; finished games stay, the rest are not_run', async () => {
  const srv = await fakeServer({ behave: n => (n >= 7 ? 'drop' : 'ok') });
  const root = tempDir();
  try {
    const out = await runG02Eval({ mode: 'live', root, batchId: 'drop7', env: env(srv.url), fetchImpl: globalThis.fetch, now: () => 0 });
    assert.equal(out.exitCode, 1);
    assert.equal(srv.chat, 7, 'no retry after the failure');
    assert.equal(out.summary.stopReason, 'infrastructure_interrupt');
    const tasks = readTasks(join(root, 'drop7'));
    assert.equal(tasks.length, 18);
    const cut = tasks.findIndex(t => t.status === 'interrupted');
    assert.ok(cut > 0);
    assert.equal(tasks[cut].interruptKind, 'connect');
    assert.ok(tasks.slice(0, cut).every(t => t.status === 'pass'));
    assert.ok(tasks.slice(cut + 1).every(t => t.status === 'not_run' && t.notRunReason === 'interrupted_earlier'));
    assert.equal(out.summary.httpRequests, 7);
    assert.equal(out.summary.requestCount, 7);
    assert.equal(tasks.slice(0, cut + 1).reduce((n, t) => n + t.counters.httpRequests, 0), 7);
    // the interrupted game's evidence (including errors seen before the interrupt) is kept
    const game = JSON.parse(readFileSync(join(root, 'drop7', tasks[cut].trace.gameDir!, 'game.json'), 'utf8'));
    assert.equal(game.outcome, 'provider_error');
    assert.equal(tasks[cut].counters.usage.unknownRequests, 1);
    assert.deepEqual(out.summary.rebuilt.issues, []);
    assert.equal(verifyG02Batch(join(root, 'drop7')).ok, true);
  } finally { await srv.close(); }
});

test('a second start with the same batch name is rejected before any request and old files stay byte-identical', async () => {
  const root = tempDir();
  const first = await runG02Eval({ mode: 'fixture', root, batchId: 'dup', now: () => 0 });
  assert.equal(first.exitCode, 0);
  const before = snapshot(join(root, 'dup'));
  let hits = 0;
  const fetchImpl: typeof fetch = async () => { hits += 1; return new Response('{}', { status: 500 }); };
  const second = await runG02Eval({ mode: 'live', root, batchId: 'dup', env: env('http://fixture.invalid/v1/chat/completions'), fetchImpl });
  assert.equal(second.exitCode, 2);
  assert.equal(hits, 0);
  assert.match(second.summary.notes.join('\n'), /batch store refused: exists/);
  assert.deepEqual(snapshot(join(root, 'dup')), before);
  for (const bad of ['../escape', 'a/b', '..', '']) {
    const out = await runG02Eval({ mode: 'live', root, batchId: bad, env: env('http://fixture.invalid/v1/chat/completions'), fetchImpl });
    assert.equal(out.exitCode, 2, bad);
  }
  assert.equal(hits, 0);
  assert.throws(() => createBatchStore(root, 'dup'), /already exists/);
  const store = createBatchStore(root, 'fresh');
  store.writeJson('x.json', 1);
  assert.throws(() => store.writeJson('x.json', 2), /refusing to overwrite/);
  assert.throws(() => store.writeJson('../y.json', 2), /escapes/);
});

test('budget 1: HTTP, global and group request counts are all 1 and the intercept is separate', async () => {
  const srv = await fakeServer();
  const root = tempDir();
  try {
    const out = await runG02Eval({ mode: 'live', root, batchId: 'budget1', env: env(srv.url), fetchImpl: globalThis.fetch, maxCalls: 1 });
    assert.equal(srv.chat, 1);
    assert.equal(out.summary.httpRequests, 1);
    assert.equal(out.summary.requestCount, 1);
    assert.equal(out.summary.byThinking.true.requestCount, 1);
    assert.equal(out.summary.byThinking.true.httpRequests, 1);
    assert.equal(out.summary.byThinking.false.requestCount, 0);
    assert.equal(out.summary.budgetIntercepts, 1);
    assert.equal(out.summary.decisionCalls, 2);
    assert.equal(out.summary.callCapExceeded, true);
    assert.equal(out.summary.stopReason, 'budget');
    assert.equal(out.exitCode, 1);
    const row = out.summary.rebuilt.combinations.find(r => r.scenarioId === 's1' && r.thinking)!;
    assert.equal(row.counters.httpRequests, 1);
    assert.equal(row.interrupted, 1);
    assert.equal(out.summary.rebuilt.byStatus.not_run, 17);
    assert.deepEqual(out.summary.rebuilt.issues, []);
  } finally { await srv.close(); }
});

test('missing usage and a timeout are counted as unknown usage, never as 0 confirmed tokens', async () => {
  const srv = await fakeServer({ behave: n => (n === 1 ? 'no-usage' : 'hang') });
  const root = tempDir();
  try {
    const out = await runG02Eval({
      mode: 'live', root, batchId: 'usage', env: env(srv.url), fetchImpl: globalThis.fetch, timeoutMs: 300,
      scenarios: ['s1'], reps: 1, thinkingValues: [true],
    });
    assert.equal(out.summary.httpRequests, 2);
    assert.equal(out.summary.byThinking.true.usageKnownRequests, 0);
    assert.equal(out.summary.byThinking.true.usageUnknownRequests, 2);
    assert.equal(out.summary.rebuilt.interrupted[0].kind, 'timeout');
    assert.equal(out.exitCode, 1);
  } finally { await srv.close(); }
});

test('tampered summary or game evidence fails verification', async () => {
  const root = tempDir();
  const out = await runG02Eval({ mode: 'fixture', root, batchId: 'tamper', now: () => 0 });
  const dir = join(root, 'tamper');
  assert.equal(verifyG02Batch(dir).ok, true);
  const path = join(dir, 'summary.json');
  const original = readFileSync(path, 'utf8');
  const s = JSON.parse(original);
  s.requestCount = 41;
  writeFileSync(path, JSON.stringify(s));
  assert.equal(verifyG02Batch(dir).ok, false);
  writeFileSync(path, original);
  const gamePath = join(dir, 'games', 's2-thinking-on-rep-1', 'game.json');
  const game = JSON.parse(readFileSync(gamePath, 'utf8'));
  game.scenarioPass = false;
  writeFileSync(gamePath, JSON.stringify(game));
  const v = verifyG02Batch(dir);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some(i => i.includes('s2-thinking-on-rep-1')));
  assert.equal(out.exitCode, 0);
});

test('paired order alternates thinking on/off per scenario and rep, and gate is rep 1', async () => {
  const plan = planG02(['s1', 's2', 's3'], 3, [true, false]);
  assert.deepEqual(plan.slice(0, 6).map(t => t.taskId), [
    's1-thinking-on-rep-1', 's1-thinking-off-rep-1', 's2-thinking-on-rep-1', 's2-thinking-off-rep-1', 's3-thinking-on-rep-1', 's3-thinking-off-rep-1',
  ]);
  assert.ok(plan.slice(0, 6).every(t => t.phase === 'gate'));
  assert.ok(plan.slice(6).every(t => t.phase === 'main'));
  assert.deepEqual(plan.map(t => t.thinking), Array.from({ length: 18 }, (_, i) => i % 2 === 0));
  const srv = await fakeServer();
  const root = tempDir();
  try {
    const out = await runG02Eval({ mode: 'live', root, batchId: 'paired', env: env(srv.url), fetchImpl: globalThis.fetch });
    assert.equal(out.exitCode, 0, JSON.stringify(out.summary.rebuilt.issues));
    assert.equal(srv.chat, 42);
    const tasks = readTasks(join(root, 'paired'));
    assert.deepEqual(tasks.map(t => t.thinking), plan.map(t => t.thinking));
    const fromTasks = tasks.flatMap(t => Array(t.counters.httpRequests).fill(t.thinking));
    assert.deepEqual(srv.thinking, fromTasks);
    assert.equal(out.summary.errors.execute, 0);
    assert.equal(out.summary.errors.s3ExpectedNoFood, 6);
    assert.equal(out.summary.gate.passed, true);
    for (const row of out.summary.rebuilt.combinations) assert.deepEqual([row.valid, row.pass, row.interrupted, row.notRun], [3, 3, 0, 0]);
    assert.equal(out.summary.byThinking.true.totalTokens + out.summary.byThinking.false.totalTokens, 42 * 15);
  } finally { await srv.close(); }
});

test('a behavior failure in the gate stops before reps 2..3 and is not an infrastructure interrupt', async () => {
  const root = tempDir();
  const out = await runG02Eval({
    mode: 'fixture', root, batchId: 'gate-fail',
    providerFactory: () => ({ decide: async () => '{"type":"stop"}' }),
  });
  assert.equal(out.exitCode, 1);
  assert.equal(out.summary.stopReason, 'gate_failed');
  assert.equal(out.summary.gate.passed, false);
  const tasks = readTasks(join(root, 'gate-fail'));
  assert.ok(tasks.slice(0, 6).every((t: TaskRecord) => t.status === 'pass' || t.status === 'behavior_fail'));
  assert.ok(tasks.slice(0, 6).some((t: TaskRecord) => t.status === 'behavior_fail'));
  assert.ok(tasks.slice(6).every((t: TaskRecord) => t.status === 'not_run' && t.notRunReason === 'gate_failed'));
  assert.equal(out.summary.rebuilt.byStatus.interrupted, 0);
});

test('batch metadata records version, fingerprints, sampling, timeouts and start/end', async () => {
  const root = tempDir();
  await runG02Eval({ mode: 'fixture', root, batchId: 'meta' });
  const batch = JSON.parse(readFileSync(join(root, 'meta', 'batch.json'), 'utf8'));
  const end = JSON.parse(readFileSync(join(root, 'meta', 'end.json'), 'utf8'));
  assert.ok(batch.version.commit === null || /^[0-9a-f]{40}$/.test(batch.version.commit));
  assert.ok(batch.version.dirty === null || typeof batch.version.dirty === 'boolean');
  assert.match(batch.version.sourceFingerprint, /^[0-9a-f]{64}$/);
  assert.match(batch.version.promptFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(batch.sampling.temperature, HTTP_SAMPLING.temperature);
  assert.equal(batch.sampling.productionEnableThinking, true);
  assert.equal(batch.timeouts.decisionMs, 30000);
  assert.equal(batch.autoRestartService, false);
  assert.equal(batch.plan.length, 18);
  assert.ok(Date.parse(batch.startedAt) <= Date.parse(end.endedAt));
  assert.equal(end.success, true);
});
