/**
 * G05 workstream B self-tests — the needs loop over the reactive substrate.
 *
 * Reference policy: hunger>=50 → stop; not in kitchen → move; food here → eat;
 * else stop. Initial world: both autonomous NPCs in the kitchen, hunger 40/20,
 * no food. Every provider call is counted by hand; metabolism is driven only by
 * advance_time (30-minute boundaries), never by a wall clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { buildNeedsWorld, createNeedsGame, type NeedsGame } from '../src/needs/game';
import { NEED_DECISION_BUDGET, NEED_PERIOD_MIN } from '../src/reactive/contracts';

const makeGame = (episodeId: string, needPolicy: 'never' | 'one-shot' | 'recurring', world = buildNeedsWorld()): NeedsGame =>
  createNeedsGame({
    episodeId,
    initialState: world,
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    thinking: false,
    needPolicy,
    timeoutMs: 2_000,
  });

const callsOfGame = (game: NeedsGame): number =>
  Object.values(game.snapshot().actors).reduce((sum, actor) => sum + actor.providerCalls, 0);

/** Advance time with an ok-guarantee so tests read the success fields directly. */
const adv = (game: NeedsGame, minutes: number) => {
  const result = game.worldAdvanceTime(minutes);
  if (!result.ok) throw new Error(result.error);
  return result;
};

test('never: metabolism alone never wakes an actor — six periods, zero calls', async () => {
  const game = makeGame('b-never', 'never');
  await game.runUntilIdle(); // both stop on the empty kitchen: 2 calls
  assert.equal(callsOfGame(game), 2);
  for (let i = 0; i < 6; i++) {
    const result = adv(game, NEED_PERIOD_MIN);
    assert.deepEqual(result.needsScheduled, []);
    await game.runUntilIdle();
  }
  const snap = game.snapshot();
  assert.equal(callsOfGame(game), 2, 'no provider call may come from time alone');
  assert.equal(snap.finalState.simTime, 180);
  // 18 crossed 10-minute boundaries: 40+18 and 20+18 metabolic points
  assert.deepEqual([snap.finalState.npcs.npc_a.hunger, snap.finalState.npcs.npc_c.hunger], [58, 38]);
  assert.equal(snap.needPolicy, 'never');
  assert.deepEqual(snap.needs, []);
});

test('one-shot: only the first boundary schedules, a later boundary does not', async () => {
  const game = makeGame('b-oneshot-first', 'one-shot');
  await game.runUntilIdle(); // 2 calls, both waiting (40/20, empty kitchen)
  const first = adv(game, NEED_PERIOD_MIN);
  assert.deepEqual(first.needsScheduled, ['npc_a'], 'only npc_a is at/above hunger 30');
  // npc_a (hunger 43) is hungry now; the reference policy stops again on the
  // still-empty kitchen, the need keeps scheduling it until the decision budget
  // expires the episode. That interruption path is asserted below; here we feed
  // it instead to check one-shot satisfaction.
  const fed = makeGame('b-oneshot-fed', 'one-shot');
  await fed.runUntilIdle(); // 2 calls, both waiting
  fed.worldRestock('kitchen', 3); // goal is 70: npc_a needs one eat, npc_c two
  await fed.runUntilIdle(); // both wake and eat: +3 calls, both satisfied
  assert.deepEqual(Object.values(fed.snapshot().actors).map(a => a.state), ['satisfied', 'satisfied']);
  const t1 = adv(fed, NEED_PERIOD_MIN);
  const t2 = adv(fed, NEED_PERIOD_MIN);
  assert.deepEqual([t1.needsScheduled, t2.needsScheduled], [[], []], 'satisfied actors get no need');
  await fed.runUntilIdle();
  assert.equal(callsOfGame(fed), 5);
  game.close();
  fed.close();
});

test('one-shot hunger gate: npc_c below 30 is never scheduled', async () => {
  const game = makeGame('b-oneshot-gate', 'one-shot');
  await game.runUntilIdle();
  adv(game, NEED_PERIOD_MIN); // a: 43 → hungry; c: 23 → below gate
  const snap = game.snapshot();
  assert.deepEqual(snap.needs!.map(n => n.actorId), ['npc_a']);
  assert.equal(snap.needs![0].period, 1);
  await game.runUntilIdle(); // npc_a burns its need decisions; c never runs
  const after = game.snapshot();
  assert.equal(after.actors.npc_c.providerCalls, 1, 'npc_c only ever had its initial cycle');
  game.close();
});

