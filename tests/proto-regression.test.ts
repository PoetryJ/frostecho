import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld } from '../src';
import { dump, globalChecks } from './helpers';

test('formal regression: actorId "proto" -> UNKNOWN_ACTOR, state and events unchanged', () => {
  const eng = new Engine(initialWorld());
  const before = eng.getState();
  const result = eng.submit({ commandId: 'reg-proto', actorId: 'proto', type: 'move', payload: { to: 'kitchen' } });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'UNKNOWN_ACTOR');
  assert.deepEqual(eng.getState(), before);
  assert.deepEqual(eng.getEvents(), []);
  assert.equal(eng.getLog().length, 1);
  assert.equal(eng.getLog()[0].command.actorId, 'proto');
  assert.equal(eng.getLog()[0].result.reason, 'UNKNOWN_ACTOR');
  globalChecks(eng);
  dump('regression-proto', eng);
});

test('formal regression: actorId "__proto__" -> UNKNOWN_ACTOR, state and events unchanged', () => {
  const actorId = '__proto__';
  const eng = new Engine(initialWorld());
  const before = eng.getState();
  const result = eng.submit({ commandId: 'reg-dunder-proto', actorId, type: 'move', payload: { to: 'kitchen' } });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'UNKNOWN_ACTOR');
  assert.equal(result.detail, `actor ${actorId} not found`);
  assert.deepEqual(eng.getState(), before);
  assert.deepEqual(eng.getEvents(), []);
  assert.equal(eng.getLog().length, 1);
  assert.equal(eng.getLog()[0].command.actorId, actorId);
  assert.equal(eng.getLog()[0].result.reason, 'UNKNOWN_ACTOR');
  globalChecks(eng);
  dump('regression-__proto__', eng);
});
