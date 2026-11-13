/**
 * G11-live resume: the ONE-SHOT, PREFLIGHT and WATCHDOG contract of the
 * orchestrator (worker B), tested as a black box against an offline
 * OpenAI-compatible server. No real service, no real budget is touched.
 *
 * What is pinned here:
 *   - a failed precheck spends ZERO posts and never creates a ledger;
 *   - every invocation keeps its OWN exclusive preflight record (never overwritten);
 *   - a batch starts exactly once (run-start.json, `wx`), a second run is exit 2;
 *   - the watchdog deadline is DERIVED (2 x request + settle), so a legal phase
 *     that needs more than the old fixed 180s budget still completes, while a
 *     really stuck phase is killed and the batch stops without a retry;
 *   - verify is read-only: it changes no byte and writes no file into the batch.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const DRIVER = join(process.cwd(), 'dist/scripts/g11-live.js');
const MODEL = 'qwen3.8-27b';

/* ------------------------------------------------------------------ */
/* offline OpenAI-compatible server                                    */
/* ------------------------------------------------------------------ */

interface FakeServer {
  url: string;
  posts: { body: string; answer: string }[];
  close(): Promise<void>;
}

interface FakeOptions {
  /** The model id GET /v1/models advertises. */
  served?: string;
  /** The status GET /health answers. */
  health?: number;
  /** Delay before each POST answer, so a watchdog can be measured. */
  delayMs?: number;
}

