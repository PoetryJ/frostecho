import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HTTP_SAMPLING } from '../src/agent';
import { runG02Eval } from '../src/play';

const EVAL = join('dist', 'scripts', 'eval-g02.js');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g02-eval-'));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function actionFor(prompt: string): string {
  const line = prompt.split('\n').find(item => item.startsWith('observation: '));
  if (!line) return '{"type":"stop"}';
  const observation = JSON.parse(line.slice('observation: '.length)) as { hunger: number; location: string; foodHere: number };
  if (observation.hunger >= 70) return '{"type":"stop"}';
  if (observation.location !== 'kitchen') return '{"type":"move","to":"kitchen"}';
  if (observation.foodHere > 0) return '{"type":"eat"}';
  return '{"type":"stop"}';
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EVAL, ...args], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`eval timed out\n${stdout}\n${stderr}`));
    }, 20000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test('fixture eval runs 18 games, keeps scenario pass apart from the goal, and is not a real model', async () => {
  const root = tempDir();
  const out = await runG02Eval({
    mode: 'fixture',
    root,
    batchId: 'fixture-unit',
    now: () => 0,
  });
  assert.equal(out.exitCode, 0);
  assert.equal(out.summary.realModel, false);
  assert.equal(out.summary.mode, 'fixture');
  assert.equal(out.summary.thinkingDefault, true);
  assert.equal(out.summary.gamesPlanned, 18);
  assert.equal(out.summary.gamesRun, 18);
  assert.equal(out.summary.requestCount, 42);
  assert.equal(out.summary.maxProviderCalls, 90);
  assert.equal(out.summary.retries, 0);
  assert.equal(out.summary.callCapExceeded, false);
  assert.equal(out.summary.byScenario.s1.scenarioPass, 6);
  assert.equal(out.summary.byScenario.s1.goalReached, 6);
  assert.equal(out.summary.byScenario.s2.scenarioPass, 6);
  assert.equal(out.summary.byScenario.s2.goalReached, 0);
  assert.equal(out.summary.byScenario.s3.scenarioPass, 6);
  assert.equal(out.summary.byScenario.s3.goalReached, 0);
  assert.equal(out.summary.byThinking.true.games, 9);
  assert.equal(out.summary.byThinking.false.games, 9);
  assert.equal(out.summary.byThinking.true.requestCount, 21);
  assert.equal(out.summary.byThinking.false.requestCount, 21);
  assert.equal(out.summary.errors.transport, 0);
  assert.equal(out.summary.errors.parse, 0);
  assert.equal(out.summary.errors.decide, 0);
  assert.equal(out.summary.errors.execute, 0);
  assert.equal(out.summary.errors.s3ExpectedNoFood, 6);
  assert.match(out.summary.notes.join('\n'), /default enable_thinking remains true/);
  assert.match(out.summary.notes.join('\n'), /30000ms/);
  assert.match(out.summary.notes.join('\n'), /No implicit retries/);
  const on = JSON.parse(readFileSync(join(root, 'fixture-unit', 'games', 's1-thinking-on-rep-1', 'events.json'), 'utf8'));
  const off = JSON.parse(readFileSync(join(root, 'fixture-unit', 'games', 's1-thinking-off-rep-1', 'events.json'), 'utf8'));
  assert.deepEqual(on.map((event: { type: string }) => event.type), off.map((event: { type: string }) => event.type));
  const failedKept = existsSync(join(root, 'fixture-unit', 'games', 's3-thinking-off-rep-3', 'game.json'));
  assert.equal(failedKept, true);
  const game = JSON.parse(readFileSync(join(root, 'fixture-unit', 'games', 's3-thinking-off-rep-3', 'game.json'), 'utf8'));
  assert.equal(game.scenarioPass, true);
  assert.equal(game.goalReached, false);
});

test('injected live eval is serial, shares the prompt, records thinking on and off, and does not retry', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const bodies: Record<string, unknown>[] = [];
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'live-model' }] }));
      return;
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string;
        temperature?: number;
        max_tokens?: number;
        stream?: boolean;
        chat_template_kwargs?: { enable_thinking?: boolean };
        messages?: { content?: string }[];
      };
      bodies.push(body);
      prompts.push(body.messages?.[0]?.content ?? '');
      const content = actionFor(body.messages?.[0]?.content ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      inFlight -= 1;
    });
  });
  const port = await listen(server);
  const root = tempDir();
  try {
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const out = await runG02Eval({
      mode: 'live',
      root,
      batchId: 'injected-live',
      env: { FROSTECHO_LLM_URL: url, FROSTECHO_LLM_MODEL: 'live-model', FROSTECHO_LLM_API_KEY: 'sekret-eval' },
      fetchImpl: globalThis.fetch,
      now: () => 0,
    });
    assert.equal(out.exitCode, 0, JSON.stringify(out.summary.byScenario));
    assert.equal(out.summary.realModel, false);
    assert.equal(out.summary.model, 'live-model');
    assert.equal(out.summary.requestCount, 42);
    assert.equal(maxInFlight, 1);
    assert.equal(bodies.length, 42);
    assert.equal(HTTP_SAMPLING.chat_template_kwargs.enable_thinking, true);
    for (const body of bodies) {
      assert.equal(body.model, 'live-model');
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 1024);
      assert.equal(body.stream, false);
    }
    const thinking = bodies.map(body => (body.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking);
    assert.equal(thinking.filter(Boolean).length, 21);
    assert.equal(thinking.filter(value => !value).length, 21);
    // Paired order: s1 thinking on (2 calls) is followed by s1 thinking off on the same world and prompt.
    assert.deepEqual(thinking.slice(0, 4), [true, true, false, false]);
    assert.equal(prompts[0], prompts[2]);
    assert.equal(out.summary.byThinking.true.totalTokens, 21 * 15);
    assert.equal(out.summary.byThinking.false.totalTokens, 21 * 15);
    assert.equal(out.summary.byScenario.s2.goalReached, 0);
    assert.equal(out.summary.byScenario.s3.goalReached, 0);
    assert.equal(out.summary.byScenario.s1.goalReached, 6);
    const dumped = readFileSync(join(root, 'injected-live', 'summary.json'), 'utf8')
      + readFileSync(join(root, 'injected-live', 'games', 's1-thinking-on-rep-1', 'steps.json'), 'utf8');
    assert.equal(dumped.includes('sekret-eval'), false);
    assert.equal(dumped.includes(url), false);
    assert.equal(out.summary.errors.execute, 0);
    assert.equal(out.summary.errors.s3ExpectedNoFood, 6);
  } finally {
    await close(server);
  }
});

