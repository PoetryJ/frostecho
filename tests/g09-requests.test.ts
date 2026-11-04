/**
 * G09 worker A tests — the request state machine and the authoritative
 * fulfilment rule, as pure data (no provider, no world).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  G09_REQUEST_TEXT, G09_SELF_TEXT, goalOptionsIssues, strictGoalChoice,
} from '../src/negotiation/contracts';
import {
  createGoalRequest, decideGoalRequest, expireGoalRequest, selfGoalBinding, validateGoalRequestSnapshot,
} from '../src/negotiation/requests';
import {
  bindingIssues, checkGoalFulfilment, deriveFulfilmentEvidence,
  type GoalCheckCommand, type GoalCheckSnapshot,
} from '../src/negotiation/goal-check';

function choiceRequest(overrides: Partial<Parameters<typeof createGoalRequest>[0]> = {}) {
  const built = createGoalRequest({
    requestId: 'req-1', episodeId: 'g09-r1-s40-choice', to: 'npc_a',
    text: G09_REQUEST_TEXT, options: ['feed_self', 'yield_once'],
    createdAtSimTime: 0, arm: 'choice', ...overrides,
  });
  assert.ok(built.ok);
  return built.value;
}

function selfRequest() {
  const built = createGoalRequest({
    requestId: 'req-2', episodeId: 'g09-r1-s40-self_only', to: 'npc_a',
    text: G09_SELF_TEXT, options: ['feed_self'], createdAtSimTime: 0, arm: 'self_only',
  });
  assert.ok(built.ok);
  return built.value;
}

test('the offer cannot be forced or threshold-filtered', () => {
  assert.deepEqual(goalOptionsIssues(['feed_self', 'yield_once']), []);
  assert.deepEqual(goalOptionsIssues(['feed_self']), []);
  assert.ok(goalOptionsIssues(['yield_once']).some(i => i.includes('forced yield')));
  assert.ok(goalOptionsIssues(['feed_self', 'feed_self']).length > 0);
  assert.ok(goalOptionsIssues([]).length > 0);
  // The builder has no satiety parameter at all: the same inputs produce the
  // same offer whatever the world looks like — no 40/60 threshold can filter.
  const at40 = choiceRequest();
  const at60 = choiceRequest();
  assert.deepEqual(at40.options, at60.options);
  // self_only may never offer yield_once.
  const forced = createGoalRequest({
    requestId: 'req-x', episodeId: 'e', to: 'npc_a', text: 'x',
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'self_only',
  });
  assert.ok(!forced.ok);
});

test('decideGoalRequest: yield accepts, feed_self rejects (a legal refusal)', () => {
  const base = choiceRequest();
  const accepted = decideGoalRequest({
    raw: '{"goal":"yield_once"}', round: 1, decidedAtSimTime: 0,
    request: base, episodeId: base.episodeId,
  });
  assert.ok(accepted.ok);
  assert.equal(accepted.value.request.status, 'accepted');
  assert.equal(accepted.value.binding.goal, 'yield_once');
  assert.equal(accepted.value.binding.requestId, 'req-1');

  const rejected = decideGoalRequest({
    raw: '{"goal":"feed_self"}', round: 1, decidedAtSimTime: 0,
    request: base, episodeId: base.episodeId,
  });
  assert.ok(rejected.ok);
  assert.equal(rejected.value.request.status, 'rejected');
  assert.equal(rejected.value.binding.goal, 'feed_self');
});

test('decideGoalRequest: invalid answers and late answers', () => {
  const base = choiceRequest();
  for (const raw of ['{"goal":"share"}', '{"goal":"yield_once","extra":1}', '{"goal":"yield_once","goal":"feed_self"}', 'not json', '{"type":"eat"}']) {
    const bad = decideGoalRequest({ raw, round: 1, decidedAtSimTime: 0, request: base, episodeId: base.episodeId });
    assert.ok(!bad.ok, raw);
  }
  // A late answer expires the request: the binding records the answer but
  // the request never becomes accepted.
  const late = decideGoalRequest({ raw: '{"goal":"yield_once"}', round: 2, decidedAtSimTime: 0, request: base, episodeId: base.episodeId });
  assert.ok(late.ok);
  assert.equal(late.value.request.status, 'expired');
  assert.equal(late.value.binding.goal, 'yield_once');
  // Deciding twice is refused.
  const decided = decideGoalRequest({ raw: '{"goal":"feed_self"}', round: 1, decidedAtSimTime: 0, request: base, episodeId: base.episodeId });
  assert.ok(decided.ok);
  const again = decideGoalRequest({ raw: '{"goal":"yield_once"}', round: 1, decidedAtSimTime: 0, request: decided.value.request, episodeId: base.episodeId });
  assert.ok(!again.ok);
});

test('self declarations may only be feed_self; expiry follows the deadline round', () => {
  const ok = selfGoalBinding('g09-r1-s40-self_only', '{"goal":"feed_self"}', 1, 0);
  assert.ok(ok.ok);
  assert.equal(ok.value.requestId, null);
  const forced = selfGoalBinding('e', '{"goal":"yield_once"}', 1, 0);
  assert.ok(!forced.ok);

  const pending = selfRequest();
  assert.equal(expireGoalRequest(pending, 1).status, 'pending');
  assert.equal(expireGoalRequest(pending, 2).status, 'expired');
  const decided = decideGoalRequest({ raw: '{"goal":"feed_self"}', round: 1, decidedAtSimTime: 0, request: pending, episodeId: pending.episodeId });
  assert.ok(decided.ok);
  assert.equal(expireGoalRequest(decided.value.request, 5).status, 'rejected', 'a decided request never expires');
});

test('strictGoalChoice: exactly the one-key object within the offered options', () => {
  assert.deepEqual(strictGoalChoice('{"goal":"feed_self"}'), { ok: true, goal: 'feed_self' });
  assert.deepEqual(strictGoalChoice('{"goal":"yield_once"}', ['feed_self', 'yield_once']), { ok: true, goal: 'yield_once' });
  assert.ok(!strictGoalChoice('{"goal":"yield_once"}', ['feed_self']).ok);
  assert.ok(!strictGoalChoice('{"goal":"yield_once","x":0}').ok);
  assert.ok(!strictGoalChoice(null).ok);
  assert.ok(!strictGoalChoice('').ok);
});

function command(seq: number, actorId: string, type: string, status: string): GoalCheckCommand {
  return { seq, command: { commandId: `c${seq}`, actorId, type }, result: { status } };
}

function snapshot(commands: GoalCheckCommand[]): GoalCheckSnapshot {
  return { commands };
}

test('fulfilment: only the real eat outcome兑现 a yield', () => {
  // NPC ate first (seq 1 accepted), player's attempt then fails: violated.
  const violated = checkGoalFulfilment({ goal: 'yield_once' }, snapshot([
    command(1, 'npc_a', 'eat', 'accepted'),
    command(2, 'player', 'eat', 'rejected'),
  ]));
  assert.equal(violated.verdict, 'violated');
  assert.equal(violated.evidence.npcAteBeforePlayer, true);
  assert.equal(violated.evidence.playerAte, false);

  // The player actually got the food: fulfilled even though the NPC was asked.
  const fulfilled = checkGoalFulfilment({ goal: 'yield_once' }, snapshot([
    command(1, 'player', 'eat', 'accepted'),
  ]));
  assert.equal(fulfilled.verdict, 'fulfilled');

  // The NPC's eat bounced (no food) and the player ate: still fulfilled.
  const bounced = checkGoalFulfilment({ goal: 'yield_once' }, snapshot([
    command(1, 'npc_a', 'eat', 'rejected'),
    command(2, 'player', 'eat', 'accepted'),
  ]));
  assert.equal(bounced.verdict, 'fulfilled');
  assert.equal(bounced.evidence.npcAteBeforePlayer, false);

  // Nobody ate: the promise is untested, not kept.
  const undetermined = checkGoalFulfilment({ goal: 'yield_once' }, snapshot([
    command(1, 'npc_a', 'move', 'accepted'),
    command(2, 'player', 'eat', 'rejected'),
  ]));
  assert.equal(undetermined.verdict, 'undetermined');

  // feed_self owes nothing — a legal refusal, whatever happened next.
  const refused = checkGoalFulfilment({ goal: 'feed_self' }, snapshot([
    command(1, 'npc_a', 'eat', 'accepted'),
    command(2, 'player', 'eat', 'rejected'),
  ]));
  assert.equal(refused.verdict, 'not_applicable');

  // The player never even attempted: undetermined, never silently fulfilled.
  assert.equal(checkGoalFulfilment({ goal: 'yield_once' }, snapshot([])).verdict, 'undetermined');
});

test('bindingIssues: the request state must match the binding', () => {
  const base = choiceRequest();
  const decided = decideGoalRequest({ raw: '{"goal":"yield_once"}', round: 1, decidedAtSimTime: 0, request: base, episodeId: base.episodeId });
  assert.ok(decided.ok);
  assert.deepEqual(bindingIssues(decided.value.binding, decided.value.request), []);

  const refused = decideGoalRequest({ raw: '{"goal":"feed_self"}', round: 1, decidedAtSimTime: 0, request: base, episodeId: base.episodeId });
  assert.ok(refused.ok);
  assert.deepEqual(bindingIssues(refused.value.binding, refused.value.request), []);

  // A tampered status is caught.
  const tamperedRequest = { ...decided.value.request, status: 'rejected' as const };
  assert.ok(bindingIssues(decided.value.binding, tamperedRequest).length > 0);

  // A self binding may not claim yield.
  const selfOk = selfGoalBinding('e1', '{"goal":"feed_self"}', 1, 0);
  assert.ok(selfOk.ok);
  assert.deepEqual(bindingIssues(selfOk.value, null), []);
  const selfYield = { ...selfOk.value, goal: 'yield_once' as const };
  assert.ok(bindingIssues(selfYield, null).length > 0);

  // A pending request with a binding is inconsistent.
  assert.ok(bindingIssues(decided.value.binding, base).length > 0);
});

test('validateGoalRequestSnapshot guards the recorded shape', () => {
  const base = choiceRequest();
  const ok = validateGoalRequestSnapshot(base);
  assert.ok(ok.ok);
  assert.ok(!validateGoalRequestSnapshot({ ...base, schema: 'frostecho.g09.goal-request/2' }).ok);
  assert.ok(!validateGoalRequestSnapshot({ ...base, options: ['yield_once'] }).ok);
  assert.ok(!validateGoalRequestSnapshot({ ...base, status: 'accepted', decision: null }).ok);
  assert.ok(!validateGoalRequestSnapshot({ ...base, deadlineAfterRound: 0 }).ok);
  assert.ok(!validateGoalRequestSnapshot('nope').ok);
});

test('evidence treats a missing player attempt conservatively', () => {
  const evidence = deriveFulfilmentEvidence({ goal: 'yield_once' }, snapshot([
    command(1, 'npc_a', 'eat', 'accepted'),
  ]));
  assert.equal(evidence.npcAteBeforePlayer, true);
  assert.equal(evidence.playerAte, false);
});
