/**
 * G05-live workstream C — cost totals and the live judge, standalone.
 *
 * usage is summed per request (4×11=44, the regression that only counted the
 * first response); a missing/partial usage keeps its request but forces
 * totalTokens = null; zero requests ⇒ all zero with a confident 0. The live
 * judge accepts legal extra model decisions on model trajectories while every
 * zero-call checkpoint (initial check, T2, one-shot, waiting stages) stays
 * strictly zero — an unexpected request there still fails.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sumAttempts } from '../src/needs/metrics';
import type { AttemptLedger } from '../src/needs/batch-store';
import type { LiveAttemptBegin, LiveAttemptFinish } from '../src/needs/live-contracts';
import { G05_SCENARIOS, runScenario } from '../src/needs/scenarios';
import { createHttpProvider } from '../src/agent/providers/http';
import { verifyNeedsSemantics } from '../src/needs/record';

function begin(seq: number): LiveAttemptBegin {
  return {
    attemptId: `att-${String(seq).padStart(4, '0')}`, seq, episodeId: 'e', actorId: 'npc_a',
    cycle: 1, round: 1, at: '2026-11-02T00:00:00.000Z',
    requestConfig: { model: 'm', temperature: 0, max_tokens: 1024, stream: false, enableThinking: [true], timeoutMs: 1000 },
  };
}

function finish(seq: number, outcome: LiveAttemptFinish['outcome'], usage: LiveAttemptFinish['usage'], elapsedMs = 50): LiveAttemptFinish {
  return {
    attemptId: `att-${String(seq).padStart(4, '0')}`, at: '2026-11-02T00:00:00.100Z',
    outcome, status: outcome === 'http_error' ? 500 : null, error: null, usage, elapsedMs,
  };
}

const U11 = { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 };

test('usage sums per request: 4×11=44', () => {
  const ledger: AttemptLedger = {
    begins: [begin(1), begin(2), begin(3), begin(4)],
    finishes: [finish(1, 'success', U11), finish(2, 'success', U11), finish(3, 'success', U11), finish(4, 'success', U11)],
    blocked: [],
  };
  const totals = sumAttempts(ledger);
  assert.equal(totals.httpAttempts, 4);
  assert.equal(totals.knownTokenSum, 44);
  assert.equal(totals.usageUnknownCount, 0);
  assert.equal(totals.totalTokens, 44);
  assert.equal(totals.byOutcome.success, 4);
  assert.equal(totals.latencyMsSum, 200);
});

test('a request with missing usage is counted but forces totalTokens=null', () => {
  const ledger: AttemptLedger = {
    begins: [begin(1), begin(2)],
    finishes: [finish(1, 'success', U11), finish(2, 'success', null)],
    blocked: [],
  };
  const totals = sumAttempts(ledger);
  assert.equal(totals.httpAttempts, 2);
  assert.equal(totals.knownTokenSum, 11);
  assert.equal(totals.usageUnknownCount, 1);
  assert.equal(totals.totalTokens, null, 'incomplete totals are never reported as confident');
});

test('partial usage is still unknown unless it can be derived', () => {
  const ledger: AttemptLedger = {
    begins: [begin(1), begin(2), begin(3)],
    finishes: [
      finish(1, 'success', { prompt_tokens: 5, completion_tokens: 6, total_tokens: null }), // derived 11
      finish(2, 'success', { prompt_tokens: 5, completion_tokens: null, total_tokens: null }), // unknown
      finish(3, 'success', { prompt_tokens: null, completion_tokens: null, total_tokens: null }), // unknown
    ],
    blocked: [],
  };
  const totals = sumAttempts(ledger);
  assert.equal(totals.knownTokenSum, 11);
  assert.equal(totals.usageUnknownCount, 2);
  assert.equal(totals.totalTokens, null);
});

test('zero requests ⇒ all zero with a confident 0; an unresolved begin poisons the total', () => {
  const empty = sumAttempts({ begins: [], finishes: [], blocked: [] });
  assert.equal(empty.httpAttempts, 0);
  assert.equal(empty.totalTokens, 0);
  // G06 correction probes: an in-flight request that never finished has an
  // unknown cost — the confident total must be null, never the known subtotal
  // and never 0. knownTokens keeps whatever finished requests reported.
  const zeroKnownOneUnresolved = sumAttempts({ begins: [begin(1)], finishes: [], blocked: [] });
  assert.equal(zeroKnownOneUnresolved.unresolvedAttempts, 1);
  assert.equal(zeroKnownOneUnresolved.httpAttempts, 0, 'unresolved is not a confirmed response');
  assert.equal(zeroKnownOneUnresolved.knownTokenSum, 0);
  assert.equal(zeroKnownOneUnresolved.totalTokens, null);
  const elevenKnownOneUnresolved = sumAttempts({
    begins: [begin(1), begin(2)],
    finishes: [finish(1, 'success', U11)],
    blocked: [],
  });
  assert.equal(elevenKnownOneUnresolved.unresolvedAttempts, 1);
  assert.equal(elevenKnownOneUnresolved.knownTokenSum, 11);
  assert.equal(elevenKnownOneUnresolved.usageUnknownCount, 0);
  assert.equal(elevenKnownOneUnresolved.totalTokens, null, '11 known + 1 unresolved reports null, not 11');
});

test('denials and outcomes are separate counters', () => {
  const ledger: AttemptLedger = {
    begins: [begin(1), begin(2)],
    finishes: [finish(1, 'http_error', U11), finish(2, 'timeout', null)],
    blocked: [{ seq: 1, at: 't', episodeId: 'e', actorId: 'b', cycle: 1, round: 2, code: 'CHAT_BUDGET_EXHAUSTED' }],
  };
  const totals = sumAttempts(ledger);
  assert.equal(totals.budgetBlocked, 1);
  assert.equal(totals.byOutcome.http_error, 1);
  assert.equal(totals.byOutcome.timeout, 1);
  assert.equal(totals.totalTokens, null, 'the timeout has no usage');
});

/** A scripted HTTP fetch whose npc_a legally detours (move→move→eat→eat); npc_c eats directly. */
function detourFetchFactory(): typeof fetch {
  const scripts: Record<string, string[]> = {
    npc_a: ['{"type":"move","to":"dorm"}', '{"type":"move","to":"kitchen"}', '{"type":"eat"}', '{"type":"eat"}'],
    npc_c: ['{"type":"eat"}', '{"type":"eat"}'],
  };
  const calls: Record<string, number> = {};
  return async (input, init) => {
    void input; void init;
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content: string }[] };
    const idMatch = /"id"\s*:\s*"(npc_[ac])"/.exec(body.messages?.[0]?.content ?? '');
    const id = idMatch?.[1] ?? 'npc_a';
    calls[id] = (calls[id] ?? 0) + 1;
    const script = scripts[id] ?? ['{"type":"stop"}'];
    const content = script[Math.min(calls[id] - 1, script.length - 1)];
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('live judge: legal extra decisions pass on a model trajectory (T1 recurring)', async () => {
  const scenario = G05_SCENARIOS.find(s => s.id === 'ac/t1/recurring');
  assert.ok(scenario !== undefined);
  const fetchImpl = detourFetchFactory();
  const providerFor = () => createHttpProvider({ url: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', fetchImpl });
  const run = await runScenario(scenario, { providerFor, mode: 'live' });
  assert.equal(run.scenarioPass, true, run.issues.join('; '));
  assert.ok(run.record.actors.npc_a.providerCalls > 2, 'the detour really spent extra legal decisions');
  const issues = verifyNeedsSemantics(run.record);
  assert.equal(issues.length, 0, issues.join('; '));
});

test('live judge: an unexpected request recorded on a zero-call trajectory still fails (T2)', async () => {
  const scenario = G05_SCENARIOS.find(s => s.id === 'ac/t2/recurring');
  assert.ok(scenario !== undefined);
  // T2 policy-wise cannot wake the model (50 > 40), so "extra requests" can
  // only appear as a tampered/buggy record — the verifier must still fail it.
  const run = await runScenario(scenario, { providerFor: () => createHttpProvider({ url: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', fetchImpl: detourFetch('{"type":"eat"}') }), mode: 'live' });
  assert.equal(run.scenarioPass, true, 'a clean zero-call T2 passes in live mode');
  const tampered = structuredClone(run.record);
  tampered.mode = 'live';
  tampered.actors.npc_a.providerCalls += 3;
  for (const cp of tampered.checkpoints) {
    if ((cp.expected.calls ?? 0) === 0) cp.actual.calls += 3;
  }
  const issues = verifyNeedsSemantics(tampered);
  assert.ok(issues.some(i => i.includes('calls')), `extra requests on a zero-call trajectory must fail: ${issues.join('; ')}`);
});

function detourFetch(content: string): typeof fetch {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: U11,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('reference mode stays strict: the same detour fails without live judging', async () => {
  const scenario = G05_SCENARIOS.find(s => s.id === 'ac/t1/recurring');
  assert.ok(scenario !== undefined);
  const fetchImpl = detourFetchFactory();
  const providerFor = () => createHttpProvider({ url: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', fetchImpl });
  const run = await runScenario(scenario, { providerFor, mode: 'reference' });
  assert.equal(run.scenarioPass, false, 'reference mode demands the exact reference count');
  assert.ok(run.issues.some(i => i.includes('calls')), run.issues.join('; '));
});
