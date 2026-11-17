/**
 * G07 worker D — independent tests for the player-message experiment.
 *
 * These tests do not import the implementation's own success counters. They
 * watch the world, the provider, the captured HTTP bodies and the files on
 * disk: a send may change nothing but the mailbox, the two arms must share one
 * template, strict parsing must reject forged authority, the 8-episode batch
 * must spend one request per episode, and a 500/timeout/budget stop must leave
 * the remaining slots not_run without overwriting or retrying anything.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderDecidePrompt } from '../src/agent/providers/http';
import type { DecideInput, Provider } from '../src/agent/contracts';
import { createMailbox, restoreMailbox } from '../src/communication/mailbox';
import { createMessageProvider } from '../src/communication/provider';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { ChatBudgetGate, createBudgetedProvider } from '../src/needs/live-budget';
import { runG07Batch, runPreflight, type G07RunOptions, type G07Preflight } from '../scripts/eval-g07';
import {
  G07_INITIAL_STATE, G07_PLAN, G07_SCENARIOS, G07_TARGET, G07_TIMEOUT_MS,
  playerMessagesLine, readBatch, requestConfigFor, sha256, strictAction,
  stripPromptData, templateFingerprint, verifyBatch,
} from '../scripts/g07-eval-lib';

const SAMPLE_INPUT: DecideInput = {
  observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: ['dorm', 'kitchen'] },
  goal: { hungerAtLeast: 70 },
  feedback: null,
};

const LOCAL_POSITIONS = { npc_b: 'kitchen', npc_a: 'kitchen', npc_c: 'kitchen' };

function promptOf(body: Record<string, unknown>): string {
  const messages = body.messages as { content?: string }[] | undefined;
  return String(messages?.[0]?.content ?? '');
}

function positionsOfFixture(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, npc] of Object.entries(G07_INITIAL_STATE.npcs)) out[id] = npc.location;
  return out;
}

interface FakeServer {
  url: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

async function startServer(options: { failAt?: number; content?: string; model?: string } = {}): Promise<FakeServer> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: options.model ?? 'fake-model' }] }));
        return;
      }
      res.statusCode = 404;
      res.end('no');
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      if (options.failAt !== undefined && requests.length === options.failAt) {
        res.statusCode = 500;
        res.end('{"error":"boom"}');
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: { content: options.content ?? '{"type":"stop"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

function batchOptions(url: string, out: string, batchId: string, extra: Partial<G07RunOptions> = {}): G07RunOptions {
  return {
    out,
    batchId,
    url,
    model: 'fake-model',
    fetchImpl: (input, init) => fetch(input, init),
    mode: 'fake',
    ...extra,
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g07-eval-'));
}

function dirDigest(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else parts.push(`${prefix}${name}\0${readFileSync(path, 'utf8')}`);
    }
  };
  walk(dir, '');
  return sha256(parts.join('\n'));
}

test('the plan is frozen at 2 scenarios x 2 arms x 2 reps in the contract order', () => {
  assert.equal(G07_PLAN.length, 8);
  assert.deepEqual(G07_PLAN.map(entry => entry.episodeId), [
    'g07-r1-s1-off', 'g07-r1-s1-on', 'g07-r1-s2-off', 'g07-r1-s2-on',
    'g07-r2-s1-on', 'g07-r2-s1-off', 'g07-r2-s2-on', 'g07-r2-s2-off',
  ]);
  assert.deepEqual(G07_PLAN.map(entry => `${entry.scenario}-${entry.arm}-r${entry.rep}`), [
    's1-off-r1', 's1-on-r1', 's2-off-r1', 's2-on-r1',
    's1-on-r2', 's1-off-r2', 's2-on-r2', 's2-off-r2',
  ]);
  for (const scenario of ['s1', 's2'] as const) {
    for (const arm of ['off', 'on'] as const) {
      assert.equal(G07_PLAN.filter(entry => entry.scenario === scenario && entry.arm === arm).length, 2);
    }
  }
  assert.equal(G07_SCENARIOS.s1, '请把最后一份食物留给我，你先不要吃。');
  assert.equal(G07_SCENARIOS.s2, '请你先吃这一份食物，不用留给我。');
});

test('both arms share one template: only the playerMessages line differs', () => {
  const off = renderDecidePrompt({ ...SAMPLE_INPUT, playerMessages: [] });
  const on = renderDecidePrompt({ ...SAMPLE_INPUT, playerMessages: [{ sender: 'npc_b', text: G07_SCENARIOS.s1 }] });
  const offLines = off.split('\n');
  const onLines = on.split('\n');
  assert.equal(offLines.length, onLines.length);
  const differing = offLines.map((line, index) => (line === onLines[index] ? null : index)).filter(index => index !== null);
  assert.equal(differing.length, 1, 'exactly one line may differ');
  const index = differing[0] as number;
  assert.equal(offLines[index], 'playerMessages: []');
  assert.equal(onLines[index], `playerMessages: [{"sender":"npc_b","text":"${G07_SCENARIOS.s1}"}]`);
  assert.equal(stripPromptData(off), stripPromptData(on));
  assert.equal(sha256(stripPromptData(off)), templateFingerprint());
  assert.equal(playerMessagesLine(off), 'playerMessages: []');
  assert.equal(playerMessagesLine(on), onLines[index]);
});

test('strict parsing rejects forged authority, unknown actions and malformed text', () => {
  assert.deepEqual(strictAction('{"type":"eat"}'), { type: 'eat' });
  assert.deepEqual(strictAction('{"type":"stop"}'), { type: 'stop' });
  assert.deepEqual(strictAction('{"type":"move","to":"dorm"}'), { type: 'move', to: 'dorm' });
  assert.equal(strictAction(null), null);
  for (const raw of [
    '{"type":"eat","actorId":"npc_c"}',
    '{"type":"eat","commandId":"x"}',
    '{"type":"stop","payload":{}}',
    '{"type":"restock","amount":3}',
    '{"type":"advance_time","steps":1}',
    '{"type":"move"}',
    '{"type":"move","to":"attic"}',
    '{"type":"move","to":"dorm","to":"kitchen"}',
    'sure: {"type":"eat"}',
    '[]',
    'null',
    '',
  ]) {
    assert.equal(strictAction(raw), 'invalid_output', `raw ${JSON.stringify(raw)} must be rejected`);
  }
});

test('send changes no world, ledger, call or transition state and calls no provider', () => {
  let decideCalls = 0;
  const providerFor = (): Provider => ({
    async decide() {
      decideCalls += 1;
      return '{"type":"stop"}';
    },
  });
  const game = createNeedsGame({
    episodeId: 'g07-d-send',
    initialState: structuredClone(G07_INITIAL_STATE),
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode: 'reference',
    needPolicy: 'recurring',
  });
  const before = game.snapshot();
  const mailbox = createMailbox();
  const receipt = mailbox.send({ commandId: 'd:say:1', to: G07_TARGET, text: G07_SCENARIOS.s1 }, positionsOfFixture());
  const after = game.snapshot();
  assert.equal(receipt.ok, true);
  assert.equal(decideCalls, 0);
  assert.deepEqual(after.finalState, before.finalState);
  assert.deepEqual(after.commands, before.commands);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.actors, before.actors);
  assert.deepEqual(after.cycles, before.cycles);
  assert.deepEqual(after.transitions, before.transitions);
  assert.equal(after.actors.npc_a.providerCalls, 0);
  assert.deepEqual(mailbox.status().pending.npc_a, [{ seq: 1, text: G07_SCENARIOS.s1 }]);
});

test('a distant recipient is rejected and never queued', () => {
  const mailbox = createMailbox();
  const rejected = mailbox.send({ commandId: 'far', to: 'npc_c', text: 'hi' }, { npc_b: 'kitchen', npc_a: 'kitchen', npc_c: 'dorm' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok ? '' : rejected.code, 'NOT_LOCAL');
  assert.deepEqual(mailbox.status().pending, {});
  assert.equal(mailbox.status().messageSeq, 0);
});

test('a budget denial spends no message: no bind, no HTTP, pending kept', async () => {
  const mailbox = createMailbox();
  mailbox.send({ commandId: 'b1', to: G07_TARGET, text: G07_SCENARIOS.s2 }, LOCAL_POSITIONS);
  let innerCalls = 0;
  const gate = new ChatBudgetGate(0);
  const provider = createBudgetedProvider({
    gate,
    inner: createMessageProvider({
      async decide() {
        innerCalls += 1;
        return '{"type":"eat"}';
      },
    }, mailbox, { enabled: true, actorId: G07_TARGET }),
    requestConfig: requestConfigFor('fake-model', G07_TIMEOUT_MS),
    episodeId: 'g07-d-budget',
    actorId: G07_TARGET,
    cycle: 1,
    hooks: {
      beginAttempt: () => assert.fail('a denied attempt must not begin'),
      finishAttempt: () => assert.fail('a denied attempt must not finish'),
      recordBlocked: () => undefined,
    },
  });
  await assert.rejects(provider.decide(SAMPLE_INPUT, new AbortController().signal), /chat budget exhausted/);
  assert.equal(innerCalls, 0);
  assert.equal(gate.blocked, 1);
  assert.equal(gate.spent, 0);
  assert.equal(mailbox.status().bindSeq, 0);
  assert.deepEqual(mailbox.status().pending.npc_a, [{ seq: 1, text: G07_SCENARIOS.s2 }]);
});

test('an in-flight bind is frozen: a later send waits for the next decide', async () => {
  const mailbox = createMailbox();
  mailbox.send({ commandId: 'i1', to: G07_TARGET, text: 'first' }, LOCAL_POSITIONS);
  let release: () => void = () => undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let boundText = '';
  const inner: Provider = {
    async decide(input) {
      boundText = input.playerMessages?.[0]?.text ?? '';
      await barrier;
      return '{"type":"stop"}';
    },
  };
  const provider = createMessageProvider(inner, mailbox, { enabled: true, actorId: G07_TARGET });
  const inFlight = provider.decide(SAMPLE_INPUT, new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  mailbox.send({ commandId: 'i2', to: G07_TARGET, text: 'second' }, LOCAL_POSITIONS);
  release();
  await inFlight;
  assert.equal(boundText, 'first');
  const next = mailbox.bindNext(G07_TARGET, true);
  assert.equal(next.ok, true);
  assert.deepEqual(next.ok ? next.value.messages : [], [{ sender: 'npc_b', text: 'second' }]);
});

test('a restore does not redeliver a consumed message', async () => {
  const mailbox = createMailbox();
  mailbox.send({ commandId: 'r1', to: G07_TARGET, text: 'once' }, LOCAL_POSITIONS);
  const provider = createMessageProvider({
    async decide() { return '{"type":"stop"}'; },
  }, mailbox, { enabled: true, actorId: G07_TARGET });
  await provider.decide(SAMPLE_INPUT, new AbortController().signal);
  const snapshot = mailbox.export();
  const restored = restoreMailbox(snapshot);
  assert.equal(restored.ok, true);
  const box = restored.ok ? restored.value : mailbox;
  assert.equal(box.status().pending.npc_a, undefined);
  const bound = box.bindNext(G07_TARGET, true);
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.ok ? bound.value.messages : [], []);
});

test('the fixed 8-episode fake batch: one request each, identical templates, verifiable evidence', async () => {
  const server = await startServer();
  const root = tempRoot();
  try {
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-batch'));
    assert.equal(result.exitCode, 0);
    assert.equal(server.requests.length, 8, 'exactly one chat request per episode');
    assert.equal(result.summary.totals.completed, 8);
    assert.equal(result.summary.budget.spent, 8);
    assert.equal(result.summary.budget.limit, 8);
    assert.equal(result.summary.pairs.length, 4);
    assert.equal(result.summary.structuralGate.ok, true);

    const lines = server.requests.map(body => playerMessagesLine(promptOf(body)));
    assert.equal(lines.filter(line => line === 'playerMessages: []').length, 4);
    const onLines = lines.filter((line): line is string => line !== null
      && line !== 'playerMessages: []'
      && line.startsWith('playerMessages: ['));
    assert.equal(onLines.length, 4);
    for (const line of onLines) {
      const data = JSON.parse(line.slice('playerMessages:'.length)) as { sender: string; text: string }[];
      assert.equal(data.length, 1);
      assert.equal(data[0].sender, 'npc_b');
      assert.ok(data[0].text === G07_SCENARIOS.s1 || data[0].text === G07_SCENARIOS.s2);
    }
    const templates = new Set(server.requests.map(body => sha256(stripPromptData(promptOf(body)))));
    assert.equal(templates.size, 1, 'all eight prompts share one template');
    assert.equal([...templates][0], templateFingerprint());

    for (const body of server.requests) {
      assert.equal(body.model, 'fake-model');
      assert.equal(body.temperature, 0);
      assert.equal(body.max_tokens, 1024);
      assert.equal(body.stream, false);
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    }
    for (const body of server.requests) {
      const line = playerMessagesLine(promptOf(body));
      if (line === 'playerMessages: []') {
        assert.equal(promptOf(body).includes(G07_SCENARIOS.s1), false, 'off arm must not leak text');
        assert.equal(promptOf(body).includes(G07_SCENARIOS.s2), false, 'off arm must not leak text');
      }
    }

    const batch = readBatch(result.batchDir);
    assert.equal(batch.episodes.size, 8);
    assert.equal(batch.statuses.size, 8);
    assert.equal(batch.attempts.begins.length, 8);
    assert.equal(batch.attempts.finishes.length, 8);
    for (const record of batch.episodes.values()) {
      assert.equal(record.http.length, 1);
      assert.equal(record.attempts.length, 1);
      assert.equal(record.behavior?.npcAte, false);
      assert.equal(record.behavior?.foodAfterNpc, 1);
      assert.equal(record.behavior?.playerEat.ok, true, 'the player gets the food after a stop');
      assert.equal(record.replayMatches, true);
      assert.equal(record.outcome, 'completed');
    }

    const verified = verifyBatch(result.batchDir);
    assert.deepEqual(verified.issues, []);
    assert.equal(verified.ok, true);
    assert.equal(verified.stats.http, 8);
    assert.equal(verified.stats.attempts, 8);
    assert.equal(verified.stats.spent, 8);
    assert.equal(verified.stats.mode, 'fake');

    await assert.rejects(
      runG07Batch(batchOptions(server.url, root, 'g07-batch')),
      /already exists/,
      'a second run must not overwrite evidence',
    );
    assert.equal(server.requests.length, 8, 'the rejected rerun sent no request');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify is read-only', async () => {
  const server = await startServer();
  const root = tempRoot();
  try {
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-readonly'));
    const before = dirDigest(result.batchDir);
    const first = verifyBatch(result.batchDir);
    const second = verifyBatch(result.batchDir);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(dirDigest(result.batchDir), before, 'verify must not create or rewrite files');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('G07-R1: omitting --timeout wires the effective 120000 ms into every layer', async () => {
  const server = await startServer();
  const root = tempRoot();
  try {
    // batchOptions carries no timeoutMs, so runG07Batch normalizes to the
    // frozen 120000 ms; the fake server answers instantly, nothing waits.
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-wiring'));
    assert.equal(result.exitCode, 0);
    assert.equal(server.requests.length, 8);

    const plan = JSON.parse(readFileSync(join(result.batchDir, 'plan.json'), 'utf8')) as {
      requestConfig: { timeoutMs: number };
    };
    assert.equal(plan.requestConfig.timeoutMs, G07_TIMEOUT_MS, 'plan layer');

    const batch = readBatch(result.batchDir);
    for (const record of batch.episodes.values()) {
      assert.equal(record.requestConfig.timeoutMs, G07_TIMEOUT_MS, 'episode ledger layer');
      assert.equal(record.snapshot.requestConfig.timeoutMs, G07_TIMEOUT_MS,
        'the game/session layer must run the normalized timeout, not the 15000 ms fallback');
      for (const attempt of record.attempts) {
        assert.equal(attempt.begin.requestConfig.timeoutMs, G07_TIMEOUT_MS, 'attempt begin layer');
      }
    }

    const verified = verifyBatch(result.batchDir);
    assert.equal(verified.ok, true);
    assert.equal(verified.behaviorAndCostOk, true);
    assert.equal(verified.configurationConsistent, true);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('G07-R1: a snapshot/plan timeout divergence is a configuration issue, not a behaviour failure', async () => {
  const server = await startServer();
  const root = tempRoot();
  try {
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-divergence'));
    assert.equal(result.exitCode, 0);
    // Reproduce the shipped-batch state on disk: the game layer actually ran
    // 15000 ms while the plan and the ledger recorded 120000 ms.
    const episodesDir = join(result.batchDir, 'episodes');
    for (const name of readdirSync(episodesDir)) {
      const path = join(episodesDir, name);
      const episode = JSON.parse(readFileSync(path, 'utf8')) as {
        snapshot: { requestConfig: { timeoutMs: number } };
      };
      episode.snapshot.requestConfig.timeoutMs = 15000;
      writeFileSync(path, JSON.stringify(episode, null, 2));
    }
    const verified = verifyBatch(result.batchDir);
    assert.equal(verified.ok, false, 'strict verify reports the mismatch');
    assert.equal(verified.behaviorAndCostOk, true, 'the behaviour and cost evidence stays valid');
    assert.equal(verified.configurationConsistent, false);
    assert.ok(verified.configurationIssues.length >= 8, 'every diverging episode is flagged');
    assert.ok(verified.configurationIssues.every(issue => issue.includes('timeout')));
    // No whitelisting: the mismatch is also visible in the full issue list.
    assert.ok(verified.issues.some(issue => issue.includes('differs from the planned 120000 ms')));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an HTTP 500 stops the batch: failed record saved, later slots not_run, no retry', async () => {
  const server = await startServer({ failAt: 3 });
  const root = tempRoot();
  try {
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-500'));
    assert.equal(server.requests.length, 3, 'no retry and no later request');
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.totals.completed, 2);
    assert.equal(result.summary.totals.failed, 1);
    assert.equal(result.summary.totals.notRun, 5);
    assert.equal(result.summary.budget.spent, 3);
    assert.notEqual(result.summary.fatal, null);

    const batch = readBatch(result.batchDir);
    assert.equal(batch.episodes.size, 3);
    assert.equal(batch.episodes.get('g07-r1-s2-off')?.outcome, 'transport_failure');
    assert.equal(batch.statuses.get('g07-r1-s2-off')?.status, 'failed');
    for (const id of ['g07-r1-s2-on', 'g07-r2-s1-on', 'g07-r2-s1-off', 'g07-r2-s2-on', 'g07-r2-s2-off']) {
      assert.equal(batch.statuses.get(id)?.status, 'not_run', `${id} must be not_run`);
      assert.equal(batch.episodes.get(id), undefined, `${id} must have no episode record`);
      assert.equal(batch.attempts.begins.some(begin => begin.episodeId === id), false, `${id} must spend no attempt`);
    }

    const verified = verifyBatch(result.batchDir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('transport_failure')), 'verify must surface the failure');
    assert.equal(verified.stats.spent, 3);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a timeout stops the batch after one attempt, with no captured response and no retry', async () => {
  const root = tempRoot();
  let calls = 0;
  const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    calls += 1;
    const signal = init?.signal;
    const abort = (): void => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await runG07Batch(batchOptions('http://127.0.0.1:1/v1/chat/completions', root, 'g07-timeout', {
      fetchImpl,
      timeoutMs: 150,
    }));
    assert.equal(calls, 1, 'exactly one attempt, no retry');
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.totals.completed, 0);
    assert.equal(result.summary.totals.failed, 1);
    assert.equal(result.summary.totals.notRun, 7);
    assert.equal(result.summary.budget.spent, 1);

    const batch = readBatch(result.batchDir);
    const record = batch.episodes.get('g07-r1-s1-off');
    assert.ok(record !== undefined);
    assert.equal(record.outcome, 'transport_failure');
    assert.ok((record.failure ?? '').includes('timeout'));
    assert.equal(record.http.length, 0);
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0]?.finish?.outcome, 'timeout');
    assert.equal(batch.statuses.get('g07-r1-s1-on')?.status, 'not_run');

    const verified = verifyBatch(result.batchDir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('transport_failure')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a budget stop happens before the request: message stays pending, rest not_run', async () => {
  const server = await startServer();
  const root = tempRoot();
  try {
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-budget', { limit: 2 }));
    assert.equal(server.requests.length, 2, 'the third decision is denied locally');
    assert.equal(result.exitCode, 1);
    assert.equal(result.summary.totals.completed, 2);
    assert.equal(result.summary.totals.failed, 1);
    assert.equal(result.summary.totals.notRun, 5);
    assert.equal(result.summary.budget.spent, 2);
    assert.equal(result.summary.budget.blocked, 1);

    const batch = readBatch(result.batchDir);
    const blocked = batch.episodes.get('g07-r1-s2-off');
    assert.ok(blocked !== undefined);
    assert.equal(blocked.outcome, 'budget_blocked');
    assert.equal(blocked.attempts.length, 0);
    assert.equal(blocked.http.length, 0);
    assert.equal(blocked.mailbox.bindSeq, 0);
    assert.equal(blocked.mailbox.pending.npc_a?.length, 1);
    assert.equal(batch.attempts.blocked.length, 1);
    assert.equal(batch.attempts.blocked[0]?.episodeId, 'g07-r1-s2-off');
    assert.equal(batch.statuses.get('g07-r2-s1-on')?.status, 'not_run');

    const verified = verifyBatch(result.batchDir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('budget_blocked')));
    assert.equal(verified.stats.spent, 2);
    assert.equal(verified.stats.blocked, 1);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a goal pre-check consumes no message and calls no provider', async () => {
  let calls = 0;
  const mailbox = createMailbox();
  mailbox.send({ commandId: 'goal', to: G07_TARGET, text: 'hold it' }, LOCAL_POSITIONS);
  const providerFor = (): Provider => createMessageProvider({
    async decide() {
      calls += 1;
      return '{"type":"stop"}';
    },
  }, mailbox, { enabled: true, actorId: G07_TARGET });
  const game = createNeedsGame({
    episodeId: 'g07-d-goal',
    initialState: buildNeedsWorld({ kitchenFood: 1 }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode: 'reference',
    needPolicy: 'recurring',
  });
  await game.runUntilIdle();
  assert.equal(calls, 0);
  assert.equal(mailbox.status().bindSeq, 0);
  assert.deepEqual(mailbox.status().pending.npc_a, [{ seq: 1, text: 'hold it' }]);
});

test('a forged actorId is recorded as invalid_output and never submitted', async () => {
  const server = await startServer({ content: '{"type":"eat","actorId":"npc_c"}' });
  const root = tempRoot();
  try {
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-forged'));
    assert.equal(result.exitCode, 0);
    const batch = readBatch(result.batchDir);
    for (const record of batch.episodes.values()) {
      assert.equal(record.behavior?.npcAction, 'invalid_output');
      assert.equal(record.behavior?.npcAte, false);
      assert.equal(record.behavior?.npcEat, null);
      assert.equal(record.snapshot.commands.some(command => command.command.actorId === 'npc_c'), false);
      assert.equal(record.snapshot.finalState.npcs.npc_c.hunger, 70);
    }
    const verified = verifyBatch(result.batchDir);
    assert.equal(verified.ok, true);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh process does not redeliver a consumed message', () => {
  const mailbox = createMailbox();
  mailbox.send({ commandId: 'x1', to: G07_TARGET, text: 'once' }, LOCAL_POSITIONS);
  const bound = mailbox.bindNext(G07_TARGET, true);
  assert.equal(bound.ok, true);
  mailbox.completeBind(bound.ok ? bound.value.bindSeq : 0, 'attempted');
  const root = tempRoot();
  const file = join(root, 'mailbox.json');
  try {
    writeFileSync(file, JSON.stringify(mailbox.export()), 'utf8');
    const modulePath = join(__dirname, '..', 'src', 'communication', 'mailbox.js');
    const script = [
      "const fs = require('node:fs');",
      `const { restoreMailbox } = require(${JSON.stringify(modulePath)});`,
      `const restored = restoreMailbox(JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8')));`,
      "if (!restored.ok) { console.error(restored.code); process.exit(2); }",
      "const bound = restored.value.bindNext('npc_a', true);",
      "process.stdout.write(JSON.stringify({ messages: bound.ok ? bound.value.messages : 'rejected', pending: restored.value.status().pending }));",
    ].join('');
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const parsed = JSON.parse(output) as { messages: unknown[]; pending: Record<string, unknown> };
    assert.deepEqual(parsed.messages, [], 'a consumed message is not bound again');
    assert.deepEqual(parsed.pending, {}, 'nothing was left pending');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight reads /health and /v1/models as separate, non-chat requests', async () => {
  const server = await startServer({ model: 'fake-model' });
  try {
    const ok = await runPreflight(server.url, 'fake-model', (input, init) => fetch(input, init));
    assert.equal(ok.ok, true);
    assert.equal(ok.preflightRequests, 2);
    assert.deepEqual(ok.checks.map(check => check.path), ['/health', '/v1/models']);
    assert.equal(server.requests.length, 0, 'preflight must not POST a chat request');

    const wrong = await runPreflight(server.url, 'another-model', (input, init) => fetch(input, init));
    assert.equal(wrong.ok, false);
    assert.equal(wrong.checks.find(check => check.path === '/v1/models')?.ok, false);
  } finally {
    await server.close();
  }
});

test('a failed preflight spends no chat and leaves all eight slots not_run', async () => {
  const server = await startServer();
  const root = tempRoot();
  try {
    const preflight: G07Preflight = {
      schema: 'frostecho.g07.eval.preflight/1',
      ok: false,
      endpointHost: '127.0.0.1',
      expectedModel: 'fake-model',
      preflightRequests: 2,
      checks: [
        { path: '/health', url: 'http://127.0.0.1/health', status: 503, ok: false, error: 'http 503', raw: '' },
        { path: '/v1/models', url: 'http://127.0.0.1/v1/models', status: 200, ok: false, error: 'model fake-model is not listed', raw: '{}' },
      ],
      checkedAt: new Date().toISOString(),
    };
    const result = await runG07Batch(batchOptions(server.url, root, 'g07-preflight', { preflight }));
    assert.equal(result.exitCode, 2);
    assert.equal(server.requests.length, 0, 'a failed preflight sends no chat request');
    assert.equal(result.summary.fatal, 'preflight_failed');
    assert.equal(result.summary.budget.spent, 0);
    assert.equal(result.summary.totals.notRun, 8);
    const batch = readBatch(result.batchDir);
    assert.equal(batch.episodes.size, 0);
    assert.equal(batch.attempts.begins.length, 0);
    for (const status of batch.statuses.values()) assert.equal(status.status, 'not_run');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
