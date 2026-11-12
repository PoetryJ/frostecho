import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPlanningRequest,
  generateCandidates,
  jsonScorer,
  jevShadowScorer,
  referenceScorer,
  utilityOf,
  type PlanningView,
  type PromiseRef,
} from '../src/planning/candidates';

function view(overrides: Partial<PlanningView> = {}): PlanningView {
  return {
    actorId: 'npc_a',
    npcs: [{ id: 'npc_a', hunger: 30, stamina: 60, health: 100, san: 70, alive: true }],
    resources: { food: 3, firewood: 3, power: 30, medicine: 1 },
    furnace: { lit: true, fuel: 40, warmth: 18 },
    weather: 'snow',
    ...overrides,
  };
}

function request(overrides: Partial<PlanningView> = {}, promises: PromiseRef[] = []) {
  return buildPlanningRequest({
    view: view(overrides),
    promises,
    stateVersion: 4,
    requestId: 'req-plan-1',
    memorySnapshotHash: 'hash-1',
    memoryPolicyVersion: 'memory-policy/1',
  });
}

test('a candidate is only offered when its preconditions hold', () => {
  const withFood = generateCandidates({ view: view() });
  assert.ok(withFood.some(candidate => candidate.kind === 'eat'));
  const withoutFood = generateCandidates({ view: view({ resources: { food: 0, firewood: 0, power: 0, medicine: 0 } }) });
  assert.ok(!withoutFood.some(candidate => candidate.kind === 'eat'));
  assert.ok(withoutFood.some(candidate => candidate.kind === 'wait'));
});

test('only active promises produce a help candidate', () => {
  const active = generateCandidates({ view: view(),
    promises: [{ promiseId: 'p-1', toId: 'player', status: 'active', revision: 2 }] });
  assert.ok(active.some(candidate => candidate.kind === 'help'));
  const cancelled = generateCandidates({ view: view(),
    promises: [{ promiseId: 'p-1', toId: 'player', status: 'cancelled', revision: 3 }] });
  assert.ok(!cancelled.some(candidate => candidate.kind === 'help'));
});

test('utility is not a probability', async () => {
  const req = request();
  const result = await referenceScorer().score(req);
  assert.equal(result.disposition, 'accept');
  const sum = result.scores.reduce((total, score) => total + (score.probability ?? 0), 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
  const eat = req.candidates.find(candidate => candidate.id === 'c-eat')!;
  assert.equal(eat.utilityComponents.hunger_need, 0.7);
});

test('candidate order does not change per-id utility or the selected id', async () => {
  const req = request();
  const reversed = { ...req, candidates: [...req.candidates].reverse() };
  const left = await referenceScorer().score(req);
  const right = await referenceScorer().score(reversed);
  assert.equal(left.selectedId, right.selectedId);
  for (const score of left.scores) {
    const other = right.scores.find(entry => entry.candidateId === score.candidateId)!;
    assert.equal(score.logit, other.logit);
  }
});

test('an obligation beats a mild hunger when the promise is active', async () => {
  const req = request({ npcs: [{ id: 'npc_a', hunger: 80, stamina: 80, health: 100, san: 80, alive: true }] },
    [{ promiseId: 'p-1', toId: 'player', status: 'active', revision: 1 }]);
  const result = await referenceScorer().score(req);
  assert.equal(result.selectedId, 'c-help-p-1');
});

test('empty candidate sets are unavailable, not a softmax over nothing', async () => {
  const req = request();
  const dead = { ...req, candidates: [] };
  const result = await referenceScorer().score(dead);
  assert.equal(result.disposition, 'unavailable');
  assert.equal(result.selectedId, null);
  assert.equal(result.scores.length, 0);
});

test('json scorer rejects a selection outside the candidate set', async () => {
  const req = request();
  const scorer = jsonScorer('json-1', () => ({ selectedId: 'c-not-there' }));
  await assert.rejects(async () => scorer.score(req), (error: unknown) =>
    (error as { code?: string }).code === 'unbound_selection');
});

test('json scorer handles malformed output as unavailable', async () => {
  const req = request();
  const scorer = jsonScorer('json-1', () => '{not json');
  const result = await scorer.score(req);
  assert.equal(result.disposition, 'unavailable');
  assert.match(result.reason, /json_parse_error/);
});

test('jev shadow never accepts an action', async () => {
  const req = request();
  const shadow = jevShadowScorer('jev-shadow', request => [
    { candidateId: 'c-eat', logit: 3, probability: 0.7 },
  ]);
  const result = await shadow.score(req);
  assert.equal(result.disposition, 'abstain');
  assert.equal(result.selectedId, null);
  assert.match(result.reason, /shadow_only/);
});

test('jev without a loaded model is unavailable, not a fake success', async () => {
  const result = await jevShadowScorer('jev-shadow').score(request());
  assert.equal(result.disposition, 'unavailable');
  assert.match(result.reason, /model_not_loaded/);
});

test('eight npcs each get a legal candidate set under scarcity', () => {
  const npcs = Array.from({ length: 8 }, (_, index) => ({
    id: `npc_${index}`, hunger: 20 + index * 5, stamina: 60, health: 100, san: 70, alive: true,
  }));
  for (const npc of npcs) {
    const candidates = generateCandidates({ view: { ...view(), actorId: npc.id, npcs,
      resources: { food: 2, firewood: 1, power: 10, medicine: 0 } } });
    assert.ok(candidates.length > 0);
    assert.ok(candidates.some(candidate => candidate.id === 'c-wait'));
    for (const candidate of candidates) assert.ok(Number.isFinite(utilityOf(candidate)));
  }
});