test('a transport failure is not retried and the failed game record is kept', async () => {
  let hits = 0;
  const fetchImpl: typeof fetch = async () => {
    hits += 1;
    return new Response('sekret-eval', { status: 500 });
  };
  const root = tempDir();
  const out = await runG02Eval({
    mode: 'live',
    root,
    batchId: 'no-retry',
    env: { FROSTECHO_LLM_URL: 'http://example.test/v1/chat/completions', FROSTECHO_LLM_MODEL: 'live-model', FROSTECHO_LLM_API_KEY: 'sekret-eval' },
    fetchImpl,
    health: async config => ({
      ok: true, checkedAt: '', modelsUrlPath: '/v1/models', status: 200, models: [config.model], expectedModel: config.model,
      modelMatch: true, kind: null, error: null, latencyMs: 0,
    }),
    scenarios: ['s1'],
    reps: 1,
    thinkingValues: [true],
  });
  assert.equal(hits, 1);
  assert.equal(out.exitCode, 1);
  assert.equal(out.summary.requestCount, 1);
  assert.equal(out.summary.retries, 0);
  assert.equal(out.summary.errors.transport, 1);
  assert.equal(out.summary.realModel, false);
  const gameDir = join(root, 'no-retry', 'games', 's1-thinking-on-rep-1');
  assert.equal(existsSync(join(gameDir, 'game.json')), true);
  const game = JSON.parse(readFileSync(join(gameDir, 'game.json'), 'utf8'));
  assert.equal(game.scenarioPass, false);
  assert.equal(game.goalReached, false);
  assert.equal(game.outcome, 'provider_error');
  const text = readdirSync(gameDir).map(name => readFileSync(join(gameDir, name), 'utf8')).join('\n');
  assert.equal(text.includes('sekret-eval'), false);
});

test('the call cap stops new model calls at the configured maximum', async () => {
  const root = tempDir();
  const out = await runG02Eval({
    mode: 'fixture',
    root,
    batchId: 'capped',
    maxCalls: 2,
    now: () => 0,
  });
  assert.equal(out.summary.requestCount, 2);
  assert.equal(out.summary.callCapExceeded, true);
  assert.equal(out.summary.gamesRun, 1);
  assert.equal(out.exitCode, 1);
  assert.equal(existsSync(join(root, 'capped', 'games', 's1-thinking-on-rep-1', 'game.json')), true);
});

test('eval CLI fixture passes and a missing live config exits 2 without writing a real-model claim', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['FROSTECHO_LLM_URL', 'FROSTECHO_LLM_MODEL', 'FROSTECHO_LLM_API_KEY', 'FROSTECHO_LLM_THINKING']) delete env[key];
  const missingDir = tempDir();
  const missing = await runNode([], { ...env, FROSTECHO_G02_ARTIFACT_DIR: missingDir });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /FROSTECHO_LLM_URL/);
  assert.match(missing.stderr, /FROSTECHO_LLM_MODEL/);
  assert.equal(missing.stdout.includes('realModel=true'), false);
  assert.equal(readdirSync(missingDir).length, 0);

  const fixtureDir = tempDir();
  const fixture = await runNode(['--fixture', '--batch', 'cli-fixture'], { ...env, FROSTECHO_G02_ARTIFACT_DIR: fixtureDir });
  assert.equal(fixture.code, 0, fixture.stderr + fixture.stdout);
  assert.match(fixture.stdout, /realModel=false/);
  assert.match(fixture.stdout, /games=18\/18/);
  assert.match(fixture.stdout, /scenario s2 pass=6\/6 goalReached=0/);
  assert.match(fixture.stdout, /scenario s3 pass=6\/6 goalReached=0/);
  const summary = JSON.parse(readFileSync(join(fixtureDir, 'cli-fixture', 'summary.json'), 'utf8'));
  assert.equal(summary.realModel, false);
  assert.equal(summary.thinkingDefault, true);
  assert.equal(summary.requestCount, 42);
  assert.equal(HTTP_SAMPLING.chat_template_kwargs.enable_thinking, true);
});
