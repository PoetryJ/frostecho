/**
 * R9 (B): the four invariants the long-horizon stories rely on, pinned at the
 * unit level on the real authority:
 *  1. a cancellation heard privately stops only the hearer; the others keep
 *     working until a legitimate relay reaches them;
 *  2. the bounded memory keeps the same budget in both arms, and only the new
 *     policy keeps the current obligation / condition change;
 *  3. an unanswered change proposal never becomes an action, and a known-failed
 *     withdrawal is not repeated;
 *  4. a promise is fulfilled on the committed receipt of an OCCUPIED action
 *     (the settlement hook), never on the intent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeChoiceResult, type Candidate, type ChoiceRequest } from '../../src/decision/contracts';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { createCommitmentBridge } from '../../src/r7/integration/commitment-bridge';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { executeCandidate, runStep, visibleMemory } from '../../src/r7/integration/step';
import { DEFAULT_WAREHOUSE_FOOD } from '../../src/survival/world-v2';

function forced(pick: (request: ChoiceRequest) => Candidate | undefined) {
  return { identity: referenceAgencyScorer().identity, score(request: ChoiceRequest) {
    const candidate = pick(request);
    return makeChoiceResult({ request, scorerId: 'r9-memory-invariant',
      scores: request.candidates.map(row => ({ candidateId: row.id,
        logit: Number(row.id === candidate?.id) })),
      disposition: candidate ? 'accept' : 'abstain', selectedId: candidate?.id ?? null,
      reason: 'CPU invariant test' });
  } };
}

function setup(seed: string) {
  const runtime = R8Runtime.create({ seed });
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  return { runtime, play, bridge };
}

test('a private cancellation stops only the hearer until a legitimate relay', () => {
  const { runtime, play, bridge } = setup('r9-inv-heard');
  runtime.session.submitWorldCommand({ commandId: 'm1', type: 'move',
    actorId: 'npc_01', to: 'village' });
  runtime.session.submitWorldCommand({ commandId: 'm2', type: 'move',
    actorId: 'npc_02', to: 'warehouse' });
  const own = play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const other = play.requestCommitment('npc_02', 'deliver-meal', { verdict: 'accept' });
  // The player ends both promises but only npc_02 is present to hear it.
  play.cancelCommitment(own.commitment.commitmentId, { heardBy: ['npc_02'], reason: '取消' });
  play.cancelCommitment(other.commitment.commitmentId, { heardBy: ['npc_02'], reason: '取消' });

  const unheard = bridge.view('npc_01');
  const heard = bridge.view('npc_02');
  assert.ok(unheard.candidates.length > 0);
  assert.equal((unheard.goals[0] as { belief: string }).belief, 'unheard-cancellation');
  assert.equal(heard.candidates.length, 0);
  assert.equal((heard.goals[0] as { status: string }).status, 'cancelled');

  // Never relay what was not heard.
  assert.equal(play.relayCancellation(own.commitment.commitmentId,
    { tellerId: 'npc_05', audience: ['npc_01'] }), null);
  const relay = play.relayCancellation(own.commitment.commitmentId,
    { tellerId: 'npc_02', audience: ['npc_01'] });
  assert.deepEqual(relay?.told, ['npc_01']);
  assert.equal(bridge.view('npc_01').candidates.length, 0);
  const record = runtime.session.memories.get('npc_01')!.toJSON().records
    .filter(entry => entry.kind === 'commitment_cancelled').at(-1)!;
  assert.equal(record.source, 'player_statement');
  assert.equal(record.authority, 'npc');
  assert.equal(record.speakerId, 'npc_02');
  assert.equal((record.payload as Record<string, unknown>).heardBy, 'npc_01');
});

test('both memory arms keep the same budget and only the new one keeps the obligation', () => {
  const { runtime, play } = setup('r9-inv-memory');
  play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  for (let index = 0; index < 20; index += 1) {
    runtime.session.ingestTeamEvent('team_chatter', { index }, runtime.world.simTime);
  }
  const raw = visibleMemory(runtime, 'npc_01', 12, 'raw-last12');
  const ranked = visibleMemory(runtime, 'npc_01', 12, 'obligation-first');
  assert.equal(raw.kept, ranked.kept);
  const rawKinds = raw.facts.map(fact => fact.kind);
  const rankedKinds = ranked.facts.map(fact => fact.kind);
  assert.equal(rawKinds.includes('commitment_accepted'), false);
  assert.equal(rankedKinds.includes('commitment_accepted'), true);
  assert.equal(rankedKinds.includes('team_chatter'), true);
  assert.ok(ranked.bytes > 0 && raw.bytes > 0);
});

test('an unanswered change never becomes an action and a known failure is not repeated', () => {
  const { runtime, play, bridge } = setup('r9-inv-pending');
  // Direct commands go through the ONE executor (place gate + committed record).
  const direct = (actorId: string, action: string, parameters: Record<string, unknown>) =>
    executeCandidate(runtime, actorId, { id: `inv-${action}-${runtime.world.version}`,
      kind: action as Candidate['kind'], description: action,
      parameters: { action, ...parameters }, preconditions: [], expectedEffects: {},
      utilityComponents: {} }, `inv-${action}-${runtime.world.version}-${actorId}`);

  runtime.session.submitWorldCommand({ commandId: 'w1', type: 'move',
    actorId: 'npc_03', to: 'warehouse' });
  direct('npc_03', 'withdraw', { place: 'warehouse', amount: DEFAULT_WAREHOUSE_FOOD });
  runtime.session.submitWorldCommand({ commandId: 'w2', type: 'move',
    actorId: 'npc_01', to: 'warehouse' });
  const request = play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });

  // Witness the shortage through the real path: an out_of_stock receipt.
  const miss = direct('npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  assert.equal(miss.status, 'applied');
  assert.deepEqual(miss.eventIds.map(id => runtime.committedEvent(id)!.type), ['out_of_stock']);

  const report = bridge.view('npc_01').candidates
    .find(candidate => candidate.parameters.bridgeStep === 'propose-alt-source')!;
  assert.ok(report, 'a witnessed shortage is said, not silently worked around');
  const applied = direct('npc_01', 'report-delay', { note: 'warehouse-empty' });
  assert.equal(applied.status, 'applied');
  bridge.afterCommit('npc_01', report, []);
  assert.equal(play.commitments.find(request.commitment.commitmentId)?.status, 'pending-change');

  const pending = bridge.view('npc_01').candidates;
  assert.equal(pending.some(candidate => candidate.parameters.bridgeStep === 'gather'), false);
  assert.equal(pending.some(candidate => candidate.parameters.bridgeStep === 'withdraw'), false);
  assert.equal(pending.some(candidate => candidate.parameters.bridgeStep === 'await-answer'), true);
});

test('a promise is fulfilled on the committed receipt of an occupied action', async () => {
  const { runtime, play, bridge } = setup('r9-inv-settle');
  runtime.session.submitWorldCommand({ commandId: 'w1', type: 'move',
    actorId: 'npc_01', to: 'warehouse' });
  play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const withdraw = await runStep(runtime, forced(request => request.candidates
    .find(row => row.parameters.bridgeStep === 'withdraw')), { actorIds: ['npc_01'], goalBridge: bridge });
  assert.equal(withdraw.records[0].executionStatus, 'applied');
  // The delivery itself is occupied (15 minutes) and settles on the clock.
  const deliverStep = await runStep(runtime, forced(request => request.candidates
    .find(row => row.parameters.bridgeStep === 'to-kitchen')), { actorIds: ['npc_01'], goalBridge: bridge });
  assert.equal(deliverStep.records[0].executionStatus, 'working');
  runtime.advanceWorld(runtime.busyUntil('npc_01')!);
  const deliver = await runStep(runtime, forced(request => request.candidates
    .find(row => row.parameters.bridgeStep === 'deliver')), { actorIds: ['npc_01'], goalBridge: bridge });
  assert.equal(deliver.records[0].executionStatus, 'working');
  runtime.advanceWorld(runtime.busyUntil('npc_01')!);
  const commitment = play.commitments.all()[0];
  assert.equal(commitment.status, 'fulfilled');
  assert.equal(commitment.evidenceEventIds.length, 1);
  assert.match(commitment.evidenceEventIds[0], /:meal_delivered:/);
});
