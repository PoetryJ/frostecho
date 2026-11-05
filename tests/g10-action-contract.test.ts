/**
 * G10 action-contract — independent black-box regression locks.
 *
 * Locked behaviours (asserted from outside the implementation):
 *  1. the action prompt renders the STRUCTURED active goal as its only goal;
 *     feed_self keeps its satiety target, yield_once drops the second goal,
 *     the pre-G10 prompt stays byte-identical, a restored session rebuilds
 *     the same active goal with no extra call;
 *  2. the original att-4 wire response (HTTP 200, finish_reason=length) is
 *     OUTPUT_TRUNCATED and never executed, even when the text looks like
 *     complete JSON; empty final content is EMPTY_FINAL_OUTPUT;
 *  3. an illegal first-episode action stops at exactly 2 POSTs and an illegal
 *     third-episode action at exactly 6, no scripted player eat, rest not_run;
 *  4. a legal stop/wait completes its phase; feed_self parses ok with no
 *     binding and no required NPC command;
 *  5. 4 attempted + 12 not_run phases → 2495 with unknown 0; a missing
 *     attempted usage → total null, known subtotal kept;
 *  6. tampered outcome/parseOk/token claims are rejected.
 *
 * The real-model evidence is READ-ONLY here; every POST goes to a test-owned
 * loopback server. No real model call is made.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/engine';
import { createAgentSession, stepAgent } from '../src/agent/runner';
import { exportSessionCheckpoint, restoreAgentSession } from '../src/agent/checkpoint';
import { createHttpProvider, renderDecidePrompt } from '../src/agent/providers/http';
import type { DecideInput } from '../src/agent/contracts';
import type { WorldState } from '../src/types';
import { countingWorld, scripted } from './agent-helpers';
import { deriveG09, frozenPlanEntries, readG09Batch } from '../scripts/g09-eval-lib';

const ROOT = process.cwd();
const EVAL = join(ROOT, 'dist/scripts/eval-g09.js');
const OLD_BATCH = join(ROOT, 'artifacts/g10-live/g10-live-20261105-r1');
const OLD_CAMPAIGN = join(ROOT, 'artifacts/g10-live/campaign-g10-approved16');
const OLD_ATT4_BEGIN = join(ROOT, 'handoff/20261105-g10-action-contract/review/response-review/g10-live-20261105-r1/attempts/att-0004.begin.json');

const OBSERVATION = { id: 'npc_a', location: 'kitchen' as const, hunger: 40, foodHere: 1, reachable: ['dorm' as const] };
const BASE_INPUT: DecideInput = {
  observation: OBSERVATION,
  goal: { hungerAtLeast: 70 },
  feedback: null,
  allowedActions: 'timed_wait',
};

/** The pre-G10 G08 template, verbatim: a drift here is a prompt regression. */
function legacyTemplate(): string {
  return [
    'Reply with one JSON object and no other text.',
    'allowedActions: ["move","eat","stop","wait"]',
    'Do not set actorId or commandId. World changes happen only through Engine.submit.',
    'hunger is satiety: higher means fuller.',
    'Eat only in the kitchen. Each eat consumes 1 food and restores 30 hunger, clamped to 0..100.',
    'Observation includes only this actor, food at the current location, and reachable places. Distant food, other NPCs, and the global log are omitted.',
    '"stop" ends your current session; with food present it also ends your pursuit this cycle. In an empty kitchen stop still follows the outer restock-wait and new-cycle rules.',
    '"wait" pauses your current session for one logical time step, then it resumes automatically; wait does not eat, move, or change the world. You may output {"type":"wait"} only when allowedActions includes "wait".',
    'goal: hunger >= 70',
    `observation: ${JSON.stringify(OBSERVATION)}`,
    'feedback: null',
  ].join('\n');
}

test('1. action prompt: structured active goal only; legacy prompt unchanged; feed_self keeps hunger', () => {
  assert.equal(renderDecidePrompt(BASE_INPUT), legacyTemplate(), 'pre-G10 prompts must stay byte-identical');

  const yieldPrompt = renderDecidePrompt({
    ...BASE_INPUT,
    activeGoal: { kind: 'yield_once', requestId: 'r1', expiresAtSimTime: 1 },
  });
  assert.ok(yieldPrompt.includes('activeGoal: {"kind":"yield_once","requestId":"r1","expiresAtSimTime":1}'));
  assert.ok(!/^goal: hunger/m.test(yieldPrompt), 'yield_once must not render a second satiety goal');
  assert.ok(yieldPrompt.includes('the player actually eats'), 'the agreement must be stated as the goal');
  assert.ok(!yieldPrompt.includes('npc_c'), 'no distant actor may leak into the prompt');
  assert.ok(!yieldPrompt.includes('"dorm":'), 'no distant food may leak into the prompt');

  const feedPrompt = renderDecidePrompt({ ...BASE_INPUT, activeGoal: { kind: 'feed_self', hungerAtLeast: 70 } });
  assert.ok(feedPrompt.includes('activeGoal: {"kind":"feed_self","hungerAtLeast":70}'));
  assert.ok(/^goal: hunger >= 70$/m.test(feedPrompt), 'feed_self keeps its satiety target');
});