async function fakeOpenAi(options: FakeOptions = {}): Promise<FakeServer> {
  const served = options.served ?? MODEL;
  const health = options.health ?? 200;
  const delayMs = options.delayMs ?? 0;
  const posts: { body: string; answer: string }[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET') {
        if (request.url?.startsWith('/health')) {
          response.writeHead(health, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: health === 200 ? 'ok' : 'down' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: served }] }));
        return;
      }
      const index = posts.length;
      const answer = body.includes('feed_self')
        ? '{"goal":"yield_once"}'
        : body.includes('yield_once')
          ? '{"type":"wait"}'
          : '{"type":"eat"}';
      posts.push({ body, answer });
      const answerNow = (): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: `chatcmpl-resume-${String(index + 1)}`, object: 'chat.completion', created: 1, model: served,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
      };
      if (delayMs === 0) answerNow();
      else setTimeout(answerNow, delayMs);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`,
    posts,
    close: () => new Promise((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

interface CliRun { code: number; stdout: string; stderr: string }

function cli(entry: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

interface Batch { base: string; batch: string; campaign: string }

async function prepare(server: FakeServer, limit = 8): Promise<Batch> {
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-resume-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  const prepared = await cli(DRIVER, ['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', MODEL, '--limit', String(limit)]);
  assert.equal(prepared.code, 0, `prepare failed: ${prepared.stderr}`);
  return { base, batch, campaign };
}

const runArgs = (b: Batch, server: FakeServer): string[] =>
  ['run', '--batch', b.batch, '--campaign', b.campaign, '--http', server.url, '--model', MODEL];

/** Recursive content hash of a directory: name + bytes, order-independent. */
function dirHash(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else lines.push(`${relative(root, path)}:${sha256(readFileSync(path))}`);
    }
  };
  walk(root);
  return sha256(lines.sort().join('\n'));
}

const ledgerOf = (b: Batch): Record<string, any> | null =>
  existsSync(join(b.campaign, 'campaign.json')) ? readJson(join(b.campaign, 'campaign.json')) : null;

/* ------------------------------------------------------------------ */
/* preflight: zero posts, zero ledger, one exclusive record per call   */
/* ------------------------------------------------------------------ */

test('a wrong model stops at preflight with ZERO posts and no ledger', async () => {
  const server = await fakeOpenAi({ served: 'some-other-model' });
  try {
    const b = await prepare(server);
    const planBefore = sha256(readFileSync(join(b.batch, 'plan.json')));
    const run = await cli(DRIVER, runArgs(b, server));
    assert.equal(run.code, 3, `a precheck failure is offline_ready(3), got ${String(run.code)}: ${run.stderr.slice(-300)}`);
    assert.equal(server.posts.length, 0, 'preflight must not send a chat request');
    assert.equal(existsSync(b.campaign), false, 'no campaign directory may be created before a valid preflight');
    const report = JSON.parse(run.stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1)!) as Record<string, any>;
    assert.equal(report.classification, 'offline_ready');
    assert.equal(report.posts, 0);
    assert.equal(report.gets, 2, 'exactly the two preflight GETs');
    const preflight = readJson(report.preflightPath as string);
    assert.equal(preflight.chatRequests, 0);
    assert.equal(preflight.gets, 2);
    assert.equal(preflight.ok, false);
    assert.equal(preflight.models.modelMatch, false);
    assert.equal(preflight.health.ok, true, '/health answered 200, only the model list disagreed');
    assert.equal(sha256(readFileSync(join(b.batch, 'plan.json'))), planBefore, 'plan.json bytes are never rewritten');
    assert.equal(existsSync(join(b.batch, 'offline-ready.json')), false, 'the driver no longer forges an offline record');
  } finally {
    await server.close();
  }
});

test('a 503 /health stops at preflight with ZERO posts', async () => {
  const server = await fakeOpenAi({ health: 503 });
  try {
    const b = await prepare(server);
    const run = await cli(DRIVER, runArgs(b, server));
    assert.equal(run.code, 3, `a bad /health is offline_ready(3): ${run.stderr.slice(-300)}`);
    assert.equal(server.posts.length, 0);
    assert.equal(existsSync(join(b.campaign, 'campaign.json')), false);
    const report = JSON.parse(run.stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1)!) as Record<string, any>;
    assert.equal(report.classification, 'offline_ready');
    const preflight = readJson(report.preflightPath as string);
    assert.equal(preflight.health.status, 503);
    assert.equal(preflight.health.ok, false);
    assert.equal(preflight.models.ok, true, 'the model list itself was fine; /health alone closed the gate');
  } finally {
    await server.close();
  }
});

test('every invocation keeps its OWN preflight record and never overwrites one', async () => {
  const server = await fakeOpenAi({ served: 'some-other-model' });
  try {
    const b = await prepare(server);
    const first = await cli(DRIVER, runArgs(b, server));
    assert.equal(first.code, 3);
    const firstPath = join(b.batch, 'preflight-001.json');
    assert.equal(existsSync(firstPath), true, 'the first invocation owns preflight-001.json');
    const firstBytes = readFileSync(firstPath);

    const second = await cli(DRIVER, runArgs(b, server));
    assert.equal(second.code, 3, 'a second failed preflight still reports offline_ready');
    const secondPath = join(b.batch, 'preflight-002.json');
    assert.equal(existsSync(secondPath), true, 'the second invocation numbers its own record');
    assert.equal(readFileSync(firstPath).equals(firstBytes), true, 'the earlier record is never overwritten');
    assert.notEqual(readJson(secondPath).at, readJson(firstPath).at, 'the records are distinct attempts');
    assert.equal(readdirSync(b.batch).filter(name => name.startsWith('preflight-')).length, 2);
    assert.equal(existsSync(join(b.batch, 'run-start.json')), false, 'a failed preflight never marks the batch started');
    assert.equal(server.posts.length, 0);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* one shot: one start marker, one spend                               */
/* ------------------------------------------------------------------ */

test('a batch starts exactly once: the second run is refused with no extra spend', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server);
    const first = await cli(DRIVER, runArgs(b, server));
    assert.equal(first.code, 0, `a legal batch must close its gate: ${first.stderr.slice(-300)} stdout ${first.stdout.slice(-300)}`);
    assert.equal(server.posts.length, 8);
    const startPath = join(b.batch, 'run-start.json');
    assert.equal(existsSync(startPath), true, 'the start marker is written before any chat request');
    const startBytes = readFileSync(startPath);
    const ledgerBefore = ledgerOf(b)!;
    assert.equal(ledgerBefore.spent, 8);

    const second = await cli(DRIVER, runArgs(b, server));
    assert.equal(second.code, 2, `an already-started batch is a config error(2), got ${String(second.code)}`);
    assert.match(second.stderr, /already started/);
    assert.equal(server.posts.length, 8, 'a refused second run spends nothing');
    assert.equal(ledgerOf(b)!.spent, 8, 'the ledger is untouched');
    assert.equal(readFileSync(startPath).equals(startBytes), true, 'the start marker is never rewritten');
  } finally {
    await server.close();
  }
});

test('run-start.json freezes the code head, the plan bytes and every effective setting', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server);
    const run = await cli(DRIVER, runArgs(b, server));
    assert.equal(run.code, 0, `expected a closing run: ${run.stderr.slice(-300)}`);
    const start = readJson(join(b.batch, 'run-start.json'));
    assert.match(String(start.codeHead), /^[0-9a-f]{40}$/, 'the actual code head is recorded, not a placeholder');
    assert.equal(start.planSha256, sha256(readFileSync(join(b.batch, 'plan.json'))), 'planSha256 is the plan bytes');
    assert.deepEqual(start.authorization.totalPosts, 8);
    assert.deepEqual(start.authorization.maxPostsPerScene, 4);
    assert.deepEqual(start.effective.sampling, { temperature: 0, maxTokens: 1024, stream: false, thinking: true });
    assert.equal(start.effective.requestTimeoutMs, 120000, 'the production single-request timeout is 120s');
    assert.equal(start.effective.watchdog.requestsPerPhase, 2);
    assert.equal(start.effective.watchdog.settleMs, 30000);
    assert.equal(start.effective.watchdog.phaseMs, 270000, 'the deadline is DERIVED: 2 x 120000 + 30000, not the old 180000');
    assert.equal(start.effective.watchdog.source, 'default');
    assert.equal(existsSync(start.preflightPath as string), true, 'the start marker names a real preflight record');
    assert.deepEqual(start.sceneOrder, ['W1', 'W2']);
    assert.equal(start.campaignSpentBefore, 0);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* watchdog: derived, not fixed                                        */
/* ------------------------------------------------------------------ */

test('a legal phase that needs more than 2 x request timeout still completes (settle margin)', async () => {
  // Two answers of 700ms each = 1400ms of pure request time per phase, i.e. more
  // than 2 x 600 = 1200ms. A deadline derived WITHOUT the settle margin would
  // kill a legal phase; with it (2 x 600 + 4000 = 5200ms) the phase survives.
  const server = await fakeOpenAi({ delayMs: 700 });
  try {
    const b = await prepare(server);
    const run = await cli(DRIVER, runArgs(b, server), { FROSTECHO_G11_REQUEST_TIMEOUT_MS: '600', FROSTECHO_G11_WATCHDOG_SETTLE_MS: '4000' });
    const scene = readJson(join(b.batch, 'scene-W1.json'));
    assert.equal(scene.exit.prefix.killedByWatchdog, false, `a legal slow phase must not be killed: ${String(scene.exit.prefix.stderrTail)}`);
    assert.equal(scene.exit.prefix.watchdogMs, 5200, 'the effective deadline is recorded in the exit facts');
    assert.equal(scene.prefix.classification, 'goal_triggered');
    assert.equal(run.code, 0, `the batch must still close: ${run.stderr.slice(-300)}`);
    const start = readJson(join(b.batch, 'run-start.json'));
    assert.equal(start.effective.watchdog.source, 'injected');
    assert.equal(start.effective.requestTimeoutMs, 600);
    assert.equal(start.effective.watchdog.phaseMs, 5200);
  } finally {
    await server.close();
  }
});

test('a stuck phase is killed by the watchdog, recorded, and never retried', async () => {
  const server = await fakeOpenAi({ delayMs: 700 });
  try {
    const b = await prepare(server);
    const run = await cli(DRIVER, runArgs(b, server), { FROSTECHO_G11_REQUEST_TIMEOUT_MS: '150', FROSTECHO_G11_WATCHDOG_SETTLE_MS: '1' });
    assert.notEqual(run.code, 0, 'a killed phase cannot close the gate');
    assert.ok(server.posts.length <= 2, `no post beyond the killed phase, got ${String(server.posts.length)}`);
    const scene = readJson(join(b.batch, 'scene-W1.json'));
    assert.equal(scene.exit.prefix.killedByWatchdog, true, 'the kill is recorded as a fact');
    assert.equal(scene.exit.prefix.watchdogMs, 301);
    assert.equal(scene.prefix.classification, 'technical_failure', 'a killed child falls back to technical_failure');
    assert.match(JSON.stringify(scene.prefix.reasons), /watchdog/);
    assert.equal(existsSync(join(b.batch, 'scene-W2.json')), false, 'a failed scene stops the batch, W2 never starts');
    // The already-reserved attempt is preserved, never silently released.
    const ledger = ledgerOf(b);
    assert.notEqual(ledger, null, 'a reserved attempt keeps its ledger evidence');
    assert.equal(ledger!.spent, 1);
    assert.equal(ledger!.attempts.length, 1);
    assert.equal(ledger!.attempts[0].state, 'reserved', 'the interrupted attempt stays reserved for the auditor');
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* verify is read-only                                                 */
/* ------------------------------------------------------------------ */

test('verify changes no byte of the batch or the campaign', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server);
    const run = await cli(DRIVER, runArgs(b, server));
    assert.equal(run.code, 0, `expected a closing run: ${run.stderr.slice(-300)}`);
    const batchBefore = dirHash(b.batch);
    const campaignBefore = dirHash(b.campaign);
    const out = join(b.base, 'handoff', 'verify.json');
    const verified = await cli(DRIVER, ['verify', '--batch', b.batch, '--campaign', b.campaign, '--out', out]);
    assert.equal(verified.code, 0, `verify must agree with the run: ${verified.stdout.slice(-300)}`);
    assert.equal(dirHash(b.batch), batchBefore, 'verify writes nothing into the batch');
    assert.equal(dirHash(b.campaign), campaignBefore, 'verify writes nothing into the campaign');
    assert.equal(existsSync(join(b.batch, 'verify.json')), false, 'the historical batch/verify.json is not produced');
    assert.equal(existsSync(out), true, 'the handoff copy is written only where --out says');
    const report = readJson(out);
    assert.equal(report.ok, true);
    assert.equal(report.evidenceOk, true);
    assert.equal(report.complete, true);
    assert.deepEqual(report.issues, []);
  } finally {
    await server.close();
  }
});

test('a batch with only plan + offline-ready verifies as offline_ready without creating anything', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-offline-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  mkdirSync(batch, { recursive: true });
  writeFileSync(join(batch, 'plan.json'), `${JSON.stringify({
    schema: 'frostecho.g11-live.plan/1',
    at: '2026-11-06T00:00:00.000Z',
    batchDir: batch,
    campaignDir: campaign,
    service: { http: 'http://127.0.0.1:1/v1/chat/completions', model: MODEL },
    promptVersion: 3,
    config: {},
    authorization: { totalPosts: 8, maxPostsPerScene: 4, sceneOrder: ['W1', 'W2'] },
  }, null, 2)}\n`);
  writeFileSync(join(batch, 'offline-ready.json'), `${JSON.stringify({
    schema: 'frostecho.g11-live.offline-ready/1',
    classification: 'offline_ready',
    reasons: ['the service was unreachable'],
  }, null, 2)}\n`);
  const before = dirHash(batch);
  const out = join(base, 'verify.json');
  const verified = await cli(DRIVER, ['verify', '--batch', batch, '--campaign', campaign, '--out', out]);
  assert.equal(verified.code, 1, 'offline_ready is not a completion');
  const report = readJson(out);
  assert.equal(report.classification, 'offline_ready');
  assert.equal(report.evidenceOk, true, 'the offline record itself is valid evidence');
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.equal(dirHash(batch), before, 'no file is created by verifying an offline batch');
  assert.equal(existsSync(campaign), false, 'no ledger is fabricated');

  // The PRE-RESUME driver wrote { schema, at, reason }: that historical record
  // is still the honest proof of a zero-POST batch and must not be re-labelled
  // inconsistent (G11-LIVE-20261105-r1 is exactly this shape).
  writeFileSync(join(batch, 'offline-ready.json'), `${JSON.stringify({
    schema: 'frostecho.g11-live.offline-ready/1',
    at: '2026-11-06T04:58:34.086Z',
    reason: 'fetch failed',
  }, null, 2)}\n`);
  const legacy = await cli(DRIVER, ['verify', '--batch', batch, '--campaign', campaign, '--out', out]);
  assert.equal(legacy.code, 1, 'the historical offline record is still not a completion');
  const legacyReport = readJson(out);
  assert.equal(legacyReport.classification, 'offline_ready', 'the historical offline shape is accepted as evidence');
  assert.equal(legacyReport.evidenceOk, true);
  assert.deepEqual(legacyReport.issues, []);
});
