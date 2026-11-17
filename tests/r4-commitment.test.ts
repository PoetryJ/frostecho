/**
 * R4 (G4): the negotiable commitment state machine — proposal ≠ agreement,
 * revision only on explicit accept, fulfilment only from a delivery receipt,
 * explicit exit with relation evidence, and cross-process restore.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommitmentBoard } from '../src/gameplay-v2/commitments';
import { GameplayLoop, actorCell } from '../src/gameplay-v2/loop';
import { BUILDINGS, MAPS, findPath } from '../src/spatial-v2/map';
import { initialResponse, resumeReady, shouldWithdraw, survivalProposal }
  from '../src/gameplay-v2/negotiation';

function board(): CommitmentBoard {
  return CommitmentBoard.empty();
}

function requested(b: CommitmentBoard, inputId = 'req-1') {
  return b.request({ promisorId: 'npc_01', beneficiaryId: 'player',
    goal: 'deliver-meal', conditions: ['warehouse-supply'], deadline: 960,
    at: 10, inputId });
}

test('R4-G4: a request only proposes; accept activates without touching revision', () => {
  const b = board();
  const asked = requested(b);
  assert.equal(asked.commitment.status, 'proposed');
  assert.equal(asked.commitment.revision, 1);
  assert.equal(asked.event.type, 'commitment_proposed');
  const accepted = b.respond(asked.commitment.commitmentId, 'accept', { at: 11 });
  assert.equal(accepted.commitment.status, 'active');
  assert.equal(accepted.commitment.revision, 1, 'accepting the request is not a revision');
  assert.equal(accepted.event.type, 'commitment_accepted');
});

test('R4-G4: decline is terminal and never silently becomes active', () => {
  const b = board();
  const asked = requested(b);
  const declined = b.respond(asked.commitment.commitmentId, 'decline',
    { at: 12, reason: 'dead' });
  assert.equal(declined.commitment.status, 'declined');
  const again = b.respond(asked.commitment.commitmentId, 'accept', { at: 13 });
  assert.equal(again.commitment.status, 'declined');
  assert.equal(again.event.type, 'commitment_response_ignored');
});

test('R4-G4: a change proposal waits, and only accept bumps the revision', () => {
  const b = board();
  const asked = requested(b);
  b.respond(asked.commitment.commitmentId, 'accept', { at: 11 });
  const proposed = b.proposeChange(asked.commitment.commitmentId, {
    kind: 'suspend', reason: 'hunger-critical',
    terms: { resumeWhen: 'hunger>=45' }, at: 20 });
  assert.equal(proposed.commitment.status, 'pending-change');
  assert.equal(proposed.commitment.revision, 1, 'proposal does not change terms');
  const changeId = proposed.commitment.changes[0].changeId;
  const rejected = b.respondChange(asked.commitment.commitmentId, changeId, 'reject',
    { at: 30 });
  assert.equal(rejected.commitment.status, 'active', 'reject restores the old terms');
  assert.equal(rejected.commitment.revision, 1);
  const proposed2 = b.proposeChange(asked.commitment.commitmentId, {
    kind: 'alt-source', reason: 'warehouse-empty', terms: { source: 'gather' }, at: 40 });
  const change2 = proposed2.commitment.changes.at(-1)!.changeId;
  const accepted = b.respondChange(asked.commitment.commitmentId, change2, 'accept',
    { at: 50 });
  assert.equal(accepted.commitment.revision, 2);
  assert.equal(accepted.commitment.status, 'active');
  assert.ok(accepted.commitment.conditions.includes('source:gather'));
});

test('R4-G4: fulfilment is receipt-only; cancel and fulfil are independent terminals', () => {
  const b = board();
  const asked = requested(b);
  b.respond(asked.commitment.commitmentId, 'accept', { at: 11 });
  const fulfilled = b.fulfil(asked.commitment.commitmentId, {
    eventId: 'cmd-1:meal_delivered:0', commandId: 'cmd-1', at: 60, amount: 1 });
  assert.equal(fulfilled.commitment.status, 'fulfilled');
  assert.deepEqual(fulfilled.commitment.evidenceEventIds, ['cmd-1:meal_delivered:0']);
  assert.equal(fulfilled.event.type, 'commitment_fulfilled');
  const again = b.fulfil(asked.commitment.commitmentId, {
    eventId: 'cmd-2:meal_delivered:0', commandId: 'cmd-2', at: 70, amount: 1 });
  assert.equal(again.commitment.status, 'fulfilled');
  assert.equal(again.event.type, 'commitment_response_ignored');

  const b2 = board();
  const asked2 = requested(b2, 'req-2');
  b2.respond(asked2.commitment.commitmentId, 'accept', { at: 11 });
  b2.cancel(asked2.commitment.commitmentId, { at: 20 });
  const late = b2.fulfil(asked2.commitment.commitmentId, {
    eventId: 'cmd-3:meal_delivered:0', commandId: 'cmd-3', at: 30, amount: 1 });
  assert.equal(late.commitment.status, 'cancelled', 'a cancelled commitment never fulfils');
});

test('R4-G4: explicit exit is an event with relation-bearing evidence', () => {
  const b = board();
  const asked = requested(b);
  b.respond(asked.commitment.commitmentId, 'accept', { at: 11 });
  const withdrawn = b.withdraw(asked.commitment.commitmentId,
    { at: 40, reason: 'survival-exit' });
  assert.equal(withdrawn.commitment.status, 'withdrawn');
  assert.equal(withdrawn.event.type, 'commitment_withdrawn');
  assert.equal(withdrawn.event.payload.reason, 'survival-exit');
});

test('R4-G4: retries replay on the same input id, conflicts refuse with no effect', () => {
  const b = board();
  const first = requested(b, 'req-x');
  const replay = requested(b, 'req-x');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.commitment.commitmentId, first.commitment.commitmentId);
  const conflict = b.request({ promisorId: 'npc_02', beneficiaryId: 'player',
    goal: 'deliver-meal', at: 10, inputId: 'req-x' });
  assert.equal(conflict.conflict, true);
  assert.equal(b.all().length, 1, 'a conflict creates nothing');
});

test('R4-G4: negotiation thresholds are deterministic policy, not model claims', () => {
  const healthy = { id: 'npc_01', location: 'dorm-a' as const, hunger: 60,
    stamina: 80, health: 100, san: 80, alive: true };
  assert.equal(initialResponse(healthy).verdict, 'accept');
  assert.equal(initialResponse({ ...healthy, hunger: 10 }).verdict, 'counter');
  assert.equal(initialResponse({ ...healthy, stamina: 2 }).verdict, 'counter');
  assert.equal(initialResponse({ ...healthy, alive: false }).verdict, 'decline');

  const active = { commitmentId: 'cm-1', taskId: null, promisorId: 'npc_01',
    beneficiaryId: 'player', goal: 'deliver-meal', conditions: [], deadline: null,
    revision: 1, status: 'active' as const, evidenceEventIds: [], changes: [],
    createdAt: 0, updatedAt: 0 };
  assert.equal(survivalProposal(healthy, active), null);
  const starving = { ...healthy, hunger: 20 };
  const proposal = survivalProposal(starving, active)!;
  assert.equal(proposal.kind, 'suspend');
  assert.equal(proposal.terms.resumeWhen, 'hunger>=45');
  assert.equal(resumeReady({ ...starving, hunger: 30 }, active), true,
    'no accepted resume condition yet');
  const suspended = { ...active, status: 'suspended' as const,
    changes: [{ changeId: 'chg-1', proposedRevision: 2, kind: 'suspend' as const,
      terms: { resumeWhen: 'hunger>=45' }, reason: 'x', proposedAt: 1,
      status: 'accepted' as const, respondedAt: 2, responseEventId: 'e' }] };
  assert.equal(resumeReady({ ...starving, hunger: 30 }, suspended), false);
  assert.equal(resumeReady({ ...starving, hunger: 46 }, suspended), true);
  const rejected = { ...active, status: 'pending-change' as const, changes: [
    { ...suspended.changes[0], status: 'rejected' as const }] };
  assert.equal(shouldWithdraw({ ...starving, hunger: 7 }, rejected), true);
  assert.equal(shouldWithdraw({ ...starving, hunger: 30 }, rejected), false);
});

test('R4-G4: loop story A — accept, witness shortage, propose, agree, deliver, fulfil', () => {
  const play = GameplayLoop.create(3, { seed: 'r4-story-a' });
  // A different NPC drains the warehouse, so npc_01 arrives to empty shelves.
  const route = findPath(MAPS.village, actorCell(play.session.world, 'npc_02'),
    BUILDINGS.find(building => building.id === 'warehouse')!.door).path!;
  play.session.submitWorldCommand({ commandId: 'd-t', type: 'travel',
    actorId: 'npc_02', route, minutesPerTile: 2 });
  const drained = play.session.submitWorldCommand({ commandId: 'drain-w', type: 'withdraw',
    actorId: 'npc_02', place: 'warehouse', resource: 'food', amount: 4 });
  assert.equal(drained.events[0].type, 'stock_withdrawn');
  const result = play.requestCommitment('npc_01', 'deliver-meal', { inputId: 'a-req' });
  assert.equal(result.response.verdict, 'accept');
  assert.equal(result.commitment.status, 'active');
  assert.ok(result.task);
  // Walk npc_01 to the warehouse and let it witness the empty shelves.
  for (let index = 0; index < 6 && !play.commitments.all()[0].changes.length; index += 1) {
    play.step();
  }
  const commitment = play.commitments.all()[0];
  assert.equal(commitment.status, 'pending-change');
  const change = commitment.changes[0];
  assert.equal(change.kind, 'alt-source');
  // Proposal alone changed nothing else; accepting is what enables work.
  const accepted = play.respondChange(commitment.commitmentId, 'accept', { inputId: 'a-ok' });
  assert.equal(accepted.commitment.revision, 2);
  assert.ok(accepted.commitment.conditions.includes('source:gather'));
  for (let index = 0; index < 10; index += 1) play.step();
  const final = play.commitments.all()[0];
  assert.equal(final.status, 'fulfilled');
  assert.ok(final.evidenceEventIds.some(id => id.includes('meal_delivered')));
});

test('R4-G4: loop story B — survival proposal, reject keeps terms, dying exit', () => {
  const play = GameplayLoop.create(2, { seed: 'r4-story-b', food: 0 });
  const result = play.requestCommitment('npc_01', 'deliver-meal', { inputId: 'b-req' });
  assert.equal(result.commitment.status, 'active');
  play.advance(3300);
  play.step(); // proposes suspend
  const commitment = play.commitments.all()[0];
  assert.equal(commitment.status, 'pending-change');
  assert.equal(commitment.changes[0].kind, 'suspend');
  const rejected = play.respondChange(commitment.commitmentId, 'reject', { inputId: 'b-no' });
  assert.equal(rejected.commitment.status, 'active', 'reject never becomes agreement');
  assert.equal(rejected.commitment.revision, 1);
  // Drive the promisor to the withdrawal threshold with no food available.
  for (let index = 0; index < 40; index += 1) {
    if (play.commitments.all()[0].status === 'withdrawn') break;
    play.advance(300);
    const npc = play.session.world.npcs.npc_01;
    if (!npc.alive) break;
    play.step();
  }
  const final = play.commitments.all()[0];
  assert.equal(final.status, 'withdrawn');
  const relation = play.session.knowledge().npc_01.relation as
    { trust: number; grievance: number } | null;
  assert.ok(relation && relation.trust < 0 && relation.grievance > 0,
    'an explicit exit moves the relation with evidence');
});
