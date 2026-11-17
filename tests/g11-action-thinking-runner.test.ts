/**
 * C: the G11 runner freezes `--action-thinking` into the plan and the verifier
 * checks the ACTUAL wire by system phase, not a label.
 *
 * Offline: random-port fake server only. No real service, no real budget.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const DRIVER = join(process.cwd(), 'dist/scripts/g11-live.js');
const MODEL = 'qwen3.8-27b';

interface Fake { url: string; posts: Record<string, any>[]; close(): Promise<void> }

async function fakeOpenAi(): Promise<Fake> {
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

async function prepare(server: Fake, actionThinking?: string): Promise<Batch> {
  const base = mkdtempSync(join(tmpdir(), 'fe-action-runner-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  const args = ['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', MODEL, '--limit', '8'];
  if (actionThinking !== undefined) args.push('--action-thinking', actionThinking);
  const prepared = await cli(args);
  assert.equal(prepared.code, 0, prepared.stderr);
  return { base, batch, campaign };
}

const runArgs = (b: Batch, server: Fake): string[] =>
  ['run', '--batch', b.batch, '--campaign', b.campaign, '--http', server.url, '--model', MODEL];

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const thinkingOf = (body: Record<string, any>): unknown => body.chat_template_kwargs?.enable_thinking;

test('prepare freezes action off; goal wires stay on and every action wire is off', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server, 'off');
    const plan = readJson(join(b.batch, 'plan.json'));
    assert.equal(plan.actionThinking, false);
    const run = await cli(runArgs(b, server));
    assert.equal(run.code, 0, `${run.stderr.slice(-400)} ${run.stdout.slice(-400)}`);
    assert.equal(server.posts.length, 8);
    // Per scene: goal (on) then three action wires (off); W1 first, then W2.
    assert.deepEqual(server.posts.map(thinkingOf), [true, false, false, false, true, false, false, false]);
    const start = readJson(join(b.batch, 'run-start.json'));
    assert.equal(start.effective.sampling.thinking, true);
    assert.equal(start.effective.sampling.actionThinking, false);
    const ledger = readJson(join(b.campaign, 'campaign.json'));
    assert.equal(ledger.spent, 8);
    assert.deepEqual(ledger.attempts.map((attempt: Record<string, any>) => attempt.phase),
      ['goal', 'action', 'action', 'action', 'goal', 'action', 'action', 'action']);
  } finally {
    await server.close();
  }
});

test('a plan without the flag keeps the historical all-on wire and key set', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server);
    const planText = readFileSync(join(b.batch, 'plan.json'), 'utf8');
    assert.equal(planText.includes('actionThinking'), false, 'old plan bytes carry no new key');
    const run = await cli(runArgs(b, server));
    assert.equal(run.code, 0, `${run.stderr.slice(-400)}`);
    assert.equal(server.posts.length, 8);
    assert.deepEqual(server.posts.map(thinkingOf), [true, true, true, true, true, true, true, true]);
    const start = readJson(join(b.batch, 'run-start.json'));
    assert.equal('actionThinking' in start.effective.sampling, false);
  } finally {
    await server.close();
  }
});

test('verify rejects action wires that contradict the frozen phase value', async () => {
  const server = await fakeOpenAi();
  try {
    const b = await prepare(server, 'off');
    assert.equal((await cli(runArgs(b, server))).code, 0);
    // Flip the plan's claim (test-only copy): the bytes must win, not the label.
    const planPath = join(b.batch, 'plan.json');
    const plan = readJson(planPath);
    plan.actionThinking = true;
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const verified = await cli(['verify', '--batch', b.batch, '--campaign', b.campaign, '--http', 'x', '--model', MODEL]);
    assert.equal(verified.code, 1, 'a contradicted phase must close the gate');
    assert.match(verified.stdout, /enable_thinking is not true/);
  } finally {
    await server.close();
  }
});

test('an invalid --action-thinking value spends nothing and writes no plan', async () => {
  const server = await fakeOpenAi();
  try {
    const base = mkdtempSync(join(tmpdir(), 'fe-action-runner-bad-'));
    const batch = join(base, 'batch');
    const campaign = join(base, 'campaign');
    const prepared = await cli(['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url,
      '--model', MODEL, '--limit', '8', '--action-thinking', 'maybe']);
    assert.equal(prepared.code, 2);
    assert.match(prepared.stderr, /--action-thinking must be on\|off/);
    assert.equal(existsSync(join(batch, 'plan.json')), false);
    assert.equal(existsSync(campaign), false);
    assert.equal(server.posts.length, 0);

    // The run may never override the frozen plan value on the command line.
    const b = await prepare(server, 'off');
    const refused = await cli([...runArgs(b, server), '--action-thinking', 'on']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /frozen by prepare/);
    assert.equal(server.posts.length, 0);
  } finally {
    await server.close();
  }
});