test('1b. a restored session rebuilds the SAME active goal without a new goal choice', async () => {
  const world = (): WorldState => ({
    npcs: {
      npc_a: { id: 'npc_a', location: 'kitchen', hunger: 40 },
      npc_b: { id: 'npc_b', location: 'dorm', hunger: 40 },
      npc_c: { id: 'npc_c', location: 'kitchen', hunger: 70 },
    },
    food: { kitchen: 1, dorm: 0 },
    tick: 0,
    simTime: 0,
  });
  const seenA: DecideInput[] = [];
  const seenB: DecideInput[] = [];
  const provider = (seen: DecideInput[]) => scripted(['{"goal":"yield_once"}', '{"type":"wait"}'], seen).provider;
  const session = createAgentSession({
    world: countingWorld(new Engine(world())),
    provider: provider(seenA),
    runId: 'ep1:npc_a:c1',
    actorId: 'npc_a',
    actionSet: 'timed_wait',
    goalProtocol: {
      arm: 'choice', requestId: 'req-1', text: '请把最后一份食物留给我，你先不要吃。',
      options: ['feed_self', 'yield_once'], expiresAtSimTime: 1, playerId: 'npc_b',
    },
  });
  const first = await stepAgent(session);
  assert.equal(first.status, 'ready');
  const saved = exportSessionCheckpoint(session, 'g09');
  assert.equal(saved.ok, true);

  const restored = restoreAgentSession(structuredClone(saved.ok ? saved.value : null), {
    world: countingWorld(new Engine(world())),
    provider: provider(seenB),
    commandIdFor: round => `ep1:npc_a:c1:${round}`,
  });
  assert.equal(restored.ok, true, restored.ok ? '' : (restored.issues ?? []).join('; '));
  // The continuous branch takes its action step on the SAME session, so the
  // restored session's first call must equal the continuous branch's second.
  await stepAgent(session);
  await stepAgent(restored.ok ? restored.value : session);
  assert.deepEqual(seenB[0]?.activeGoal, { kind: 'yield_once', requestId: 'req-1', expiresAtSimTime: 1 });
  assert.deepEqual(seenB[0]?.activeGoal, seenA[1]?.activeGoal, 'restore must reproduce the identical active goal');
  assert.ok(!/^goal: hunger/m.test(renderDecidePrompt(seenB[0]!)), 'the restored prompt keeps the single-goal contract');
});

function wireBody(content: unknown, finishReason: string | null): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('2. response classification: the original att-4 truncation, a JSON-looking truncation, and empty content', async () => {
  const begin = JSON.parse(readFileSync(OLD_ATT4_BEGIN, 'utf8')) as { attemptId: string };
  assert.equal(begin.attemptId, 'att-0004');
  const record = JSON.parse(readFileSync(join(OLD_BATCH, 'episodes/g09-r1-s40-choice.json'), 'utf8')) as {
    http: { phase: string; response: { body: string } }[];
  };
  const att4Body = record.http.find(exchange => exchange.phase === 'action')!.response.body;

  const cases: { name: string; response: () => Response; code: string }[] = [
    { name: 'original att-4 (length, content null)', response: () => new Response(att4Body, { status: 200 }), code: 'OUTPUT_TRUNCATED' },
    { name: 'length + JSON-looking text', response: () => wireBody('{"type":"wait"}', 'length'), code: 'OUTPUT_TRUNCATED' },
    { name: 'normal finish + empty content', response: () => wireBody('', 'stop'), code: 'EMPTY_FINAL_OUTPUT' },
  ];
  for (const item of cases) {
    let calls = 0;
    const provider = createHttpProvider({
      url: 'http://fake.local/v1/chat/completions',
      model: 'fake-model',
      fetchImpl: (async () => { calls += 1; return item.response(); }) as typeof fetch,
    });
    await assert.rejects(
      () => provider.decide({ ...BASE_INPUT, activeGoal: { kind: 'yield_once', requestId: 'r', expiresAtSimTime: 1 } }, new AbortController().signal),
      (err: unknown) => (err as { code?: string }).code === item.code,
      item.name,
    );
    const transport = provider.consumeTransport?.();
    assert.equal(calls, 1, 'a classified failure is never retried');
    assert.equal(transport?.status, 200, 'HTTP 200 is kept, never rewritten as a network failure');
    assert.ok(transport?.usage !== null, 'usage is kept on a truncated/empty response');
    assert.equal(transport?.classification, item.code);
  }
});

