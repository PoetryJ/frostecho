import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCandidates, type PlanningView } from '../src/planning/candidates';
import { UnsupportedActionError, candidateCommand } from '../src/planning/commands';
import { applyCommand, createWorldV2, submitCommand } from '../src/survival/world-v2';

function view(): PlanningView {
  return {
    actorId: 'npc_a',
    npcs: [{ id: 'npc_a', hunger: 30, stamina: 40, health: 100, san: 70, alive: true }],
    resources: { food: 5, firewood: 5, power: 10, medicine: 1 },
    furnace: { lit: false, fuel: 5, warmth: 10 },
    weather: 'snow',
  };
}

test('every generated candidate is either executable or explicitly refused', () => {
  const candidates = generateCandidates({ view: view(),
    promises: [{ promiseId: 'p-1', toId: 'player', status: 'active', revision: 1 }] });
  const world = createWorldV2({ npcIds: ['npc_a'] });
  for (const candidate of candidates) {
    try {
      const command = candidateCommand(candidate, 'npc_a', `cmd-${candidate.id}`);
      if (command === null) continue;
      const result = submitCommand(world, command);
      assert.equal(result.status, 'applied', `${candidate.id} rejected: ${result.reason}`);
    } catch (error) {
      assert.ok(error instanceof UnsupportedActionError, `${candidate.id} threw ${String(error)}`);
    }
  }
});

test('candidate parameters carry the action the world will execute', () => {
  const candidates = generateCandidates({ view: view() });
  const eat = candidates.find(candidate => candidate.id === 'c-eat')!;
  assert.equal(eat.parameters.action, 'eat');
  assert.equal(eat.parameters.amount, 1);
  const gather = candidates.find(candidate => candidate.id === 'c-gather-food')!;
  assert.equal(gather.parameters.resource, 'food');
  const command = candidateCommand(eat, 'npc_a', 'c1');
  const { state } = applyCommand(createWorldV2({ npcIds: ['npc_a'] }), command!);
  assert.equal(state.resources.food, 23);
});
