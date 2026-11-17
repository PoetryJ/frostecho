import test from 'node:test';
import assert from 'node:assert/strict';
import { R8Runtime } from './runtime';
import { runStep, closeTaskOnReceipt } from './step';
import { makeChoiceResult, type ChoiceRequest, type Candidate } from '../../decision/contracts';
import { referenceAgencyScorer, referenceUtility, referenceUtilityWithGoals } from '../agency/reference';
import { taskBindingOfCandidate, WORK_PROXY_TASKS } from '../agency/options';
import type { TaskTypeId } from '../domains/tasks/index';

function assign(runtime: R8Runtime, type: TaskTypeId) {
  const actor = runtime.context().actorIds[0];
  runtime.dispatch('tasks', 'propose', actor, { type, assigneeId: actor });
  const taskId = runtime.states.tasks.tasks.at(-1)!.taskId;
  runtime.dispatch('tasks', 'respond', actor, { taskId, verdict: 'accept' });
  return taskId;
}

function forced(select: (request: ChoiceRequest) => Candidate | undefined) {
  return { identity: referenceAgencyScorer().identity, score(request: ChoiceRequest) {
    const candidate = select(request);
    return makeChoiceResult({ request, scorerId: 'test-explicit-bound-task',
      scores: request.candidates.map(row => ({ candidateId: row.id, logit: Number(row.id === candidate?.id) })),
      disposition: candidate ? 'accept' : 'abstain', selectedId: candidate?.id ?? null,
      reason: 'CPU authority test over actual offered candidates' });
  } };
}

test('two same-type tasks close only the selected task and report the committed completion', async () => {
  const runtime = R8Runtime.create({ seed: 'bound-two' });
  const first = assign(runtime, 'COLLECT_FOOD'), second = assign(runtime, 'COLLECT_FOOD');
  let captured!: ChoiceRequest, selected!: Candidate;
  const result = await runStep(runtime, forced(request => {
    captured = request;
    selected = request.candidates.find(row => row.parameters.taskId === second)!;
    return selected;
  }), { actorIds: ['npc_01'] });
  assert.equal(result.executed, 1);
  assert.equal(result.records[0].taskCompleted, second);
  assert.equal(result.records[0].taskCompletionEvidence, 'task-primitive');
  assert.equal(runtime.states.tasks.tasks.find(row => row.taskId === first)!.status, 'accepted');
  assert.equal(runtime.states.tasks.tasks.find(row => row.taskId === second)!.status, 'done');
  assert.equal(referenceUtilityWithGoals(selected, captured), Number((referenceUtility(selected, captured) + .25).toFixed(6)));
  const wrongGoal = { ...captured, goals: [{ taskId: first, type: 'COLLECT_FOOD', status: 'accepted' }] };
  assert.equal(referenceUtilityWithGoals(selected, wrongGoal), referenceUtility(selected, wrongGoal));
  assert.equal(closeTaskOnReceipt(runtime, 'npc_01', selected, result.records[0].eventIds), null);
});

test('terminal tasks disappear from goals and cannot confer a reference obligation bonus', async () => {
  const runtime = R8Runtime.create({ seed: 'no-terminal-goals' });
  const done = assign(runtime, 'COLLECT_FOOD');
  await runStep(runtime, forced(request => request.candidates.find(row => row.parameters.taskId === done)), { actorIds: ['npc_01'] });
  const cancelled = assign(runtime, 'COLLECT_WOOD');
  runtime.dispatch('tasks', 'cancel', 'npc_01', { taskId: cancelled });
  const active = assign(runtime, 'MAINTAIN_POWER');
  let captured!: ChoiceRequest;
  await runStep(runtime, forced(request => { captured = request; return undefined; }), { actorIds: ['npc_01'] });
  const goals = captured.goals as { taskId: string; status: string }[];
  assert.deepEqual(goals.map(row => row.taskId), [active]);
  assert.equal(goals[0].status, 'accepted');
  assert.equal(captured.candidates.some(row => row.parameters.taskId === done || row.parameters.taskId === cancelled), false);
  const activeCandidate = captured.candidates.find(row => row.parameters.taskId === active)!;
  const terminalRequest = { ...captured, goals: [{ taskId: active, type: 'MAINTAIN_POWER', status: 'done' }] };
  assert.equal(referenceUtilityWithGoals(activeCandidate, terminalRequest), referenceUtility(activeCandidate, terminalRequest));
});

