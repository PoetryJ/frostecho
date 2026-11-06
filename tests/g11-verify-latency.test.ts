/**
 * Independent black box for the two things this round had to prove:
 *
 * 1. The verifier's three wiring fixes. The four counterexamples that the review
 *    proved were WRONGLY accepted at 44e8053 must now be rejected. They are
 *    rebuilt here from a real fake batch by editing the payload and re-signing
 *    the envelope with the production slotChecksum, so the checksum can never be
 *    what catches them: only the semantic wiring can.
 *
 * 2. The latency probe tool. Offline only: a random-port fake server, never
 *    18872, never the real budget. It must send exactly the frozen 8 requests,
 *    differ only in enable_thinking, stop at the first failure, keep unknown
 *    usage unknown, and refuse a second start.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { slotChecksum } from '../src/persistence/atomic-slot';

const DRIVER = join(process.cwd(), 'dist/scripts/g11-live.js');
const PROBE = join(process.cwd(), 'dist/scripts/g11-latency-probe.js');
const INPUTS = join(process.cwd(), 'research/decision-choice/latency/inputs');
const MODEL = 'qwen3.8-27b';
const REAL_BATCH = join(process.cwd(), 'artifacts/g11-live/g11-live-20261105-r1');
const REAL_CAMPAIGN = join(process.cwd(), 'artifacts/g11-live/campaign-approved8');

type AnyJson = Record<string, any>;
const readJson = (path: string): AnyJson => JSON.parse(readFileSync(path, 'utf8')) as AnyJson;
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

interface CliRun { code: number; stdout: string; stderr: string }
function cli(entry: string, args: string[]): Promise<CliRun> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface FakeServer { url: string; posts: AnyJson[]; close(): Promise<void> }
interface FakeOptions { failFirstWith?: number; omitUsage?: boolean; answer?: string }

async function fakeOpenAi(options: FakeOptions = {}): Promise<FakeServer> {
  const posts: AnyJson[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      const body = JSON.parse(raw) as AnyJson;
      posts.push(body);
      if (options.failFirstWith !== undefined && posts.length === 1) {
        response.writeHead(options.failFirstWith, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'injected' } }));
        return;
      }
      const answer = options.answer ?? (raw.includes('feed_self') ? '{"goal":"yield_once"}' : raw.includes('yield_once') ? '{"type":"wait"}' : '{"type":"eat"}');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `chatcmpl-lat-${String(posts.length)}`, object: 'chat.completion', created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        ...(options.omitUsage === true ? {} : { usage: { prompt_tokens: 393, completion_tokens: 40, total_tokens: 433, completion_tokens_details: { reasoning_tokens: 30 } } }),
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`, posts, close: () => new Promise((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))) };
}

/** A complete, legal 8-post fake batch: the baseline every counterexample starts from. */
async function fundedBatch(server: FakeServer): Promise<{ base: string; batch: string; campaign: string }> {
  const base = mkdtempSync(join(tmpdir(), 'fe-g11vl-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  const args = ['--batch', batch, '--campaign', campaign, '--http', server.url, '--model', MODEL];
  assert.equal((await cli(DRIVER, ['prepare', ...args, '--limit', '8'])).code, 0);
  const run = await cli(DRIVER, ['run', ...args]);
  assert.equal(run.code, 0, `the fake baseline must close: ${run.stderr.slice(-400)}`);
  const verified = await cli(DRIVER, ['verify', ...args]);
  assert.equal(verified.code, 0, `the fake baseline must verify: ${verified.stdout.slice(-400)}`);
  return { base, batch, campaign };
}

/** Edit the payload and RE-SIGN it, so a checksum can never be the catcher. */
function resign(path: string, edit: (payload: AnyJson) => void): void {
  const envelope = readJson(path) as { sha256: string; payload: AnyJson };
  edit(envelope.payload);
  writeFileSync(path, `${JSON.stringify({ ...envelope, sha256: slotChecksum(envelope.payload) }, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */
/* 1-4: the four counterexamples the review found wrongly accepted      */
/* ------------------------------------------------------------------ */

test('the four wrongly-accepted counterexamples are now rejected by the wiring', async () => {
  const server = await fakeOpenAi();
  try {
    const { batch, campaign } = await fundedBatch(server);
    const args = ['verify', '--batch', batch, '--campaign', campaign];
    const suffixPath = join(batch, 'w1', 'w1-wait-run.run.json');
    const prefixPath = join(batch, 'w1', 'w1-prefix-run.run.json');
    const scenePath = join(batch, 'scene-W1.json');
    const ledgerPath = join(campaign, 'campaign.json');
    const originals = new Map([suffixPath, prefixPath, scenePath, ledgerPath].map(path => [path, readFileSync(path)]));
    const restore = (): void => { for (const [path, bytes] of originals) writeFileSync(path, bytes); };
    const rejected = async (why: string, pattern: RegExp): Promise<void> => {
      const verified = await cli(DRIVER, args);
      assert.equal(verified.code, 1, `${why}: verify must fail, got ${String(verified.code)} (${verified.stdout.slice(-300)})`);
      const report = JSON.parse(verified.stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1)!) as AnyJson;
      assert.equal(report.evidenceOk, false, `${why}: evidenceOk must be false`);
      assert.equal(report.complete, false, `${why}: complete must be false`);
      assert.match((report.issues as string[]).join(' | '), pattern, `${why}: the named cause must mention the wiring`);
      restore();
    };

    // (1) another actor's satiety is edited in the recorded final world.
    resign(suffixPath, payload => { payload.authoritative.snapshot.finalState.npcs.npc_b.hunger = 999; });
    await rejected('npc_b satiety 999', /re-execut|different final state/i);

    // (2) the top-level commands/events are emptied while the snapshot stays.
    resign(suffixPath, payload => { payload.authoritative.commands = []; payload.authoritative.events = []; });
    await rejected('top-level commands/events emptied', /differs from snapshot/i);

    // (3) the scene declares failure AND edits npc_a's satiety: a label must not
    //     downgrade a contradiction of data that already exists.
    resign(suffixPath, payload => { payload.authoritative.snapshot.finalState.npcs.npc_a.hunger = 999; });
    const scene = readJson(scenePath);
    scene.overall = 'technical_failure';
    writeFileSync(scenePath, JSON.stringify(scene));
    await rejected('declared failure plus npc_a 999', /re-execut|different final state/i);

    // (4) a ninth finished attempt with no wire, spent raised to 9 over a limit of 8.
    const ledger = readJson(ledgerPath);
    const orphan = structuredClone(ledger.attempts.at(-1) as AnyJson);
    orphan.attemptId = 'att-0009';
    orphan.seq = 9;
    ledger.attempts.push(orphan);
    ledger.spent = 9;
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    await rejected('orphan ninth finished attempt', /finished in the ledger with 0 wire entries|campaign spent 9/);

    const clean = await cli(DRIVER, args);
    assert.equal(clean.code, 0, 'the restored baseline must verify again');
  } finally {
    await server.close();
  }
});

test('ledger and wire are matched in BOTH directions', async () => {
  const server = await fakeOpenAi();
  try {
    const { batch, campaign } = await fundedBatch(server);
    const args = ['verify', '--batch', batch, '--campaign', campaign];
    const ledgerPath = join(campaign, 'campaign.json');
    const original = readFileSync(ledgerPath);
    const list = (run: CliRun): string[] => (JSON.parse(run.stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1)!) as AnyJson).issues as string[];

    // a duplicated attempt id in the ledger
    const ledger = readJson(ledgerPath);
    ledger.attempts.push(structuredClone(ledger.attempts[0] as AnyJson));
    ledger.spent = ledger.attempts.length;
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const duplicate = await cli(DRIVER, args);
    assert.equal(duplicate.code, 1);
    assert.match(list(duplicate).join(' | '), /duplicate attemptId/);
    writeFileSync(ledgerPath, original);

    // a finished attempt whose wire entry was removed from the record
    const suffixPath = join(batch, 'w1', 'w1-wait-run.run.json');
    const bytes = readFileSync(suffixPath);
    resign(suffixPath, payload => {
      const wire = payload.wire as AnyJson[];
      payload.wire = [wire[0]!];
      payload.lineage.attemptRange = { first: wire[0]!.attemptId, last: wire[0]!.attemptId, count: 1 };
    });
    const missingWire = await cli(DRIVER, args);
    assert.equal(missingWire.code, 1);
    assert.match(list(missingWire).join(' | '), /finished in the ledger with 0 wire entries|expected 2 continuation posts/);
    writeFileSync(suffixPath, bytes);

    assert.equal((await cli(DRIVER, args)).code, 0, 'restoring the bytes restores the verdict');
  } finally {
    await server.close();
  }
});

test('the real batch stays evidence-ok but not complete, byte-identical', async () => {
  assert.equal(existsSync(REAL_BATCH), true, 'the real G11 batch is part of the checkout');
  const before = sha256(readFileSync(join(REAL_BATCH, 'w1', 'w1-wait-run.run.json')));
  const ledgerBefore = sha256(readFileSync(join(REAL_CAMPAIGN, 'campaign.json')));
  const verified = await cli(DRIVER, ['verify', '--batch', REAL_BATCH, '--campaign', REAL_CAMPAIGN]);
  assert.equal(verified.code, 1, 'W2 did not complete, so the batch cannot close');
  const report = JSON.parse(verified.stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1)!) as AnyJson;
  assert.equal(report.evidenceOk, true, 'the real evidence is self-consistent');
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [], 'no integrity issue in the real evidence');
  assert.equal(sha256(readFileSync(join(REAL_BATCH, 'w1', 'w1-wait-run.run.json'))), before, 'verify never writes');
  assert.equal(sha256(readFileSync(join(REAL_CAMPAIGN, 'campaign.json'))), ledgerBefore, 'verify never writes the ledger');
  const w1 = (report.scenes as AnyJson[]).find(scene => scene.scene === 'W1');
  const w2 = (report.scenes as AnyJson[]).find(scene => scene.scene === 'W2');
  assert.equal(w1?.status, 'complete', 'W1 stays proven');
  assert.equal(w2?.status, 'incomplete', 'W2 stays unfinished');

  // The cost correction, pinned to the per-attempt records: the known subtotal
  // is 2397 (231+777+504+654+231); 2166 is W1 only, and att-0006 stays unknown.
  const costs = report.costs as AnyJson;
  const byAttempt = costs.byAttempt as AnyJson[];
  assert.deepEqual(byAttempt.map(entry => entry.totalTokens), [231, 777, 504, 654, 231, null], 'one token figure per charged attempt');
  const known = byAttempt.reduce((sum, entry) => sum + (typeof entry.totalTokens === 'number' ? entry.totalTokens : 0), 0);
  assert.equal(known, 2397, 'known tokens are 2397, not the W1-only 2166');
  assert.deepEqual(costs.unknownUsage, ['att-0006'], 'the timed-out attempt is the single unknown');
  assert.equal(costs.totalTokens, null, 'the grand total stays null while one usage is unknown');
  assert.equal(costs.spent, 6);
  assert.equal(costs.limit, 8);
});

/* ------------------------------------------------------------------ */
/* 5-11: the latency probe tool                                        */
/* ------------------------------------------------------------------ */

async function toolPlan(server: FakeServer, authorized: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'fe-lat-'));
  const planned = await cli(PROBE, ['plan', '--dir', dir, '--inputs', INPUTS, '--http', server.url, '--authorized-calls', String(authorized)]);
  assert.equal(planned.code, 0, `plan failed: ${planned.stderr}`);
  return dir;
}

test('the probe sends exactly the frozen 8 requests and differs only in enable_thinking', async () => {
  const server = await fakeOpenAi();
  try {
    const dir = await toolPlan(server, 8);
    const plan = readJson(join(dir, 'plan.json')) as AnyJson;
    assert.equal(plan.proposedCalls, 8);
    assert.deepEqual((plan.matrix as AnyJson[]).map(item => `${String(item.inputId)}${String(item.rep)}:${String(item.arm)}`),
      ['Y1:off', 'Y1:on', 'N1:on', 'N1:off', 'Y2:on', 'Y2:off', 'N2:off', 'N2:on']);
    const run = await cli(PROBE, ['run', '--dir', dir, '--authorized', '--test-loopback']);
    assert.equal(run.code, 0, `the fake run must complete: ${run.stderr.slice(-300)} ${run.stdout.slice(-300)}`);
    assert.equal(server.posts.length, 8, 'exactly eight requests, no retry');

    // The single-factor claim, checked against what actually reached HTTP: the
    // arm of every request must match the pre-registered matrix, and the two
    // bodies of a pair must be identical apart from the switch.
    const matrix = (readJson(join(dir, 'plan.json')) as AnyJson).matrix as AnyJson[];
    const byPair = new Map<string, AnyJson[]>();
    server.posts.forEach((body, index) => {
      const item = matrix[index]!;
      assert.equal(body.chat_template_kwargs.enable_thinking, item.arm === 'on', `request ${String(index)}: arm ${String(item.arm)}`);
      const key = `${String(item.inputId)}#${String(item.rep)}`;
      byPair.set(key, [...(byPair.get(key) ?? []), body]);
    });
    for (const [key, bodies] of byPair) {
      assert.equal(bodies.length, 2, `${key} must have two arms`);
      const strip = (body: AnyJson): AnyJson => ({ ...body, chat_template_kwargs: { ...body.chat_template_kwargs, enable_thinking: 'X' } });
      assert.deepEqual(strip(bodies[0]!), strip(bodies[1]!), `${key}: apart from the switch the bodies must be byte-identical`);
    }

    const summarized = await cli(PROBE, ['summarize', '--dir', dir]);
    assert.equal(summarized.code, 0);
    const summary = readJson(join(dir, 'summary.json')) as AnyJson;
    assert.equal(summary.counts.ok, 8);
    assert.equal(summary.counts.usablePairs, 4);
    assert.equal(summary.tokens.known, 8 * 433);
    assert.deepEqual(summary.tokens.unknown, []);
  } finally {
    await server.close();
  }
});

