// Independent black-box expectations from memory addendum sections 1, 2 and 4.
// Copy to the root of an isolated clone after npm run build; no model/services used.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MemoryStore, invalidateDependentPlans } = require('./dist/src/memory/store.js');

function base(eventId, overrides = {}) {
  return { eventId, observerId: 'npc_a', occurredAt: 100, observedAt: 100,
    kind: 'observe', subjectIds: ['npc_a', 'player'], payload: {},
    source: 'engine', authority: 'engine', ...overrides };
}
function promised() {
  const store = new MemoryStore();
  store.append(base('promise-1', { kind: 'promise_made', authority: 'npc',
    payload: { promiseId: 'p1', fromId: 'npc_a', toId: 'player', text: 'save food' } }));
  return store;
}

test('M1a: a pending inference must not become objective fulfilment or earned trust', () => {
  const store = promised();
  store.append(base('guess-kept', { occurredAt: 110, observedAt: 110,
    kind: 'promise_kept', source: 'inference', authority: 'inference',
    payload: { promiseId: 'p1', fromId: 'npc_a', toId: 'player', text: 'maybe delivered' } }));
  const actual = { status: store.promises('npc_a', 120)[0].status,
    relation: store.relation('npc_a', 'npc_a', 'player') };
  console.log('M1a actual:', JSON.stringify(actual));
  assert.equal(actual.status, 'active');
  assert.equal(actual.relation, null);
});

test('M1b: a third-party attributed statement cannot impersonate the promisee', () => {
  const store = promised();
  store.append(base('third-party-claim', { occurredAt: 110, observedAt: 110,
    kind: 'promise_retract', source: 'player_statement', authority: 'third_party',
    subjectIds: ['npc_c'], payload: { promiseId: 'p1', byId: 'player', text: 'C claims player cancelled' } }));
  const view = store.promises('npc_a', 120)[0];
  console.log('M1b actual:', JSON.stringify(view));
  assert.notEqual(view.status, 'cancelled');
});

test('M2: an older dependency update must not invalidate a newer planned version', () => {
  const current = [{ planId: 'new-plan', promiseId: 'p1', dependencyRevision: 9, state: 'planned' }];
  const actual = invalidateDependentPlans(current, 'p1', 'cancelled', 2);
  console.log('M2 actual:', JSON.stringify(actual));
  assert.deepEqual(actual, current);
});

test('M3a: append must preserve source event provenance, including after restore', () => {
  const store = new MemoryStore();
  store.append(base('derived-1', { source: 'inference', authority: 'inference',
    sourceEventIds: ['original-10', 'original-11'], payload: { claim: 'combined inference' } }));
  const roundtrip = MemoryStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
  const actual = roundtrip.toJSON().records[0].sourceEventIds;
  console.log('M3a actual:', JSON.stringify(actual));
  assert.deepEqual(actual, ['original-10', 'original-11']);
});

test('M3b: mutating a retrieved payload must not rewrite append-only history', () => {
  const store = promised();
  const before = store.snapshotHash();
  const query = store.query({ observerId: 'npc_a', now: 120 });
  query.items[0].payload.text = 'rewritten after retrieval';
  const actual = { before, after: store.snapshotHash(), text: store.promises('npc_a', 120)[0].text,
    revision: store.toJSON().records[0].revision, count: store.toJSON().records.length };
  console.log('M3b actual:', JSON.stringify(actual));
  assert.equal(actual.after, actual.before);
  assert.equal(actual.text, 'save food');
});