for (const type of WORK_PROXY_TASKS) test(`${type} closes only its explicitly bound existing worked-receipt contract; proxy is marked`, async () => {
  const runtime = R8Runtime.create({ seed: `work-proxy-${type}` });
  const taskId = assign(runtime, type);
  const result = await runStep(runtime, forced(request => request.candidates.find(row => row.parameters.taskId === taskId)), { actorIds: ['npc_01'] });
  assert.equal(result.executed, 1);
  assert.equal(result.records[0].taskCompleted, taskId);
  assert.equal(result.records[0].taskCompletionEvidence, 'work-proxy');
  const receipts = result.records[0].eventIds.map(id => runtime.committedEvent(id)!);
  assert.ok(receipts.some(row => row.type === 'worked'));
  assert.equal(receipts.some(row => ['scouted', 'morale_boosted', 'materials_collected'].includes(row.type)), false);
  assert.equal(runtime.states.tasks.tasks.find(row => row.taskId === taskId)!.status, 'done');
});

test('a forged task type cannot bind the wrong execution primitive or reuse an earlier receipt', async () => {
  const runtime = R8Runtime.create({ seed: 'bound-negative' });
  const food = assign(runtime, 'COLLECT_FOOD');
  let selected!: Candidate;
  const result = await runStep(runtime, forced(request => {
    selected = request.candidates.find(row => row.parameters.taskId === food)!;
    return selected;
  }), { actorIds: ['npc_01'] });
  const power = assign(runtime, 'MAINTAIN_POWER');
  const forged = { ...selected, parameters: { ...selected.parameters, taskId: power, taskType: 'MAINTAIN_POWER' } };
  assert.equal(taskBindingOfCandidate(forged), null);
  assert.equal(closeTaskOnReceipt(runtime, 'npc_01', forged, result.records[0].eventIds), null);
  const anotherFood = assign(runtime, 'COLLECT_FOOD');
  const replay = { ...selected, parameters: { ...selected.parameters, taskId: anotherFood } };
  assert.equal(closeTaskOnReceipt(runtime, 'npc_01', replay, result.records[0].eventIds), null);
  assert.equal(runtime.states.tasks.tasks.find(row => row.taskId === anotherFood)!.status, 'accepted');
});

test('bridge goal changes during scoring void the result without a second task queue', async () => {
  const runtime = R8Runtime.create({ seed: 'bridge-revision' });
  let status = 'active', afterCalls = 0;
  const bridge = { view: () => ({ goals: [{ legacyTaskId: 'existing-task', status }], candidates: [] }),
    afterCommit: () => { afterCalls += 1; } };
  const version = runtime.world.version;
  const scorer = forced(request => {
    status = 'cancelled';
    return request.candidates.find(row => row.parameters.action === 'gather');
  });
  const result = await runStep(runtime, scorer, { actorIds: ['npc_01'], goalBridge: bridge });
  assert.equal(result.executed, 0);
  assert.equal(result.records[0].executionStatus, 'stale');
  assert.equal(runtime.world.version, version);
  assert.equal(afterCalls, 0);
});

test('reference commitment bonus binds exact task/revision and yields to immediate survival needs', async () => {
  const runtime = R8Runtime.create({ seed: 'bridge-score' });
  let request!: ChoiceRequest;
  await runStep(runtime, forced(value => { request = value; return undefined; }), { actorIds: ['npc_01'] });
  const candidate = { ...request.candidates[0], kind: 'deliver', parameters: {
    action: 'deliver', legacyTaskId: 'legacy-1', commitmentId: 'commitment-1', commitmentRevision: 2,
  }};
  const goal = { source: 'legacy-commitment', taskId: 'legacy-1', commitmentId: 'commitment-1', revision: 2, status: 'active' };
  const current = { ...request, goals: [goal] };
  assert.equal(referenceUtilityWithGoals(candidate, current), 0.73);
  for (const change of [{revision: 1}, {status: 'cancelled'}, {taskId: 'different'}, {commitmentId: 'different'}])
    assert.equal(referenceUtilityWithGoals(candidate, {...request, goals: [{...goal, ...change}]}), 0.48);
  const urgent = {...current, observation: {resources: {food: 1}, self: {hunger: 20, stamina: 80}}};
  assert.equal(referenceUtilityWithGoals(candidate, urgent), 0.48);
});
