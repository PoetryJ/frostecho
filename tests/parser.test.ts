import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAction } from '../src/agent';

test('parser accepts only move, eat, and stop', () => {
  assert.deepEqual(parseAction('{"type":"move","to":"kitchen"}'), { ok: true, action: { type: 'move', to: 'kitchen' } });
  assert.deepEqual(parseAction('{"to":"dorm","type":"move"}'), { ok: true, action: { type: 'move', to: 'dorm' } });
  assert.deepEqual(parseAction('  {"type":"eat"}\n'), { ok: true, action: { type: 'eat' } });
  assert.deepEqual(parseAction('{"type":"stop"}'), { ok: true, action: { type: 'stop' } });
});

test('parser rejects extra fields, illegal places, and non-objects', () => {
  const rejected = [
    'not json',
    '',
    'null',
    '[]',
    '"eat"',
    '{"type":"fly"}',
    '{"type":"STOP"}',
    '{"type":"move"}',
    '{"type":"move","to":"moon"}',
    '{"type":"move","to":"kitchen","actorId":"npc_b"}',
    '{"type":"move","to":"kitchen","commandId":"forged"}',
    '{"commandId":"x","actorId":"npc_a","type":"move","payload":{"to":"kitchen"}}',
    '{"type":"eat","payload":{}}',
    '{"type":"eat","actorId":"npc_b"}',
    '{"type":"stop","actorId":"npc_a"}',
    '{"type":"eat"}{"type":"stop"}',
  ];
  for (const raw of rejected) {
    const parsed = parseAction(raw);
    assert.equal(parsed.ok, false, raw);
    if (!parsed.ok) assert.equal(parsed.error.length > 0, true);
  }
});