test('without an authorization flag the probe sends nothing', async () => {
  const server = await fakeOpenAi();
  try {
    const dir = await toolPlan(server, 8);
    const run = await cli(PROBE, ['run', '--dir', dir, '--test-loopback']);
    assert.equal(run.code, 2, 'an unauthorized run is a config error');
    assert.equal(server.posts.length, 0, 'zero requests');
    assert.equal(existsSync(join(dir, 'run-start.json')), false, 'no start marker either');
    // and the shipped plan itself carries authorizedCalls = 0
    const shipped = readJson(join(process.cwd(), 'research/decision-choice/latency/plan.json')) as AnyJson;
    assert.equal(shipped.authorizedCalls, 0, 'the committed plan is unauthorized');
    assert.equal(shipped.proposedCalls, 8);
  } finally {
    await server.close();
  }
});

test('the probe stops at the first HTTP failure and leaves the rest unrun', async () => {
  const server = await fakeOpenAi({ failFirstWith: 500 });
  try {
    const dir = await toolPlan(server, 8);
    const run = await cli(PROBE, ['run', '--dir', dir, '--authorized', '--test-loopback']);
    assert.equal(run.code, 1, 'a failed request stops the probe');
    assert.equal(server.posts.length, 1, 'exactly one request reached the server');
    const summary = await cli(PROBE, ['summarize', '--dir', dir]);
    assert.equal(summary.code, 0);
    const data = readJson(join(dir, 'summary.json')) as AnyJson;
    assert.equal(data.counts.failed, 1);
    assert.equal(data.counts.notRun, 7, 'the remaining seven stay not_run');
    assert.equal(data.tokens.total, null, 'a failed attempt keeps the total unknown');
  } finally {
    await server.close();
  }
});

