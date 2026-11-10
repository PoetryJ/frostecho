/** Frozen contract tests: expectations are written from 02-CONTRACTS.md. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContractError,
  candidateSetHash,
  makeChoiceRequest,
  makeChoiceResult,
  validateChoiceRequest,
} from '../src/decision/contracts';
import type { Candidate } from '../src/decision/contracts';

function candidate(id: string, description: string, utility = 1): Candidate {
  return {
    id,
    kind: 'eat',
    description,
    parameters: { portion: 1 },
    preconditions: ['food > 0'],
    expectedEffects: { hunger: 10 },
    utilityComponents: { hunger: utility },
  };
}

function request(candidates = [candidate('c-a', '吃自己那份'), candidate('c-b', '让给对方先吃')]) {
  return makeChoiceRequest({
    requestId: 'r-1',
    task: 'choose_action',
    actorId: 'npc_a',
    stateVersion: 3,
    observation: { food: 2 },
    question: '现在先做什么？',
    candidates,
  });
}

test('candidate set hash ignores order but binds content', () => {
  const left = request();
  const right = request([candidate('c-b', '让给对方先吃'), candidate('c-a', '吃自己那份')]);
  assert.equal(left.candidateSetHash, right.candidateSetHash);
  const changed = request([candidate('c-b', '让给对方先吃，再收拾'), candidate('c-a', '吃自己那份')]);
  assert.notEqual(left.candidateSetHash, changed.candidateSetHash);
});

test('duplicate candidate ids are rejected', () => {
  assert.throws(() => request([candidate('c-a', 'x'), candidate('c-a', 'y')]), (error: unknown) =>
    error instanceof ContractError && error.code === 'duplicate_candidate_id');
});

test('NaN utility is rejected', () => {
  const bad = candidate('c-a', 'x');
  bad.utilityComponents.hunger = Number.NaN;
  assert.throws(() => request([bad]), (error: unknown) =>
    error instanceof ContractError && error.code === 'not_finite');
});

test('empty candidate set produces a hash and never a fake softmax', () => {
  const empty = request([]);
  assert.equal(empty.candidates.length, 0);
  assert.equal(empty.candidateSetHash, candidateSetHash([]));
  assert.throws(() => makeChoiceResult({
    request: empty,
    scorerId: 'reference',
    scores: [],
    selectedId: null,
    disposition: 'accept',
    reason: 'should not happen',
  }), (error: unknown) => error instanceof ContractError && error.code === 'incomplete_scores');
});

test('accept requires a candidate from the bound set', () => {
  const base = request();
  assert.throws(() => makeChoiceResult({
    request: base,
    scorerId: 'reference',
    scores: [{ candidateId: 'c-a', logit: 1, probability: 0.6 },
      { candidateId: 'c-b', logit: 0, probability: 0.4 }],
    selectedId: 'c-zzz',
    disposition: 'accept',
    reason: 'fabricated',
  }), (error: unknown) => error instanceof ContractError && error.code === 'unbound_selection');
});

test('probabilities must sum to one when present', () => {
  const base = request();
  assert.throws(() => makeChoiceResult({
    request: base,
    scorerId: 'reference',
    scores: [{ candidateId: 'c-a', logit: 1, probability: 0.9 },
      { candidateId: 'c-b', logit: 0, probability: 0.9 }],
    selectedId: 'c-a',
    disposition: 'accept',
    reason: 'broken softmax',
  }), (error: unknown) => error instanceof ContractError && error.code === 'probability_sum');
});

test('abstain must not smuggle a selection', () => {
  const base = request();
  assert.throws(() => makeChoiceResult({
    request: base,
    scorerId: 'jev',
    scores: [{ candidateId: 'c-a', logit: 1 }, { candidateId: 'c-b', logit: 0 }],
    selectedId: 'c-a',
    disposition: 'abstain',
    reason: 'low confidence',
  }), (error: unknown) => error instanceof ContractError && error.code === 'selection_on_abstain');
});

test('valid accept result round-trips identity', () => {
  const base = request();
  const result = makeChoiceResult({
    request: base,
    scorerId: 'reference',
    scores: [{ candidateId: 'c-a', logit: 2, probability: 0.8 },
      { candidateId: 'c-b', logit: 0, probability: 0.2 }],
    selectedId: 'c-a',
    disposition: 'accept',
    reason: 'highest utility',
  });
  assert.equal(result.requestId, base.requestId);
  assert.equal(result.candidateSetHash, base.candidateSetHash);
});

test('tampered candidate hash is rejected on the wire', () => {
  const base = request();
  const wire = JSON.parse(JSON.stringify(base));
  wire.candidateSetHash = 'f'.repeat(64);
  assert.throws(() => validateChoiceRequest(wire), (error: unknown) =>
    error instanceof ContractError && error.code === 'candidate_hash');
});

test('unknown task is rejected', () => {
  assert.throws(() => makeChoiceRequest({
    requestId: 'r-2',
    task: 'summarise_mood' as never,
    actorId: 'npc_a',
    stateVersion: 0,
    observation: {},
    question: '?',
    candidates: [],
  }), (error: unknown) => error instanceof ContractError && error.code === 'unknown_task');
});