/* ------------------------------------------------------------------ */
/* A test-owned HTTP server: the ONLY POSTs in this file.              */
/* ------------------------------------------------------------------ */

interface Script { actionFor: (index: number) => unknown }
interface FakeServer { url: string; posts: () => number; close: () => Promise<void> }

async function startFake(script: Script): Promise<FakeServer> {
  let posts = 0;
  let actions = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', () => {
      posts += 1;
      const body = JSON.parse(raw) as { messages: { content: string }[] };
      const prompt = body.messages[0].content;
      const isGoal = prompt.includes('candidateGoals:');
      let content: string;
      if (isGoal) {
        content = prompt.includes('"yield_once"') ? '{"goal":"yield_once"}' : '{"goal":"feed_self"}';
      } else {
        actions += 1;
        content = String(script.actionFor(actions));
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    posts: () => posts,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function runEval(args: string[], timeoutMs = 120_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [EVAL, ...args], { cwd: ROOT, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

interface EpisodeShape {
  outcome: string;
  playerEat: unknown;
  goal: { parseOk: boolean };
  binding: unknown;
  action: { type: string | null };
}

function readEpisodes(batchDir: string): Record<string, EpisodeShape> {
  const out: Record<string, EpisodeShape> = {};
  for (const name of readdirSync(join(batchDir, 'episodes'))) {
    const record = JSON.parse(readFileSync(join(batchDir, 'episodes', name), 'utf8')) as EpisodeShape & { episodeId: string };
    out[record.episodeId] = record;
  }
  return out;
}

test('3. an illegal FIRST action stops at exactly 2 POSTs, no scripted eat, rest not_run, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-g10ac-a1-'));
  const server = await startFake({ actionFor: () => '' });
  try {
    const result = await runEval([
      '--out', join(dir, 'out'), '--batch', 'illegal-first', '--campaign', join(dir, 'campaign'),
      '--campaign-limit', '16', '--live', '--http', server.url, '--model', 'fake-model',
    ]);
    assert.equal(server.posts(), 2, 'an illegal first action must stop after exactly 2 POSTs');
    assert.equal(result.code, 1, 'a failed episode is a non-zero batch');
    const episodes = readEpisodes(join(dir, 'out/illegal-first'));
    assert.equal(episodes['g09-r1-s40-self_only'].outcome, 'empty_output');
    assert.equal(episodes['g09-r1-s40-self_only'].playerEat, null, 'no scripted player eat after an illegal action');
    assert.equal(episodes['g09-r1-s60-choice'].outcome, 'not_run');
    const campaign = JSON.parse(readFileSync(join(dir, 'campaign/campaign.json'), 'utf8')) as { spent: number };
    assert.equal(campaign.spent, 2);
  } finally {
    await server.close();
  }
});

test('3b. an illegal THIRD action stops at exactly 6 POSTs (after the first-pair gate)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-g10ac-a3-'));
  const server = await startFake({ actionFor: index => (index === 3 ? '{"type":"dance"}' : '{"type":"eat"}') });
  try {
    const result = await runEval([
      '--out', join(dir, 'out'), '--batch', 'illegal-third', '--campaign', join(dir, 'campaign'),
      '--campaign-limit', '16', '--live', '--http', server.url, '--model', 'fake-model',
    ]);
    assert.equal(server.posts(), 6, 'the gate must not wait for the end of the batch');
    assert.equal(result.code, 1);
    const episodes = readEpisodes(join(dir, 'out/illegal-third'));
    assert.equal(episodes['g09-r1-s40-self_only'].outcome, 'completed');
    assert.equal(episodes['g09-r1-s40-choice'].outcome, 'completed');
    assert.equal(episodes['g09-r1-s60-self_only'].outcome, 'invalid_action');
    assert.equal(episodes['g09-r1-s60-self_only'].playerEat, null);
    assert.equal(episodes['g09-r1-s60-choice'].outcome, 'not_run');
  } finally {
    await server.close();
  }
});