test('a missing usage is reported as unknown, never estimated', async () => {
  const server = await fakeOpenAi({ omitUsage: true });
  try {
    const dir = await toolPlan(server, 8);
    assert.equal((await cli(PROBE, ['run', '--dir', dir, '--authorized', '--test-loopback'])).code, 0);
    const summarized = await cli(PROBE, ['summarize', '--dir', dir]);
    assert.equal(summarized.code, 0);
    const data = readJson(join(dir, 'summary.json')) as AnyJson;
    assert.equal(data.tokens.total, null);
    assert.equal(data.tokens.known, null);
    assert.equal((data.tokens.unknown as string[]).length, 8);
  } finally {
    await server.close();
  }
});

test('a timeout is recorded as a censored client deadline, not as a sample', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-lat-timeout-'));
  const fixture = join(dir, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ answers: [{ status: null, text: null, latencyMs: 120000, timeout: true }] }));
  const planned = await cli(PROBE, ['plan', '--dir', dir, '--inputs', INPUTS, '--authorized-calls', '8']);
  assert.equal(planned.code, 0);
  const run = await cli(PROBE, ['run', '--dir', dir, '--authorized', '--fixture', fixture]);
  assert.equal(run.code, 1, 'a timeout stops the probe');
  const summarized = await cli(PROBE, ['summarize', '--dir', dir]);
  assert.equal(summarized.code, 0);
  const data = readJson(join(dir, 'summary.json')) as AnyJson;
  assert.equal(data.counts.timeout, 1);
  assert.equal(data.counts.notRun, 7);
  assert.equal((data.pairs as AnyJson[]).every(pair => pair.usable === false), true, 'a censored arm cannot contribute a delta');
  assert.equal(data.tokens.total, null);
});

