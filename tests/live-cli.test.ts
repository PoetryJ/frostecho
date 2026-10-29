import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initialWorld, replay, RULES } from '../src';
import { DEFAULT_TIMEOUT_MS } from '../src/agent';

const DEMO = join('dist', 'scripts', 'demo.js');
const DEMO_G01 = join('dist', 'scripts', 'demo-g01.js');
const LIVE = join('dist', 'scripts', 'demo-g01-live.js');
const KEY = 'sekret-live-xyz';
const SAMPLING = {
  temperature: 0,
  max_tokens: 1024,
  stream: false,
  chat_template_kwargs: { enable_thinking: true },
};

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

function runNode(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out ${script}\n${stdout}\n${stderr}`));
    }, 20_000);
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

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['FROSTECHO_LLM_URL', 'FROSTECHO_LLM_MODEL', 'FROSTECHO_LLM_API_KEY', 'FROSTECHO_LIVE_ARTIFACT_DIR', 'FROSTECHO_LIVE_TIMEOUT_MS']) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

type Reply = { status: number; payload: unknown } | { hang: true };

function startChat(handler: (index: number) => Reply): Promise<{ url: string; hits: () => number; bodies: () => Record<string, unknown>[]; auths: () => (string | undefined)[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = [];
  const auths: (string | undefined)[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    const index = n++;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => undefined);
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { body = {}; }
      bodies.push(body);
      auths.push(typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined);
      const reply = handler(index);
      if ('hang' in reply) return;
      res.statusCode = reply.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply.payload));
    });
  });
  return listen(server).then(port => ({
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    hits: () => n,
    bodies: () => bodies.slice(),
    auths: () => auths.slice(),
    close: () => close(server),
  }));
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-live-'));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readRun(dir: string, index: number) {
  const runDir = join(dir, `run-${index}`);
  return {
    initial: readJson(join(runDir, 'initial-state.json')),
    steps: readJson(join(runDir, 'steps.json')),
    events: readJson(join(runDir, 'events.json')),
    final: readJson(join(runDir, 'final-state.json')),
    replayFile: readJson(join(runDir, 'replay.json')),
    meta: readJson(join(runDir, 'meta.json')),
  };
}

function filesText(root: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(readFileSync(path, 'utf8'));
    }
  };
  if (existsSync(root)) walk(root);
  return out.join('\n');
}

function assertSummaryMatches(dir: string) {
  const summary = readJson(join(dir, 'summary.json'));
  assert.equal(summary.runs.length, 3);
  let requests = 0;
  for (const run of summary.runs) {
    const index = Number(String(run.name).slice(4));
    const record = readRun(dir, index);
    assert.equal(run.stepCount, record.steps.length);
    assert.deepEqual(run.raw, record.steps.map((step: { raw: string }) => step.raw));
    assert.deepEqual(run.commands, record.steps.map((step: { command?: { type?: string } }) => step.command?.type ?? null));
    assert.deepEqual(run.stepErrors, record.steps.map((step: { error?: string }) => step.error ?? null));
    assert.equal(run.goalReached, record.meta.goalReached);
    assert.equal(run.providerCalls, record.meta.providerCalls);
    assert.equal(run.outcome, record.meta.outcome);
    assert.equal(run.model, record.meta.model);
    assert.deepEqual(run.sampling, record.meta.sampling);
    assert.deepEqual(run.timing, record.meta.timing);
    assert.deepEqual(run.requestStats, record.meta.requestStats);
    assert.deepEqual(replay(record.initial, record.events), record.final);
    assert.equal(run.replayMatches, record.replayFile.matches === true);
    requests += run.providerCalls;
  }
  assert.equal(summary.requestCount, requests);
  assert.equal(summary.successCount, summary.runs.filter((run: { goalReached: boolean; replayMatches: boolean }) => run.goalReached && run.replayMatches).length);
  return summary;
}

function assertSampling(body: Record<string, unknown>) {
  assert.equal(body.model, 'live-model');
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.stream, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(body.chat_template_kwargs, SAMPLING.chat_template_kwargs);
  const messages = body.messages as { role: string; content: string }[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content.includes('npc_b'), false);
  assert.equal(messages[0].content.includes(KEY), false);
  assert.equal(messages[0].content.includes('NpcMoved'), false);
  assert.match(messages[0].content, /hunger is satiety/);
  assert.match(messages[0].content, /Eat only in the kitchen/);
  assert.match(messages[0].content, new RegExp(`consumes ${RULES.EAT_FOOD_COST} food`));
  assert.match(messages[0].content, new RegExp(`restores ${RULES.EAT_HUNGER_RESTORE} hunger`));
  assert.match(messages[0].content, /Do not set actorId/);
  assert.match(messages[0].content, /Engine\.submit/);
}

function assertNoSecrets(dir: string, url: string, stdout: string, stderr: string) {
  const text = filesText(dir);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes(url), false);
  assert.equal(text.includes('Bearer'), false);
  assert.equal(stdout.includes(KEY), false);
  assert.equal(stderr.includes(KEY), false);
  assert.equal(stdout.includes(url), false);
}

function assertUnchanged(record: ReturnType<typeof readRun>) {
  assert.deepEqual(record.final, record.initial);
  assert.deepEqual(record.events, []);
  assert.equal(record.initial.npcs.npc_a.location, 'dorm');
  assert.equal(record.initial.npcs.npc_a.hunger, 40);
  assert.equal(record.initial.food.kitchen, initialWorld().food.kitchen);
  assert.equal(record.steps.every((step: { command?: unknown }) => step.command === undefined), true);
}

function message(content: string, reasoning: string) {
  return {
    status: 200 as const,
    payload: {
      choices: [{
        message: {
          content,
          reasoning_content: reasoning,
          reasoning: '{"type":"stop"}',
        },
      }],
    },
  };
}

test('offline entries do not network when live env is set', async () => {
  const chat = await startChat(() => ({ status: 500, payload: { error: KEY } }));
  try {
    const pkg = readJson('package.json');
    assert.equal(pkg.scripts.demo, 'npm run build && node dist/scripts/demo.js');
    assert.equal(pkg.scripts['demo:g01'], 'npm run build && node dist/scripts/demo-g01.js');
    assert.equal(pkg.scripts['demo:g01:live'], 'npm run build && node dist/scripts/demo-g01-live.js');
    const env = childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LLM_API_KEY: KEY,
    });
    const demo = await runNode(DEMO, env);
    const offline = await runNode(DEMO_G01, env);
    assert.equal(demo.code, 0);
    assert.equal(offline.code, 0);
    assert.match(offline.stdout, /goalReached=true/);
    assert.match(offline.stdout, /replay matches final state: true/);
    assert.equal(offline.stdout.includes('REAL MODEL'), false);
    assert.equal(demo.stdout.includes(KEY), false);
    assert.equal(offline.stdout.includes(KEY), false);
    assert.equal(chat.hits(), 0);
  } finally {
    await chat.close();
  }
});

test('missing live config exits 2 and does not call the network', async () => {
  const chat = await startChat(() => ({ status: 200, payload: { choices: [{ message: { content: '{"type":"eat"}' } }] } }));
  const dir = tempDir();
  try {
    const absent = await runNode(LIVE, childEnv({ FROSTECHO_LIVE_ARTIFACT_DIR: dir }));
    assert.equal(absent.code, 2);
    assert.match(absent.stderr, /FROSTECHO_LLM_URL/);
    assert.match(absent.stderr, /FROSTECHO_LLM_MODEL/);
    assert.equal(existsSync(join(dir, 'summary.json')), false);
    assert.equal(chat.hits(), 0);

    const urlOnly = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_API_KEY: KEY,
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(urlOnly.code, 2);
    assert.match(urlOnly.stderr, /FROSTECHO_LLM_MODEL/);
    assert.equal(urlOnly.stderr.includes(KEY), false);

    const modelOnly = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(modelOnly.code, 2);
    assert.match(modelOnly.stderr, /FROSTECHO_LLM_URL/);

    const blank = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: '   ',
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(blank.code, 2);
    assert.equal(chat.hits(), 0);
    assert.equal(existsSync(join(dir, 'summary.json')), false);
  } finally {
    await chat.close();
  }
});

test('fake HTTP happy path meets the goal three times, replays, and exits 0', async () => {
  const chat = await startChat(index => message(
    index % 2 === 0 ? '{"type":"move","to":"kitchen"}' : '{"type":"eat"}',
    index % 2 === 0 ? '{"type":"eat"}' : '{"type":"move","to":"kitchen"}',
  ));
  const dir = tempDir();
  try {
    const result = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LLM_API_KEY: KEY,
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /exit=0/);
    assert.equal(chat.hits(), 6);
    assert.equal(chat.bodies().length, 6);
    assert.deepEqual(chat.auths(), Array(6).fill(`Bearer ${KEY}`));
    for (const body of chat.bodies()) assertSampling(body);

    const summary = assertSummaryMatches(dir);
    assert.equal(summary.successCount, 3);
    assert.equal(summary.requestCount, 6);
    assert.equal(summary.allGoalReached, true);
    assert.equal(summary.allReplayMatch, true);
    for (let i = 1; i <= 3; i++) {
      const record = readRun(dir, i);
      assert.equal(record.initial.npcs.npc_a.location, 'dorm');
      assert.equal(record.initial.npcs.npc_a.hunger, 40);
      assert.equal(record.initial.food.kitchen, 1);
      assert.equal(record.steps.length, 2);
      assert.equal(record.steps[0].observation.location, 'dorm');
      assert.equal(record.steps[0].observation.hunger, 40);
      assert.equal(record.steps[0].observation.foodHere, 0);
      assert.equal(JSON.stringify(record.steps[0].observation).includes('npc_b'), false);
      assert.equal(record.steps[0].raw, '{"type":"move","to":"kitchen"}');
      assert.equal(record.steps[0].parse.ok, true);
      assert.equal(record.steps[0].command.type, 'move');
      assert.equal(record.steps[0].command.actorId, 'npc_a');
      assert.equal(record.steps[0].command.commandId, `g01-live-${i}:1`);
      assert.equal(record.steps[0].exec.status, 'accepted');
      assert.equal(record.steps[1].observation.location, 'kitchen');
      assert.equal(record.steps[1].observation.foodHere, 1);
      assert.equal(record.steps[1].observation.hunger, 40);
      assert.equal(record.steps[1].raw, '{"type":"eat"}');
      assert.equal(record.steps[1].command.type, 'eat');
      assert.equal(record.steps[1].command.actorId, 'npc_a');
      assert.equal(record.steps[1].command.commandId, `g01-live-${i}:2`);
      assert.equal(record.steps[1].exec.status, 'accepted');
      assert.deepEqual(record.events.map((event: { type: string }) => event.type), ['NpcMoved', 'FoodConsumed', 'HungerChanged']);
      assert.equal(record.final.npcs.npc_a.location, 'kitchen');
      assert.equal(record.final.npcs.npc_a.hunger, 70);
      assert.equal(record.final.npcs.npc_a.hunger, 40 + RULES.EAT_HUNGER_RESTORE);
      assert.equal(record.final.food.kitchen, 0);
      assert.deepEqual(record.final.npcs.npc_b, { id: 'npc_b', location: 'dorm', hunger: 20 });
      assert.equal(record.replayFile.matches, true);
      assert.equal(record.meta.outcome, 'goal_reached');
      assert.equal(record.meta.goalReached, true);
      assert.equal(record.meta.providerCalls, 2);
      assert.equal(record.meta.model, 'live-model');
      assert.equal(record.meta.apiKey, 'present');
      assert.deepEqual(record.meta.sampling, SAMPLING);
      assert.equal(record.meta.requestStats.retries, 0);
      assert.equal(record.meta.requestStats.maxDecisions, 5);
      assert.equal(record.meta.requestStats.timeoutMs, DEFAULT_TIMEOUT_MS);
      assert.equal(record.meta.requestStats.providerCalls, 2);
      assert.equal(summary.runs[i - 1].finalHunger, 70);
      assert.deepEqual(summary.runs[i - 1].commands, ['move', 'eat']);
    }
    assertNoSecrets(dir, chat.url, result.stdout, result.stderr);
  } finally {
    await chat.close();
  }
});

test('HTTP 500 exits 1, keeps failure records, and does not change the world', async () => {
  const chat = await startChat(() => ({
    status: 500,
    payload: { error: KEY, choices: [{ message: { content: '{"type":"eat"}', reasoning_content: '{"type":"move","to":"kitchen"}' } }] },
  }));
  const dir = tempDir();
  try {
    const result = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LLM_API_KEY: KEY,
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(result.code, 1);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /exit=1/);
    assert.equal(chat.hits(), 3);
    const summary = assertSummaryMatches(dir);
    assert.equal(summary.successCount, 0);
    assert.equal(summary.allGoalReached, false);
    assert.equal(summary.requestCount, 3);
    for (let i = 1; i <= 3; i++) {
      const record = readRun(dir, i);
      assertUnchanged(record);
      assert.equal(record.steps.length, 1);
      assert.equal(record.steps[0].raw, '');
      assert.equal(record.steps[0].error, 'http 500');
      assert.equal(record.meta.outcome, 'provider_error');
      assert.equal(record.meta.goalReached, false);
      assert.equal(record.meta.providerCalls, 1);
      assert.equal(record.meta.requestStats.retries, 0);
      assert.equal(record.replayFile.matches, true);
    }
    assertNoSecrets(dir, chat.url, result.stdout, result.stderr);
  } finally {
    await chat.close();
  }
});

test('live timeout exits 1 without applying a late action', { timeout: 20_000 }, async () => {
  const chat = await startChat(() => ({ hang: true }));
  const dir = tempDir();
  try {
    const result = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LLM_API_KEY: KEY,
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
      FROSTECHO_LIVE_TIMEOUT_MS: '200',
    }));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /exit=1/);
    assert.equal(chat.hits(), 3);
    const summary = assertSummaryMatches(dir);
    assert.equal(summary.successCount, 0);
    assert.equal(summary.requestCount, 3);
    for (let i = 1; i <= 3; i++) {
      const record = readRun(dir, i);
      assertUnchanged(record);
      assert.equal(record.steps.length, 1);
      assert.equal(record.steps[0].raw, '');
      assert.equal(record.steps[0].error, 'timeout');
      assert.equal(record.meta.outcome, 'timeout');
      assert.equal(record.meta.requestStats.timeoutMs, 200);
      assert.equal(record.meta.requestStats.retries, 0);
    }
    assertNoSecrets(dir, chat.url, result.stdout, result.stderr);
  } finally {
    await chat.close();
  }
});

test('consecutive illegal outputs exit 1 and ignore a legal action hidden in reasoning', async () => {
  const chat = await startChat(() => message('{"type":"fly"}', '{"type":"move","to":"kitchen"}'));
  const dir = tempDir();
  try {
    const result = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LLM_API_KEY: KEY,
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /exit=1/);
    assert.equal(chat.hits(), 15);
    for (const body of chat.bodies()) assertSampling(body);
    const summary = assertSummaryMatches(dir);
    assert.equal(summary.successCount, 0);
    assert.equal(summary.requestCount, 15);
    for (let i = 1; i <= 3; i++) {
      const record = readRun(dir, i);
      assertUnchanged(record);
      assert.equal(record.steps.length, 5);
      assert.equal(record.meta.outcome, 'budget_exhausted');
      assert.equal(record.meta.providerCalls, 5);
      assert.equal(record.meta.requestStats.maxDecisions, 5);
      assert.equal(record.meta.requestStats.retries, 0);
      for (const step of record.steps) {
        assert.equal(step.raw, '{"type":"fly"}');
        assert.equal(step.parse.ok, false);
        assert.equal(step.command, undefined);
        assert.equal(step.exec, undefined);
      }
      assert.deepEqual(summary.runs[i - 1].raw, record.steps.map((step: { raw: string }) => step.raw));
      assert.deepEqual(summary.runs[i - 1].commands, [null, null, null, null, null]);
    }
    assertNoSecrets(dir, chat.url, result.stdout, result.stderr);
  } finally {
    await chat.close();
  }
});

test('one failed live run among three exits 1', async () => {
  const chat = await startChat(index => {
    if (index >= 2) return { status: 500, payload: { error: KEY } };
    return message(index % 2 === 0 ? '{"type":"move","to":"kitchen"}' : '{"type":"eat"}', '{"type":"stop"}');
  });
  const dir = tempDir();
  try {
    const result = await runNode(LIVE, childEnv({
      FROSTECHO_LLM_URL: chat.url,
      FROSTECHO_LLM_MODEL: 'live-model',
      FROSTECHO_LLM_API_KEY: KEY,
      FROSTECHO_LIVE_ARTIFACT_DIR: dir,
    }));
    assert.equal(result.code, 1);
    assert.equal(chat.hits(), 4);
    const summary = assertSummaryMatches(dir);
    assert.equal(summary.successCount, 1);
    assert.equal(summary.requestCount, 4);
    const first = readRun(dir, 1);
    assert.equal(first.final.npcs.npc_a.hunger, 70);
    assert.equal(first.replayFile.matches, true);
    assertUnchanged(readRun(dir, 2));
    assertUnchanged(readRun(dir, 3));
    assertNoSecrets(dir, chat.url, result.stdout, result.stderr);
  } finally {
    await chat.close();
  }
});