test('4. a legal wait completes the phase; feed_self parses ok with no binding and no required command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-g10ac-w-'));
  const server = await startFake({ actionFor: () => '{"type":"wait"}' });
  try {
    const result = await runEval([
      '--out', join(dir, 'out'), '--batch', 'legal-wait', '--campaign', join(dir, 'campaign'),
      '--campaign-limit', '16', '--live', '--http', server.url, '--model', 'fake-model',
    ]);
    assert.equal(server.posts(), 16, 'a legal wait keeps the batch going');
    const episodes = readEpisodes(join(dir, 'out/legal-wait'));
    for (const record of Object.values(episodes)) {
      assert.equal(record.outcome, 'completed');
      assert.equal(record.action.type, 'wait');
    }
    const self = episodes['g09-r1-s40-self_only'];
    assert.equal(self.goal.parseOk, true, 'a legal feed_self parses ok without a binding');
    assert.equal(self.binding, null);
    const summary = JSON.parse(readFileSync(join(dir, 'out/legal-wait/summary.json'), 'utf8')) as {
      protocol: { planned: number; completed: number; failed: number; notRun: number; goalPhases: number; actionPhases: number };
    };
    assert.deepEqual(summary.protocol, { planned: 8, completed: 8, failed: 0, notRun: 0, goalPhases: 8, actionPhases: 8 });
    assert.equal(result.code, 0);
  } finally {
    await server.close();
  }
});

test('5. cost derivation: 2495 known with 0 unknown; a missing attempted usage propagates null but keeps the known subtotal', () => {
  const campaign = JSON.parse(readFileSync(join(OLD_CAMPAIGN, 'campaign.json'), 'utf8')) as { limit: number; spent: number };
  const derivation = deriveG09(readG09Batch(OLD_BATCH), frozenPlanEntries(), campaign);
  assert.equal(derivation.costs.chatRequests, 4);
  assert.equal(derivation.costs.usageUnknown, false);
  assert.equal(derivation.costs.goalTokens, 474);
  assert.equal(derivation.costs.actionTokens, 2021);
  assert.equal(derivation.costs.totalTokens, 2495);
  assert.equal(derivation.costs.knownTotalTokens, 2495);
  assert.equal(derivation.costs.unknownPhases, 0);
  assert.equal(derivation.costs.notRunPhases, 12, 'never-sent phases are not_run, not unknown');
  assert.deepEqual(
    { completed: derivation.protocol.completed, failed: derivation.protocol.failed, notRun: derivation.protocol.notRun },
    { completed: 1, failed: 1, notRun: 6 },
  );

  const copy = mkdtempSync(join(tmpdir(), 'fe-g10ac-cost-'));
  cpSync(OLD_BATCH, join(copy, 'batch'), { recursive: true });
  const episodePath = join(copy, 'batch/episodes/g09-r1-s40-choice.json');
  const episode = JSON.parse(readFileSync(episodePath, 'utf8')) as { http: { phase: string; response: { usage: unknown } }[] };
  const goalExchange = episode.http.find(exchange => exchange.phase === 'goal')!;
  goalExchange.response.usage = null;
  writeFileSync(episodePath, JSON.stringify(episode, null, 2));
  const patched = deriveG09(readG09Batch(join(copy, 'batch')), frozenPlanEntries(), campaign);
  assert.equal(patched.costs.totalTokens, null, 'an unknown attempted usage must propagate to the total');
  assert.equal(patched.costs.goalTokens, null);
  assert.equal(patched.costs.usageUnknown, true);
  assert.equal(patched.costs.knownGoalTokens, 474 - 231, 'the known subtotal must stay computable');
  assert.equal(patched.costs.knownTotalTokens, 2495 - 231);
});

test('6. tampered claims are rejected; the honest failure batch stays complete=false with a non-zero CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-g10ac-tamper-'));
  cpSync(OLD_BATCH, join(dir, 'batch'), { recursive: true });
  cpSync(OLD_CAMPAIGN, join(dir, 'campaign'), { recursive: true });
  const choicePath = join(dir, 'batch/episodes/g09-r1-s40-choice.json');
  const choice = JSON.parse(readFileSync(choicePath, 'utf8')) as { outcome: string };
  choice.outcome = 'completed';
  writeFileSync(choicePath, JSON.stringify(choice, null, 2));
  const selfPath = join(dir, 'batch/episodes/g09-r1-s40-self_only.json');
  const self = JSON.parse(readFileSync(selfPath, 'utf8')) as { tokens: { goal: number } };
  self.tokens.goal = 999;
  writeFileSync(selfPath, JSON.stringify(self, null, 2));

  const result = await runEval([
    '--verify', '--out', join(dir), '--batch', 'batch', '--campaign', join(dir, 'campaign'),
  ]);
  assert.equal(result.code, 1);
  assert.ok(result.stdout.includes('the recorded outcome completed disagrees with the derived output_truncated'));
  assert.ok(result.stdout.includes('the recorded goal tokens 999 disagree with the wire'));
  assert.ok(result.stdout.includes('complete=false'));
});
