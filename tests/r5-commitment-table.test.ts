/**
 * R5 transition table: only the crossings that change observable behaviour.
 * terminal states absorb older changes/attempts; pending-change is not consent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommitmentBoard, isTerminal } from '../src/gameplay-v2/commitments';

function board(goal = 'deliver-meal'): { board: CommitmentBoard; id: string } {
  const board = CommitmentBoard.empty();
  const created = board.request({ promisorId: 'npc_01', beneficiaryId: 'player',
    goal, at: 0, inputId: 'req-1' });
  return { board, id: created.commitment.commitmentId };
}

function active(goal = 'deliver-meal'): { board: CommitmentBoard; id: string } {
  const created = board(goal);
  created.board.respond(created.id, 'accept', { at: 1 });
  return created;
}

test('R5-T1: pending-change is a proposal, and cancel closes it without revival', () => {
  const created = active();
  const changed = created.board.proposeChange(created.id, {
    kind: 'suspend', reason: 'hunger', terms: { resumeWhen: 'hunger>=45' }, at: 2 });
  assert.equal(changed.commitment.status, 'pending-change');
  assert.equal(changed.commitment.changes.at(-1)!.status, 'open');
  const cancelled = created.board.cancel(created.id, { at: 3 });
  assert.equal(cancelled.commitment.status, 'cancelled');
  assert.equal(cancelled.commitment.changes.at(-1)!.status, 'rejected');
  const late = created.board.respondChange(created.id,
    changed.commitment.changes.at(-1)!.changeId, 'accept', { at: 4 });
  assert.equal(late.commitment.status, 'cancelled');
  assert.match(late.event.type, /ignored/);
});

test('R5-T2: withdraw is terminal and absorbs an old accept/late receipt', () => {
  const created = active();
  const changed = created.board.proposeChange(created.id, {
    kind: 'alt-source', reason: 'shortage', terms: { source: 'gather' }, at: 2 });
  const changeId = changed.commitment.changes.at(-1)!.changeId;
  created.board.withdraw(created.id, { at: 3 });
  const lateAccept = created.board.respondChange(created.id, changeId, 'accept', { at: 4 });
  assert.equal(lateAccept.commitment.status, 'withdrawn');
  assert.equal(lateAccept.commitment.revision, changed.commitment.revision);
  assert.match(lateAccept.event.type, /ignored/);
  const lateFulfil = created.board.fulfil(created.id,
    { eventId: 'e-late', commandId: 'c-late', at: 5, amount: 1 });
  assert.equal(lateFulfil.commitment.status, 'withdrawn');
  assert.match(lateFulfil.event.type, /ignored/);
});

test('R5-T3: fulfilment revokes open changes and is receipt-only', () => {
  const created = active();
  created.board.proposeChange(created.id, {
    kind: 'alt-source', reason: 'shortage', terms: { source: 'gather' }, at: 2 });
  const fulfilled = created.board.fulfil(created.id,
    { eventId: 'meal-1', commandId: 'c-1', at: 3, amount: 1 });
  assert.equal(fulfilled.commitment.status, 'fulfilled');
  assert.ok(fulfilled.commitment.changes.every(change => change.status !== 'open'));
  const second = created.board.fulfil(created.id,
    { eventId: 'meal-2', commandId: 'c-2', at: 4, amount: 1 });
  assert.equal(second.commitment.status, 'fulfilled');
  assert.match(second.event.type, /ignored/);
});

test('R5-T4: decline is terminal and a later accept cannot revive it', () => {
  const created = board();
  const declined = created.board.respond(created.id, 'decline', { at: 2 });
  assert.equal(declined.commitment.status, 'declined');
  const late = created.board.respond(created.id, 'accept', { at: 3 });
  assert.equal(late.commitment.status, 'declined');
  assert.equal(isTerminal(late.commitment.status), true);
});

test('R5-T5: a suspended promise resumes only explicitly or by the agreed condition', () => {
  const created = active();
  created.board.proposeChange(created.id, {
    kind: 'suspend', reason: 'hunger', terms: { resumeWhen: 'hunger>=45' }, at: 2 });
  const changeId = created.board.find(created.id)!.changes.at(-1)!.changeId;
  const suspended = created.board.respondChange(created.id, changeId, 'accept', { at: 3 });
  assert.equal(suspended.commitment.status, 'suspended');
  assert.equal(suspended.commitment.revision, 2);
  const resumed = created.board.resume(created.id, { at: 4 });
  assert.equal(resumed.commitment.status, 'active');
  assert.match(resumed.event.type, /resumed/);
});
