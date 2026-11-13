/**
 * G09-R1 worker A tests — the corrected request contract:
 * logical-time deadlines, acceptance-seq boundaries, monotonic terminals,
 * game-level consumption and the selected-goal evaluator.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  G09_REQUEST_TEXT, S1_TEXT, fulfilmentVerdict, goalOptionsIssues, renderGoalChoicePrompt, strictGoalChoice,
} from '../src/negotiation/contracts';
import {
  cancelRequest, createGoalRequest, createRequestStore, decideGoalRequest, enqueueGoalRequest,
  evaluateGoal, expireRequestIfDue, markRequestProcessed, pendingRequestFor, processAcceptedCommand,
  validateGoalRequestSnapshot,
} from '../src/negotiation/requests';
import { bindingIssues, deriveFulfilmentEvidence, replayRequestOutcome } from '../src/negotiation/goal-check';

function request(overrides: Partial<Parameters<typeof createGoalRequest>[0]> = {}, simTime = 0) {
  const built = createGoalRequest({
    requestId: 'req-1', episodeId: 'ep-1', to: 'npc_a', text: S1_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: simTime, arm: 'choice', ...overrides,
  });
  assert.ok(built.ok, built.ok ? '' : built.issues.join('; '));
  return built.value;
}

function accepted(requestValue = request(), decidedAtSimTime = 0) {
  const decided = decideGoalRequest({
    request: requestValue, episodeId: requestValue.episodeId,
    raw: '{"goal":"yield_once"}', round: 1, decidedAtSimTime, currentSeq: 3,
  });
  assert.ok(decided.ok, decided.ok ? '' : decided.issues.join('; '));
  return decided.value;
}

test('the frozen S1 is the request text in BOTH candidate sets', () => {
  assert.equal(G09_REQUEST_TEXT, '请把最后一份食物留给我，你先不要吃。');
  assert.equal(S1_TEXT, G09_REQUEST_TEXT);
  assert.deepEqual(goalOptionsIssues(['feed_self']), []);
  assert.ok(goalOptionsIssues(['yield_once']).some(issue => issue.includes('forced yield')));
});

test('the deadline is logical time: createdAt + 1, never a provider round', () => {
  const req = request({}, 0);
  assert.equal(req.expiresAtSimTime, 1);
  assert.equal(req.createdAtSimTime, 0);
  assert.ok(!Object.hasOwn(req, 'deadlineAfterRound'), 'the round field must not exist at all');
  const later = request({}, 5);
  assert.equal(later.expiresAtSimTime, 6);
  // Acceptance never extends it.
  const decided = accepted(request({}, 4), 4);
  assert.equal(decided.binding?.expiresAtSimTime, 5);
});

test('an answer at or after the expiry binds nothing', () => {
  for (const at of [1, 2, 5]) {
    const decided = accepted(request(), at);
    assert.equal(decided.binding, null, `simTime ${at}`);
    assert.equal(decided.request.status, 'expired');
    assert.equal(decided.request.outcome, 'expired');
    assert.equal(decided.request.decision, null);
  }
  // One tick before the expiry still binds, carrying the original expiry.
  const ok = accepted(request(), 0);
  assert.equal(ok.request.status, 'accepted');
  assert.equal(ok.binding?.expiresAtSimTime, 1);
  assert.equal(ok.binding?.acceptedAfterSeq, 3);
});

test('feed_self declines without a binding; strict parser rejects everything else', () => {
  const base = request();
  const declined = decideGoalRequest({ request: base, episodeId: base.episodeId, raw: '{"goal":"feed_self"}', round: 1, decidedAtSimTime: 0, currentSeq: 0 });
  assert.ok(declined.ok);
  assert.equal(declined.value.request.status, 'declined');
  assert.equal(declined.value.binding, null);
  for (const raw of ['{"goal":"share"}', '{"goal":"yield_once","x":1}', '{"goal":"yield_once","goal":"feed_self"}', 'text {"goal":"yield_once"}', '{"goal":"yield_once"']) {
    const out = decideGoalRequest({ request: base, episodeId: base.episodeId, raw, round: 1, decidedAtSimTime: 0, currentSeq: 0 });
    if (raw === '{"goal":"yield_once"}') assert.ok(out.ok);
    else assert.ok(!out.ok, raw);
  }
  // Deciding twice is refused.
  const once = accepted(base);
  const twice = decideGoalRequest({ request: once.request, episodeId: base.episodeId, raw: '{"goal":"yield_once"}', round: 2, decidedAtSimTime: 0, currentSeq: 0 });
  assert.ok(!twice.ok);
});

test('NPC eats first => violated and it can never be repaired', () => {
  const { request: acceptedRequest, binding } = accepted();
  const npcEat = { seq: 4, command: { actorId: 'npc_a', type: 'eat' }, result: { status: 'accepted' } };
  const playerEat = { seq: 5, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'accepted' } };
  let state = processAcceptedCommand(acceptedRequest, binding, npcEat, 0);
  assert.equal(state.outcome, 'violated');
  state = processAcceptedCommand(state, binding, playerEat, 0);
  assert.equal(state.outcome, 'violated', 'a later player eat cannot repair the breach');
  // The frozen verdict agrees.
  assert.equal(fulfilmentVerdict({ goal: 'yield_once', npcAteBeforePlayer: true, playerAte: true }), 'violated');
});

test('the acceptance boundary excludes old commands and honours the deadline', () => {
  const { request: acceptedRequest, binding } = accepted();
  // A player eat BEFORE acceptance (seq 2 <= 3) proves nothing.
  const old = processAcceptedCommand(acceptedRequest, binding, { seq: 2, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'accepted' } }, 0);
  assert.equal(old.outcome, 'pending');
  // The same eat after acceptance fulfils it.
  const fresh = processAcceptedCommand(acceptedRequest, binding, { seq: 4, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'accepted' } }, 0);
  assert.equal(fresh.outcome, 'fulfilled');
  // A command at/after the expiry expires rather than fulfils.
  const late = processAcceptedCommand(acceptedRequest, binding, { seq: 4, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'accepted' } }, 1);
  assert.equal(late.outcome, 'expired');
  // A failed player eat is `failed` with a reason, never fulfilled.
  const failed = processAcceptedCommand(acceptedRequest, binding, { seq: 4, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'rejected', reason: 'NO_FOOD' } }, 0);
  assert.equal(failed.outcome, 'failed');
  assert.match(String(failed.outcomeReason), /NO_FOOD/);
  // Another NPC taking the food also fails the promise.
  const stolen = processAcceptedCommand(acceptedRequest, binding, { seq: 4, command: { actorId: 'npc_c', type: 'eat' }, result: { status: 'accepted' } }, 0);
  assert.equal(stolen.outcome, 'failed');
});

test('terminal states are idempotent and expiry is logical-time driven', () => {
  const { request: acceptedRequest, binding } = accepted();
  const done = processAcceptedCommand(acceptedRequest, binding, { seq: 4, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'accepted' } }, 0);
  const again = processAcceptedCommand(done, binding, { seq: 9, command: { actorId: 'npc_a', type: 'eat' }, result: { status: 'accepted' } }, 0);
  assert.equal(again.outcome, 'fulfilled', 'a fulfilled promise is never rewritten');
  assert.equal(expireRequestIfDue(done, 99).outcome, 'fulfilled', 'time alone cannot expire a fulfilled request');

  const pending = request();
  assert.equal(expireRequestIfDue(pending, 0).status, 'pending');
  assert.equal(expireRequestIfDue(pending, 1).status, 'expired', 'a pending request expires at its deadline');
  assert.equal(expireRequestIfDue(acceptedRequest, 1).outcome, 'expired');

  const cancelled = cancelRequest(acceptedRequest, 'closed');
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelRequest(cancelled, 'again').outcome, 'cancelled');
});

test('replay uses each command time and keeps a fulfilled promise fulfilled', () => {
  const { request: acceptedRequest, binding } = accepted();
  const snapshot = {
    commands: [
      { seq: 2, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'rejected' }, atSimTime: 0 },
      { seq: 4, command: { actorId: 'npc_b', type: 'eat' }, result: { status: 'accepted' }, atSimTime: 0 },
    ],
    finalSimTime: 5,
  };
  const replayed = replayRequestOutcome(acceptedRequest, binding, snapshot as never);
  assert.equal(replayed.outcome, 'fulfilled', 'a later simTime must not rewrite history');
  // Evidence is bounded by the acceptance seq.
  const evidence = deriveFulfilmentEvidence(binding!, snapshot as never);
  assert.equal(evidence.playerAte, true);
  assert.equal(evidence.npcAteBeforePlayer, false);
});

test('the game-level store dedupes, refuses conflicts and consumes once', () => {
  const store = createRequestStore();
  const first = request();
  assert.equal(enqueueGoalRequest(store, first).ok, true);
  assert.equal(enqueueGoalRequest(store, first).ok, true, 'the same id and parameters is a duplicate');
  const conflict = { ...first, text: 'another text' };
  const conflicted = enqueueGoalRequest(store, conflict);
  assert.equal(conflicted.ok, false);
  // A second live request for the same target is refused.
  const second = { ...request(), requestId: 'req-2', to: 'npc_a' };
  const blocked = enqueueGoalRequest(store, second);
  assert.equal(blocked.ok, false);
  // Pending lookup and one-time consumption.
  assert.equal(pendingRequestFor(store, 'npc_a', 0)?.requestId, 'req-1');
  assert.equal(markRequestProcessed(store, 'req-1'), true);
  assert.equal(markRequestProcessed(store, 'req-1'), false);
  assert.equal(pendingRequestFor(store, 'npc_a', 0), null, 'a processed request is never asked again');
  // Expired requests are never offered.
  const other = createRequestStore();
  enqueueGoalRequest(other, first);
  assert.equal(pendingRequestFor(other, 'npc_a', 1), null);
});

test('evaluateGoal: feed_self uses hunger, yield_once uses the request outcome', () => {
  const world = { npcs: { npc_a: { hunger: 40 } } };
  const selfGoal = evaluateGoal({ goal: 'feed_self' }, world, 'npc_a', null);
  assert.equal(selfGoal.basis, 'hunger');
  assert.equal(selfGoal.achieved, false);
  assert.equal(evaluateGoal({ goal: 'feed_self' }, { npcs: { npc_a: { hunger: 70 } } }, 'npc_a', null).achieved, true);

  const { request: acceptedRequest } = accepted();
  const pendingYield = evaluateGoal({ goal: 'yield_once' }, { npcs: { npc_a: { hunger: 90 } } }, 'npc_a', acceptedRequest);
  assert.equal(pendingYield.basis, 'request');
  assert.equal(pendingYield.achieved, false, 'a full stomach never proves a kept promise');
  const violated = { ...acceptedRequest, outcome: 'violated' as const };
  assert.equal(evaluateGoal({ goal: 'yield_once' }, world, 'npc_a', violated).achieved, false);
  const fulfilled = { ...acceptedRequest, outcome: 'fulfilled' as const };
  assert.equal(evaluateGoal({ goal: 'yield_once' }, world, 'npc_a', fulfilled).achieved, true);
});

test('bindingIssues enforces the acceptance contract', () => {
  const { request: acceptedRequest, binding } = accepted();
  assert.deepEqual(bindingIssues(binding!, acceptedRequest), []);
  assert.ok(bindingIssues({ ...binding!, expiresAtSimTime: 99 }, acceptedRequest).length > 0);
  assert.ok(bindingIssues({ ...binding!, acceptedAfterSeq: 0 }, acceptedRequest).length > 0);
  const declined = decideGoalRequest({ request: request(), episodeId: 'ep-1', raw: '{"goal":"feed_self"}', round: 1, decidedAtSimTime: 0, currentSeq: 0 });
  assert.ok(declined.ok);
  assert.ok(bindingIssues(binding!, declined.value.request).length > 0, 'a declined request cannot carry an active binding');
});

test('the frozen goal prompt is one template for both arms', () => {
  const base = {
    actorId: 'npc_a', location: 'kitchen', simTime: 0, selfSatiety: 40,
    foodKitchen: 1, text: S1_TEXT, requestId: 'HOST-SECRET', episodeId: 'HOST-EPISODE',
    playerSatiety: 13, playerId: 'npc_b',
  };
  const self = renderGoalChoicePrompt({ ...base, options: ['feed_self'], arm: 'self_only' });
  const choice = renderGoalChoicePrompt({ ...base, options: ['feed_self', 'yield_once'], arm: 'choice' });
  const normalise = (prompt: string) => prompt.split('\n').map(line => (line.startsWith('candidateGoals:') ? 'candidateGoals: <DATA>' : line)).join('\n');
  assert.equal(normalise(self), normalise(choice));
  assert.ok(self.includes(S1_TEXT) && choice.includes(S1_TEXT));
  for (const prompt of [self, choice]) {
    assert.ok(!prompt.includes('HOST-SECRET') && !prompt.includes('HOST-EPISODE'));
    assert.ok(!prompt.includes('self_only') && !prompt.includes('choice'));
    assert.ok(!prompt.includes('13'), 'the other NPC satiety must never enter the prompt');
  }
  assert.equal(renderGoalChoicePrompt({ ...base, selfSatiety: 40, options: ['feed_self'], arm: 'choice' }), renderGoalChoicePrompt({ ...base, selfSatiety: 40, options: ['feed_self'], arm: 'choice' }));
});

test('the snapshot validator enforces the new schema', () => {
  const req = request();
  assert.ok(validateGoalRequestSnapshot(req).ok);
  assert.ok(!validateGoalRequestSnapshot({ ...req, expiresAtSimTime: 5 }).ok);
  assert.ok(!validateGoalRequestSnapshot({ ...req, schema: 'frostecho.g09.goal-request/1' }).ok);
  assert.ok(!validateGoalRequestSnapshot({ ...req, status: 'accepted', acceptedAfterSeq: null }).ok);
  assert.ok(!strictGoalChoice('{"goal":"yield_once"}', ['feed_self']).ok);
});
