import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeChoiceRequest, makeChoiceResult, type ChoiceRequest } from '../src/decision/contracts';
import { RuntimeError, runChoice, type ScorerBinding } from '../src/decision/runtime';
import {
  buildPlanningRequest,
  jevShadowScorer,
  referenceScorer,
  type PlanningView,
  type ScorerPort,
} from '../src/planning/candidates';

function view(): PlanningView {
  return {
    actorId: 'npc_a',
    npcs: [
      { id: 'npc_a', hunger: 40, stamina: 50, health: 100, san: 70, alive: true },
      { id: 'npc_b', hunger: 30, stamina: 70, health: 80, san: 60, alive: true },
    ],
    resources: { food: 2, firewood: 1, power: 10, medicine: 0 },
    furnace: { lit: false, fuel: 5, warmth: 10 },
    weather: 'snow',
  };
}

function request(): ChoiceRequest {
  return buildPlanningRequest({
    view: view(),
    promises: [{ promiseId: 'p-1', toId: 'player', status: 'active', revision: 2 }],
    stateVersion: 9,
    requestId: 'req-runtime-1',
    memorySnapshotHash: 'mem-hash-1',
    memoryPolicyVersion: 'memory-policy/1',
  });
}

function binding(req: ChoiceRequest, overrides: Partial<ScorerBinding> = {}): ScorerBinding {
  return {
    model: 'reference',
    head: 'utility',
    tokenizer: 'none',
    renderer: 'jev04',
    task: 'choose_action',
    k: req.candidates.length,
    memoryPolicyVersion: 'memory-policy/1',
    supportedK: [req.candidates.length],
    ...overrides,
  };
}

function abstainer(): ScorerPort {
  return {
    id: 'abstainer', mode: 'reference',
    score(req) {
      return makeChoiceResult({ request: req, scorerId: 'abstainer', scores: [], selectedId: null,
        disposition: 'abstain', reason: 'not sure' });
    },
  };
}

test('K outside the supported range is refused before any model call', async () => {
  const req = makeChoiceRequest({ requestId: 'r', task: 'choose_action', actorId: 'npc_a',
    stateVersion: 1, observation: {}, question: '?',
    candidates: [{ id: 'only', kind: 'wait', description: '等', parameters: {},
      preconditions: [], expectedEffects: {}, utilityComponents: {} }],
    memoryPolicyVersion: 'memory-policy/1' });
  await assert.rejects(runChoice(req, referenceScorer(), binding(req, { supportedK: [4] })), (error: unknown) =>
    error instanceof RuntimeError && error.code === 'unsupported_k');
});

test('a request bound to another memory policy is refused', async () => {
  const req = request();
  await assert.rejects(runChoice(req, referenceScorer(), binding(req, { memoryPolicyVersion: 'memory-policy/2' })),
    (error: unknown) => error instanceof RuntimeError && error.code === 'memory_policy_mismatch');
});

test('a stale state version is refused', async () => {
  await assert.rejects(runChoice(request(), referenceScorer(), binding(request()), { currentStateVersion: 10 }),
    (error: unknown) => error instanceof RuntimeError && error.code === 'stale_state');
});

test('retrieval error is reported and falls back explicitly', async () => {
  const req = request();
  const outcome = await runChoice(req, abstainer(), binding(req), {
    retrieval: () => { throw new Error('index offline'); },
    fallback: referenceScorer(),
  });
  assert.equal(outcome.audit.retrieval, 'error');
  assert.equal(outcome.audit.fallbackUsed, true);
  assert.equal(outcome.result.disposition, 'accept');
  assert.match(outcome.result.reason, /fallback from abstainer/);
});

test('empty retrieval is distinct from an error', async () => {
  const req = request();
  const outcome = await runChoice(req, referenceScorer(), binding(req), { retrieval: () => 'empty' });
  assert.equal(outcome.audit.retrieval, 'empty');
  assert.equal(outcome.audit.fallbackUsed, false);
});

test('at most one extra retrieval is attempted', async () => {
  const req = request();
  let calls = 0;
  const outcome = await runChoice(req, abstainer(), binding(req), {
    extraRetrieval: async current => { calls += 1; return current; },
    fallback: referenceScorer(),
  });
  assert.equal(calls, 1);
  assert.equal(outcome.audit.extraRetrievalUsed, true);
  assert.equal(outcome.audit.fallbackUsed, true);
});

test('a journaled result is recovered without calling the scorer again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frostecho-journal-'));
  const journalPath = join(dir, 'choices.jsonl');
  try {
    const req = request();
    let calls = 0;
    const scorer: ScorerPort = {
      id: 'counter', mode: 'reference',
      score(current) { calls += 1; return referenceScorer().score(current); },
    };
    const first = await runChoice(req, scorer, binding(req), { journalPath });
    const second = await runChoice(req, scorer, binding(req), { journalPath });
    assert.equal(calls, 1);
    assert.equal(first.audit.cacheHit, false);
    assert.equal(second.audit.cacheHit, true);
    assert.equal(second.result.selectedId, first.result.selectedId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shadow result is recorded but never executed', async () => {
  const req = request();
  let executed = false;
  const shadow = jevShadowScorer('jev-shadow', current => current.candidates.map(candidate => ({
    candidateId: candidate.id, selectedId: candidate.id, logit: 2, probability: 0.4,
  })));
  const outcome = await runChoice(req, shadow, binding(req), { execute: () => { executed = true; } });
  assert.equal(outcome.result.disposition, 'abstain');
  assert.equal(outcome.audit.shadow, true);
  assert.equal(outcome.audit.executed, false);
  assert.equal(executed, false);
});

test('reference accept executes exactly once', async () => {
  const req = request();
  let executed = 0;
  await runChoice(req, referenceScorer(), binding(req), { execute: () => { executed += 1; } });
  assert.equal(executed, 1);
});
