/**
 * D: independent black-box end-to-end audit of the action-off experiment.
 *
 * Offline only (random-port fake OpenAI server). It drives the REAL CLI and
 * therefore two real child processes per scene, then re-derives the facts from
 * the written records instead of trusting labels:
 *   - 8 posts: 2 goal (thinking on) + 6 action (off), exact ledger binding;
 *   - the suffix is a NEW process whose parent slot is the prefix save, it
 *     re-asks no goal, and it ends at hunger 90 / kitchen 0 / simTime 1;
 *   - a wire tampered to contradict the frozen phase value closes the gate;
 *   - an explicit load value that contradicts the slot spends nothing;
 *   - a failure on the first action stops the batch with evidence and no retry.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadG10Runtime } from '../src/application/adapters';
import { slotChecksum } from '../src/persistence/atomic-slot';

const DRIVER = join(process.cwd(), 'dist/scripts/g11-live.js');
const MODEL = 'qwen3.8-27b';
const OLD_BATCH = join(process.cwd(), 'artifacts/g11-live/g11-live-20261105-r1');

interface Fake { url: string; posts: Record<string, any>[]; close(): Promise<void> }

async function fakeOpenAi(failAt?: number): Promise<Fake> {
  const posts: Record<string, any>[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET') {
        if (request.url?.startsWith('/health')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      const body = JSON.parse(raw) as Record<string, any>;
      posts.push(body);
      if (failAt !== undefined && posts.length === failAt) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'injected' } }));
        return;
      }
      const answer = raw.includes('feed_self') ? '{"goal":"yield_once"}'
        : raw.includes('yield_once') ? '{"type":"wait"}' : '{"type":"eat"}';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
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

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [DRIVER, ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

interface Batch { base: string; batch: string; campaign: string }
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const thinkingOf = (body: Record<string, any>): unknown => body.chat_template_kwargs?.enable_thinking;

async function prepare(server: Fake, actionThinking: string | null = 'off'): Promise<Batch> {
  const base = mkdtempSync(join(tmpdir(), 'fe-action-e2e-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  const args = ['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', MODEL, '--limit', '8'];
  if (actionThinking !== null) args.push('--action-thinking', actionThinking);
  const prepared = await cli(args);
  assert.equal(prepared.code, 0, prepared.stderr);
  return { base, batch, campaign };
}

const runArgs = (b: Batch, server: Fake): string[] =>
  ['run', '--batch', b.batch, '--campaign', b.campaign, '--http', server.url, '--model', MODEL];

test('the complete W1/W2 batch is 2 goal-on + 6 action-off across two processes per scene', async () => {
  const server = await fakeOpenAi();
  try {
    const oldBefore = existsSync(join(OLD_BATCH, 'w1', 'w1-wait-run.run.json'))
      ? sha(join(OLD_BATCH, 'w1', 'w1-wait-run.run.json')) : null;
    const b = await prepare(server);
    const run = await cli(runArgs(b, server));
    assert.equal(run.code, 0, `${run.stderr.slice(-400)} ${run.stdout.slice(-600)}`);
    assert.equal(server.posts.length, 8);
    assert.deepEqual(server.posts.map(thinkingOf), [true, false, false, false, true, false, false, false]);

    const ledger = readJson(join(b.campaign, 'campaign.json'));
    assert.equal(ledger.spent, 8);
    assert.deepEqual(ledger.attempts.map((a: Record<string, any>) => a.phase),
      ['goal', 'action', 'action', 'action', 'goal', 'action', 'action', 'action']);
    assert.deepEqual(ledger.attempts.map((a: Record<string, any>) => a.episodeId?.startsWith('w1') ? 'W1' : 'W2'),
      ['W1', 'W1', 'W1', 'W1', 'W2', 'W2', 'W2', 'W2']);

    for (const scene of ['w1', 'w2'] as const) {
      const expected = scene === 'w1' ? 'fulfilled' : 'expired';
      const prefix = readJson(join(b.batch, scene, `${scene}-prefix-run.run.json`)).payload;
      const suffix = readJson(join(b.batch, scene, `${scene}-wait-run.run.json`)).payload;
      assert.equal(prefix.lineage.parentSlot, null, `${scene}: the prefix starts a lineage`);
      assert.equal(suffix.lineage.parentSlot, join(b.batch, scene, `${scene}-wait.g09.json`), `${scene}: suffix loads the prefix slot`);
      assert.deepEqual(prefix.wire.map((w: Record<string, any>) => w.phase), ['goal', 'action']);
      assert.deepEqual(suffix.wire.map((w: Record<string, any>) => w.phase), ['action', 'action']);
      const request = Object.values(suffix.authoritative.requests)[0] as Record<string, any>;
      assert.equal(request.outcome, expected, `${scene}: authoritative outcome`);
      for (const wire of suffix.wire) {
        const prompt = (wire.requestBody as Record<string, any>).messages[0].content as string;
        assert.equal(prompt.includes(request.text as string), false, `${scene}: the goal request is never re-asked`);
      }
      const final = suffix.authoritative.snapshot.finalState;
      assert.equal(final.npcs.npc_a.hunger, 90, `${scene}: ordinary needs end at 90`);
      assert.equal(final.food.kitchen, 0, `${scene}: kitchen restored food is eaten`);
      assert.equal(final.simTime, 1);
      assert.equal(suffix.authoritative.budget.episodeCalls, 4);

      const slot = readJson(join(b.batch, scene, `${scene}-wait.g09.json`));
      assert.equal(slot.payload.effectiveConfig.actionThinking, false, `${scene}: slot freezes action off`);
      assert.equal(slot.payload.game.actionThinking, false, `${scene}: game record agrees with the slot`);
    }
    if (oldBefore !== null) assert.equal(sha(join(OLD_BATCH, 'w1', 'w1-wait-run.run.json')), oldBefore, 'old evidence is never written');
  } finally {
    await server.close();
  }
});

test('a wire that contradicts the frozen action value closes the gate (copy only)', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server);
    assert.equal((await cli(runArgs(b, server))).code, 0);
    const copy = join(b.base, 'copy');
    cpSync(b.batch, copy, { recursive: true });
    const prefixPath = join(copy, 'w1', 'w1-prefix-run.run.json');
    const file = readJson(prefixPath);
    const actionWire = (file.payload.wire as Record<string, any>[]).find(wire => wire.phase === 'action')!;
    actionWire.requestBody.chat_template_kwargs.enable_thinking = true;
    file.sha256 = slotChecksum(file.payload);
    writeFileSync(prefixPath, `${JSON.stringify(file, null, 2)}\n`);
    const tampered = sha(prefixPath);

    const verified = await cli(['verify', '--batch', copy, '--campaign', b.campaign, '--http', 'x', '--model', MODEL]);
    assert.equal(verified.code, 1);
    assert.match(verified.stdout, /enable_thinking is not false/);
    assert.equal(sha(prefixPath), tampered, 'verify never rewrites the audited file');
  } finally {
    await server.close();
  }
});

test('an explicit load value that contradicts the slot spends nothing', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server);
    assert.equal((await cli(runArgs(b, server))).code, 0);
    const slotPath = join(b.batch, 'w1', 'w1-wait.g09.json');
    const before = readFileSync(slotPath);
    const posts = server.posts.length;
    const loaded = loadG10Runtime(slotPath, {
      live: true, model: MODEL, fixture: null, http: server.url, campaign: b.campaign,
      campaignLimit: null, actionThinking: true,
    });
    assert.equal(loaded.ok, false);
    assert.match((loaded.ok ? [] : loaded.issues ?? []).join('; '), /action-thinking conflict/);
    assert.equal(server.posts.length, posts, 'zero POST on the refusal');
    assert.equal(readFileSync(slotPath).equals(before), true, 'the saved slot is untouched');
  } finally {
    await server.close();
  }
});

test('a 500 on the first action stops with evidence and no retry', async () => {
  const server = await fakeOpenAi(2);
  try {
    const b = await prepare(server);
    const run = await cli(runArgs(b, server));
    assert.equal(run.code, 1, 'the batch must stop');
    assert.equal(server.posts.length, 2, 'goal + the failed action, never retried');
    const ledger = readJson(join(b.campaign, 'campaign.json'));
    assert.equal(ledger.spent, 2);
    assert.equal(ledger.attempts.length, 2);
    assert.equal(['provider_error', 'http_error'].includes(ledger.attempts[1].outcome), true,
      `the failed call is charged as ${String(ledger.attempts[1].outcome)}`);
    const scene = readJson(join(b.batch, 'scene-W1.json'));
    assert.notEqual(scene.overall, 'success');
    assert.equal(existsSync(join(b.batch, 'scene-W2.json')), false, 'the later scene stays not_run');
    const verified = await cli(['verify', '--batch', b.batch, '--campaign', b.campaign, '--http', 'x', '--model', MODEL]);
    assert.equal(verified.code, 1);
    const report = JSON.parse(verified.stdout.trim().split('\n').filter(line => line.startsWith('{')).at(-1)!) as Record<string, any>;
    // Existing G11 semantics: a stopped batch never wrote scene-W2.json, so
    // the gate stays closed. The charged failure itself is still recorded
    // (it is a caveat/expectation, and the ledger names the same attempt).
    assert.equal(report.complete, false);
    assert.match(JSON.stringify(report.expectations), /att-0002/);
    assert.match(JSON.stringify(report.expectations), /http 500/);
  } finally {
    await server.close();
  }
});
