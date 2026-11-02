/**
 * G05-live workstream A — per-request budget, standalone.
 *
 * cap 1 → at most one POST; cap 0 → zero POSTs; two racing decide() calls
 * cannot both spend the last slot; failures and timeouts keep their slot; a
 * denial neither sends a request nor lets a command run; the limit must be a
 * finite non-negative integer.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHttpProvider } from '../src/agent/providers/http';
import { BudgetBlockedError, ChatBudgetGate, createBudgetedProvider } from '../src/needs/live-budget';
import { NeedsBatchStore } from '../src/needs/batch-store';
import { G05_SCENARIOS } from '../src/needs/scenarios';
import type { LiveAttemptHooks, AttemptRequestConfig } from '../src/needs/live-contracts';

const BASE_URL = 'http://127.0.0.1:1/v1/chat/completions';

const requestConfig: AttemptRequestConfig = {
  model: 'test-model', temperature: 0, max_tokens: 1024, stream: false, enableThinking: [true], timeoutMs: 5000,
};

function okResponse(content = '{"type":"stop"}'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function hooksCapture(): LiveAttemptHooks & { begins: unknown[]; finishes: unknown[]; blocked: unknown[] } {
  const capture = { begins: [] as unknown[], finishes: [] as unknown[], blocked: [] as unknown[] };
  return {
    ...capture,
    beginAttempt: b => { capture.begins.push(b); },
    finishAttempt: f => { capture.finishes.push(f); },
    recordBlocked: b => { capture.blocked.push(b); },
  };
}

test('gate: finite non-negative integer limit only; reserve never refunds', () => {
  assert.throws(() => new ChatBudgetGate(1.5));
  assert.throws(() => new ChatBudgetGate(-1));
  assert.doesNotThrow(() => new ChatBudgetGate(0));
  const gate = new ChatBudgetGate(1);
  assert.deepEqual(gate.reserve(), { ok: true, attemptId: 'att-0001' });
  assert.equal(gate.reserve().ok, false);
  assert.equal(gate.spent, 1);
  assert.equal(gate.blocked, 1);
});

test('cap 1: exactly one POST, the second decision is denied without a request', async () => {
  let posts = 0;
  const fetchImpl: typeof fetch = async () => { posts += 1; return okResponse(); };
  const gate = new ChatBudgetGate(1);
  const hooks = hooksCapture();
  const provider = createBudgetedProvider({
    gate, hooks, requestConfig, episodeId: 'ep', actorId: 'npc_a', cycle: 1,
    inner: createHttpProvider({ url: BASE_URL, model: 'm', fetchImpl }),
  });
  const input = { observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never, goal: { hungerAtLeast: 70 }, feedback: null };
  const first = await provider.decide(input, new AbortController().signal);
  assert.equal(first, '{"type":"stop"}');
  await assert.rejects(provider.decide(input, new AbortController().signal), BudgetBlockedError);
  assert.equal(posts, 1, 'denial must not reach the network');
  assert.equal(hooks.begins.length, 1);
  assert.equal(hooks.finishes.length, 1);
  assert.equal(hooks.blocked.length, 1);
  assert.deepEqual((hooks.blocked[0] as { code: string }).code, 'CHAT_BUDGET_EXHAUSTED');
});

test('cap 0: zero POSTs, first decision already denied', async () => {
  let posts = 0;
  const fetchImpl: typeof fetch = async () => { posts += 1; return okResponse(); };
  const gate = new ChatBudgetGate(0);
  const hooks = hooksCapture();
  const provider = createBudgetedProvider({
    gate, hooks, requestConfig, episodeId: 'ep', actorId: 'npc_a', cycle: 1,
    inner: createHttpProvider({ url: BASE_URL, model: 'm', fetchImpl }),
  });
  const input = { observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never, goal: { hungerAtLeast: 70 }, feedback: null };
  await assert.rejects(provider.decide(input, new AbortController().signal), BudgetBlockedError);
  assert.equal(posts, 0);
  assert.equal(hooks.begins.length, 0);
  assert.equal(hooks.finishes.length, 0);
  assert.equal(hooks.blocked.length, 1);
});

test('two racing decisions cannot both spend the last slot', async () => {
  let posts = 0;
  const fetchImpl: typeof fetch = async () => {
    posts += 1;
    await new Promise(r => setTimeout(r, 20));
    return okResponse();
  };
  const gate = new ChatBudgetGate(1);
  const hooks = hooksCapture();
  const provider = createBudgetedProvider({
    gate, hooks, requestConfig, episodeId: 'ep', actorId: 'npc_a', cycle: 1,
    inner: createHttpProvider({ url: BASE_URL, model: 'm', fetchImpl }),
  });
  const input = { observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never, goal: { hungerAtLeast: 70 }, feedback: null };
  const results = await Promise.allSettled([
    provider.decide(input, new AbortController().signal),
    provider.decide(input, new AbortController().signal),
  ]);
  const rejected = results.filter(r => r.status === 'rejected').length;
  assert.equal(posts, 1);
  assert.equal(rejected, 1);
  assert.equal(gate.spent, 1);
  assert.equal(gate.blocked, 1);
});

test('a failed request keeps its slot; the denial is classified apart from transport', async () => {
  const fetchImpl: typeof fetch = async () => new Response('{"error":"boom"}', { status: 500 });
  const gate = new ChatBudgetGate(2);
  const hooks = hooksCapture();
  const provider = createBudgetedProvider({
    gate, hooks, requestConfig, episodeId: 'ep', actorId: 'npc_a', cycle: 1,
    inner: createHttpProvider({ url: BASE_URL, model: 'm', fetchImpl }),
  });
  const input = { observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never, goal: { hungerAtLeast: 70 }, feedback: null };
  await assert.rejects(provider.decide(input, new AbortController().signal));
  assert.equal(gate.spent, 1, 'the failure consumed the slot — no refund');
  assert.equal((hooks.finishes[0] as { outcome: string }).outcome, 'http_error');
  assert.equal((hooks.finishes[0] as { status: number | null }).status, 500);
  // Second attempt also fails; third is denied.
  await assert.rejects(provider.decide(input, new AbortController().signal));
  await assert.rejects(provider.decide(input, new AbortController().signal), BudgetBlockedError);
  assert.equal(gate.spent, 2);
  assert.equal(gate.blocked, 1);
});

test('a begin write failure stops the attempt before any request (slot stays spent)', async () => {
  let posts = 0;
  const fetchImpl: typeof fetch = async () => { posts += 1; return okResponse(); };
  const gate = new ChatBudgetGate(5);
  const hooks = hooksCapture();
  hooks.beginAttempt = () => { throw new Error('disk full'); };
  const provider = createBudgetedProvider({
    gate, hooks, requestConfig, episodeId: 'ep', actorId: 'npc_a', cycle: 1,
    inner: createHttpProvider({ url: BASE_URL, model: 'm', fetchImpl }),
  });
  const input = { observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never, goal: { hungerAtLeast: 70 }, feedback: null };
  await assert.rejects(provider.decide(input, new AbortController().signal), /disk full/);
  assert.equal(posts, 0, 'no HTTP after a failed begin write');
  assert.equal(gate.spent, 1, 'conservatively spent — no refund');
  assert.equal(hooks.finishes.length, 0);
});

test('durable ledger: begin before send, finish after, blocked recorded on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-budget-'));
  try {
    const store = NeedsBatchStore.open(root, 'ledger', {
      mode: 'live', matrixVersion: 'g05-r1-t123', chatBudget: { limit: 2 },
      requestDefaults: { model: 'm', temperature: 0, max_tokens: 1024, stream: false, enableThinking: true, timeoutMs: 5000, urlPresent: true },
      scenarios: G05_SCENARIOS.slice(0, 1),
    });
    const order: string[] = [];
    const gate = new ChatBudgetGate(1);
    let posts = 0;
    const fetchImpl: typeof fetch = async () => {
      order.push('post');
      posts += 1;
      return okResponse();
    };
    const provider = createBudgetedProvider({
      gate, hooks: {
        beginAttempt: b => { order.push('begin'); store.beginAttempt(b); },
        finishAttempt: f => { order.push('finish'); store.finishAttempt(f); },
        recordBlocked: b => store.recordBlocked(b),
      },
      requestConfig, episodeId: 'ep', actorId: 'npc_a', cycle: 1,
      inner: createHttpProvider({ url: BASE_URL, model: 'm', fetchImpl }),
    });
    const input = { observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [] } as never, goal: { hungerAtLeast: 70 }, feedback: null };
    await provider.decide(input, new AbortController().signal);
    await assert.rejects(provider.decide(input, new AbortController().signal), BudgetBlockedError);
    assert.deepEqual(order, ['begin', 'post', 'finish'], 'reserve→persist→HTTP→persist');
    const beginFile = JSON.parse(readFileSync(join(store.dir, 'attempts', 'att-0001.begin.json'), 'utf8')) as { episodeId: string; actorId: string };
    assert.equal(beginFile.episodeId, 'ep');
    assert.equal(beginFile.actorId, 'npc_a');
    const finishFile = JSON.parse(readFileSync(join(store.dir, 'attempts', 'att-0001.finish.json'), 'utf8')) as { outcome: string; usage: { total_tokens: number } };
    assert.equal(finishFile.outcome, 'success');
    assert.equal(finishFile.usage.total_tokens, 7);
    const blockedFile = JSON.parse(readFileSync(join(store.dir, 'attempts', 'blocked-0001.json'), 'utf8')) as { code: string; seq: number };
    assert.equal(blockedFile.code, 'CHAT_BUDGET_EXHAUSTED');
    assert.equal(blockedFile.seq, 1);
    assert.equal(posts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