test('recurring: eat reactivation across periods, one grant per actor per period', async () => {
  const game = makeGame('b-recurring', 'recurring');
  await game.runUntilIdle(); // 2 calls, both waiting
  // Period 1 (t=30): npc_a hungry → need; kitchen empty → feed it inside the need.
  const p1 = adv(game, NEED_PERIOD_MIN);
  assert.deepEqual(p1.needsScheduled, ['npc_a']);
  game.worldRestock('kitchen', 1);
  await game.runUntilIdle(); // a eats to 73 → satisfied (need satisfied); c wakes, finds
  // the kitchen emptied and stops again → waiting (its extra call is counted below)
  assert.equal(game.snapshot().actors.npc_a.state, 'satisfied');
  // Periods 2..3: nobody eligible (a satisfied, c below 30 at 26/29)
  const p2 = adv(game, NEED_PERIOD_MIN);
  const p3 = adv(game, NEED_PERIOD_MIN);
  assert.deepEqual([p2.needsScheduled, p3.needsScheduled], [[], []]);
  // Period 4 (t=120): c reaches 32 → need; feed it to the 70 goal (two eats).
  const p4 = adv(game, NEED_PERIOD_MIN);
  assert.deepEqual(p4.needsScheduled, ['npc_c']);
  game.worldRestock('kitchen', 2);
  await game.runUntilIdle();
  const snap = game.snapshot();
  assert.equal(snap.actors.npc_c.state, 'satisfied');
  assert.deepEqual(snap.needs!.map(n => [n.actorId, n.period, n.outcome]), [
    ['npc_a', 1, 'satisfied'],
    ['npc_c', 4, 'satisfied'],
  ]);
  // 2 initial + a's need eat + c's starved wake stop + c's two need eats
  assert.equal(callsOfGame(game), 6);
  // Same-period double boundary does not double-grant: a advance that spans
  // two boundaries grants each period at most once.
  const span = adv(game, 2 * NEED_PERIOD_MIN); // t=180: a 75 c 34
  assert.deepEqual(span.needsScheduled, [], 'satisfied actors get no grant');
  game.close();
});

test('recurring period budget: one grant per actor per period across separate advances', async () => {
  const game = makeGame('b-period-budget', 'recurring');
  await game.runUntilIdle();
  game.worldAdvanceTime(NEED_PERIOD_MIN); // grant a@p1
  game.worldAdvanceTime(NEED_PERIOD_MIN); // boundary 60: a already hungry+p1 granted? new period 2
  const snap = game.snapshot();
  const grants = snap.needs!.filter(n => n.actorId === 'npc_a' && n.period === 1);
  assert.equal(grants.length, 1, 'period 1 granted exactly once even though npc_a stayed pending');
  game.close();
});

test('expired: a need that never eats burns exactly NEED_DECISION_BUDGET decisions and interrupts', async () => {
  const game = makeGame('b-expired', 'one-shot');
  await game.runUntilIdle(); // 2 calls
  const r = adv(game, NEED_PERIOD_MIN);
  assert.deepEqual(r.needsScheduled, ['npc_a']);
  const outcome = await game.runUntilIdle(); // reference policy can never eat
  assert.equal(outcome.kind, 'interrupted');
  assert.equal(game.isInterrupted(), true);
  const snap = game.snapshot();
  assert.equal(snap.stopReason, 'interrupted');
  const need = snap.needs!.find(n => n.actorId === 'npc_a')!;
  assert.equal(need.outcome, 'expired');
  assert.equal(need.decisionsUsed, NEED_DECISION_BUDGET);
  assert.equal(snap.actors.npc_a.providerCalls, 1 + NEED_DECISION_BUDGET);
  // npc_c keeps its initial call only — interruption freezes the episode.
  assert.equal(snap.actors.npc_c.providerCalls, 1);
  // advance after interruption is refused
  const late = game.worldAdvanceTime(10);
  assert.equal(late.ok, false);
  await game.close();
});

test('advance_time is refused while an NPC step is in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const game = createNeedsGame({
    episodeId: 'b-busy',
    initialState: buildNeedsWorld({ kitchenFood: 1 }),
    providerFor: () => ({
      decide: async input => {
        calls += 1;
        if (calls === 1) await gate;
        return input.observation.foodHere > 0 && input.observation.location === 'kitchen' && input.observation.hunger < 50
          ? '{"type":"eat"}' : '{"type":"stop"}';
      },
    }),
    mode: 'fixture',
    needPolicy: 'recurring',
    timeoutMs: 2_000,
  });
  const running = game.runUntilIdle();
  const busyResult = game.worldAdvanceTime(NEED_PERIOD_MIN);
  assert.equal(busyResult.ok, false);
  assert.equal(busyResult.error, 'game is busy');
  release();
  await running;
  await game.close();
});

test('G04 semantics unchanged: needs absent, restock wake still works under g05 schema', async () => {
  const game = makeGame('b-g04-compat', 'never');
  await game.runUntilIdle(); // 2 calls
  game.worldRestock('kitchen', 3); // a eats once to 70, c eats twice to 80
  await game.runUntilIdle(); // +3 wake calls, both satisfied
  const snap = game.snapshot();
  assert.equal(snap.schema, 'frostecho.g05.game/1');
  assert.deepEqual(Object.values(snap.actors).map(a => a.state), ['satisfied', 'satisfied']);
  assert.equal(callsOfGame(game), 5);
  assert.deepEqual(snap.needs, []);
  await game.close();
});