test('a probe starts once: the second run is refused and the budget is not refreshed', async () => {
  const server = await fakeOpenAi({ failFirstWith: 500 });
  try {
    const dir = await toolPlan(server, 8);
    assert.equal((await cli(PROBE, ['run', '--dir', dir, '--authorized', '--test-loopback'])).code, 1);
    const spent = (readJson(join(dir, 'campaign', 'campaign.json')) as AnyJson).spent as number;
    assert.equal(spent, 1, 'the failed request is still spent');
    const again = await cli(PROBE, ['run', '--dir', dir, '--authorized', '--test-loopback']);
    assert.equal(again.code, 2, 'a second start is a config error');
    assert.match(again.stderr, /already started|already spent/);
    assert.equal(server.posts.length, 1, 'the refused run sends nothing');
    assert.equal((readJson(join(dir, 'campaign', 'campaign.json')) as AnyJson).spent, 1, 'no budget refresh');
  } finally {
    await server.close();
  }
});

test('the probe never targets the frozen service port from a dirty tree', async () => {
  const { isTestLoopback } = await import('../scripts/g11-latency-probe');
  assert.equal(isTestLoopback('http://127.0.0.1:18872/v1/chat/completions'), false, 'the service port is never a test loopback');
  assert.equal(isTestLoopback('http://127.0.0.1:45678/v1/chat/completions'), true, 'a random port is');
  assert.equal(isTestLoopback('http://example.com:45678/v1/chat/completions'), false, 'a non-local host never is');
  assert.equal(isTestLoopback('not a url'), false);
});

test('the two frozen inputs are the recorded attempt bodies, not a re-written prompt', async () => {
  for (const [inputId, relativePath, attemptId, wireIndex] of [
    ['Y', 'w1/w1-prefix-run.run.json', 'att-0002', 1],
    ['N', 'w1/w1-wait-run.run.json', 'att-0003', 0],
  ] as const) {
    const stored = readJson(join(INPUTS, `${inputId}.json`)) as AnyJson;
    assert.equal(stored.source.attemptId, attemptId, `${inputId} names its attempt`);
    const record = readJson(join(REAL_BATCH, relativePath.replace(/\//g, '/'))).payload as AnyJson;
    const wire = (record.wire as AnyJson[])[wireIndex]!;
    assert.deepEqual(stored.body, wire.requestBody, `${inputId} is byte-identical to the recorded request`);
    assert.equal(stored.bodySha256, sha256(JSON.stringify(stored.body)));
    assert.equal(stored.source.sha256, sha256(readFileSync(join(REAL_BATCH, relativePath))), `${inputId} records the source hash`);
  }
});
