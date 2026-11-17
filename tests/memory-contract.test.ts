/**
 * The 12 CPU regressions from 01-MEMORY-CONTRACT §5, one test each.
 * Expectations come from the contract text, not from the implementation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEMORY_POLICY_VERSION,
  MemoryQueryError,
  MemoryStore,
  assertCalibrationPolicy,
  assertCurrentSnapshot,
  invalidateDependentPlans,
  type MemoryRecordInput,
  type PlanLike,
} from '../src/memory/store';

function base(eventId: string, observerId: string, overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    eventId,
    observerId,
    occurredAt: 100,
    observedAt: 100,
    kind: 'observe',
    subjectIds: ['npc_a'],
    payload: {},
    source: 'engine',
    authority: 'engine',
    ...overrides,
  };
}

function promiseStore(): MemoryStore {
  const store = new MemoryStore();
  store.append(base('e-p', 'npc_a', {
    kind: 'promise_made', subjectIds: ['npc_a', 'player'], relatedRequestId: 'req-1',
    payload: { promiseId: 'p-1', fromId: 'npc_a', toId: 'player', text: '留饭' },
  }));
  store.append(base('e-p', 'npc_b', {
    kind: 'promise_made', subjectIds: ['npc_a', 'player'], relatedRequestId: 'req-1',
    payload: { promiseId: 'p-1', fromId: 'npc_a', toId: 'player', text: '留饭' },
  }));
  return store;
}

test('1. duplicate observation is idempotent for memory and relations', () => {
  const store = new MemoryStore();
  const first = store.append(base('e-1', 'npc_a', {
    kind: 'give', subjectIds: ['npc_a', 'npc_b'], payload: { fromId: 'npc_a', toId: 'npc_b' },
  }));
  const second = store.append(base('e-1', 'npc_a', {
    kind: 'give', subjectIds: ['npc_a', 'npc_b'], payload: { fromId: 'npc_a', toId: 'npc_b' },
  }));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.relation('npc_a', 'npc_a', 'npc_b')!.evidenceIds.length, 1);
});

test('2. a private message to A never appears in B memory', () => {
  const store = promiseStore();
  store.append(base('e-private', 'npc_a', {
    kind: 'message', payload: { text: '我只告诉你' }, source: 'player_statement', authority: 'player',
  }));
  const seenByA = store.query({ observerId: 'npc_a', now: 200 });
  const seenByB = store.query({ observerId: 'npc_b', now: 200 });
  assert.ok(seenByA.items.some(item => item.kind === 'message'));
  assert.ok(!seenByB.items.some(item => item.kind === 'message'));
});

test('3. a heard valid retraction leaves the active set but keeps history', () => {
  const store = promiseStore();
  store.append(base('e-r', 'npc_a', {
    kind: 'promise_retract', occurredAt: 110, subjectIds: ['npc_a', 'player'],
    payload: { promiseId: 'p-1', byId: 'player' }, source: 'player_statement', authority: 'player',
  }));
  const result = store.query({ observerId: 'npc_a', now: 200 });
  assert.equal(result.promises.find(view => view.promiseId === 'p-1')!.status, 'cancelled');
  const history = result.items.filter(item => item.kind === 'promise_made' || item.kind === 'promise_retract');
  assert.equal(history.length, 2);
  assert.ok(history.every(item => item.evidenceIds.length > 0));
});

test('4. a character that did not hear the retraction keeps its knowledge', () => {
  const store = promiseStore();
  store.append(base('e-r', 'npc_a', {
    kind: 'promise_retract', occurredAt: 110, subjectIds: ['npc_a', 'player'],
    payload: { promiseId: 'p-1', byId: 'player' }, source: 'player_statement', authority: 'player',
  }));
  // The authoritative engine saw both the promise and the retraction.
  store.append(base('e-p', 'engine', {
    kind: 'promise_made', subjectIds: ['npc_a', 'player'],
    payload: { promiseId: 'p-1', fromId: 'npc_a', toId: 'player', text: '留饭' },
    source: 'engine', authority: 'npc',
  }));
  store.append(base('e-r', 'engine', {
    kind: 'promise_retract', occurredAt: 110, subjectIds: ['npc_a', 'player'],
    payload: { promiseId: 'p-1', byId: 'player' }, source: 'player_statement', authority: 'player',
  }));
  assert.equal(store.promises('npc_b', 200)[0].status, 'active');
  assert.equal(store.promises('engine', 200)[0].status, 'cancelled');
});

test('5. an unauthorised third-party retraction does not change the promise', () => {
  const store = promiseStore();
  store.append(base('e-r3', 'npc_a', {
    kind: 'promise_retract', occurredAt: 110, subjectIds: ['npc_c'],
    payload: { promiseId: 'p-1', byId: 'npc_c' }, source: 'engine', authority: 'third_party',
  }));
  const view = store.promises('npc_a', 200)[0];
  assert.equal(view.status, 'unresolved');
  assert.match(view.unresolvedReason ?? '', /unauthorised/);
});

test('6. quoted words and unverified inference do not become instructions or fulfilment', () => {
  const store = promiseStore();
  store.append(base('e-quote', 'npc_a', {
    kind: 'quote', payload: { text: '他说不用留饭', about: 'p-1' }, source: 'player_statement', authority: 'third_party',
  }));
  store.append(base('e-inf', 'npc_a', {
    kind: 'inference', payload: { claim: '可能已经吃过' }, source: 'inference', authority: 'inference',
  }));
  const view = store.promises('npc_a', 200)[0];
  assert.equal(view.status, 'active');
  const result = store.query({ observerId: 'npc_a', now: 200 });
  assert.ok(result.items.some(item => item.source === 'inference'));
  assert.ok(!result.items.some(item => item.kind === 'promise_kept'));
});

test('7. an old similar memory does not outrank the known correction', () => {
  const store = promiseStore();
  store.append(base('e-r', 'npc_a', {
    kind: 'promise_retract', occurredAt: 110, subjectIds: ['npc_a', 'player'],
    payload: { promiseId: 'p-1', byId: 'player' }, source: 'player_statement', authority: 'player',
  }));
  const result = store.query({ observerId: 'npc_a', now: 200, text: '留饭', goalRef: 'req-1' });
  assert.equal(result.promises[0].status, 'cancelled');
  const promiseItem = result.items.find(item => item.kind === 'promise_made')!;
  assert.equal(promiseItem.effective!.status, 'cancelled');
  assert.equal(result.items[0].kind, 'promise_retract');
});

test('8. a query error is distinct from an empty result', () => {
  const store = new MemoryStore();
  const empty = store.query({ observerId: 'npc_a', now: 10 });
  assert.equal(empty.queryStatus, 'empty');
  assert.throws(() => store.query({ observerId: 'npc_a', now: 10, topK: -1 }), (error: unknown) =>
    error instanceof MemoryQueryError && error.code === 'bad_topk');
});

test('9. budget truncation is reported and evidence stays traceable', () => {
  const store = new MemoryStore();
  for (let index = 0; index < 5; index += 1) {
    store.append(base(`e-${index}`, 'npc_a', { kind: 'observe', occurredAt: 100 + index }));
  }
  const result = store.query({ observerId: 'npc_a', now: 200, topK: 2 });
  assert.equal(result.queryStatus, 'incomplete');
  assert.equal(result.truncation.truncated, true);
  assert.equal(result.truncation.omitted, 3);
  assert.ok(result.items.every(item => item.evidenceIds.length > 0));
});

test('10. restore rebuilds indexes and keeps query/relation/hash equivalence', () => {
  const store = promiseStore();
  store.append(base('e-g', 'npc_a', {
    kind: 'give', subjectIds: ['npc_a', 'npc_b'], payload: { fromId: 'npc_a', toId: 'npc_b' },
  }));
  const restored = MemoryStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  assert.equal(restored.snapshotHash(), store.snapshotHash());
  assert.deepEqual(restored.query({ observerId: 'npc_a', now: 200 }).promises,
    store.query({ observerId: 'npc_a', now: 200 }).promises);
  assert.deepEqual(restored.relation('npc_a', 'npc_a', 'npc_b'),
    store.relation('npc_a', 'npc_a', 'npc_b'));
});

test('11. only a relevant retraction invalidates a dependent plan', () => {
  const plans: PlanLike[] = [
    { planId: 'plan-1', promiseId: 'p-1', dependencyRevision: 1, state: 'planned' },
    { planId: 'plan-2', promiseId: 'p-2', dependencyRevision: 1, state: 'planned' },
  ];
  const afterRetraction = invalidateDependentPlans(plans, 'p-1', 'cancelled', 2);
  assert.equal(afterRetraction[0].state, 'invalidated');
  assert.equal(afterRetraction[1].state, 'planned');
  const afterUnrelated = invalidateDependentPlans(afterRetraction, 'p-2', 'active', 2);
  assert.deepEqual(afterUnrelated, afterRetraction);
});

test('12. stale snapshots and other memory policies cannot be reused', () => {
  const store = new MemoryStore();
  const current = { stateVersion: 7, memorySnapshotHash: store.snapshotHash(),
    memoryPolicyVersion: MEMORY_POLICY_VERSION };
  assert.throws(() => assertCurrentSnapshot({ ...current, stateVersion: 6 }, current), (error: unknown) =>
    error instanceof MemoryQueryError && error.code === 'stale_state');
  assert.throws(() => assertCurrentSnapshot({ ...current, memorySnapshotHash: 'old' }, current), (error: unknown) =>
    error instanceof MemoryQueryError && error.code === 'stale_memory');
  assert.throws(() => assertCalibrationPolicy({ memoryPolicyVersion: 'memory-policy/0' }, store),
    (error: unknown) => error instanceof MemoryQueryError && error.code === 'policy_mismatch');
});
