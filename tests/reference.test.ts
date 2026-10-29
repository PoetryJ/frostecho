import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecideInput, Observation, createReferenceProvider, referenceDecision } from '../src/agent';

function input(observation: Observation, feedback: DecideInput['feedback'] = null): DecideInput {
  return { observation, goal: { hungerAtLeast: 70 }, feedback };
}

const reachable = ['dorm', 'kitchen'] as const;

test('reference policy moves, eats, or stops from its own input', () => {
  assert.equal(referenceDecision(input({ id: 'npc_a', location: 'dorm', hunger: 40, foodHere: 0, reachable: [...reachable] })), '{"type":"move","to":"kitchen"}');
  assert.equal(referenceDecision(input({ id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [...reachable] })), '{"type":"eat"}');
  assert.equal(referenceDecision(input({ id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 0, reachable: [...reachable] })), '{"type":"stop"}');
  assert.equal(referenceDecision(input({ id: 'npc_a', location: 'dorm', hunger: 70, foodHere: 0, reachable: [...reachable] })), '{"type":"stop"}');
});

test('reference policy ignores feedback and does not need a world', async () => {
  const decided = input(
    { id: 'npc_a', location: 'dorm', hunger: 40, foodHere: 0, reachable: [...reachable] },
    { round: 1, kind: 'invalid_output', detail: 'invalid JSON' },
  );
  assert.equal(referenceDecision(decided), '{"type":"move","to":"kitchen"}');
  const provider = createReferenceProvider();
  assert.equal(await provider.decide(decided, new AbortController().signal), '{"type":"move","to":"kitchen"}');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => provider.decide(decided, ac.signal), (err: Error) => err.name === 'AbortError');
});
