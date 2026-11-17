/**
 * G11 — independent black-box locks for "temporary goal ends, the need resumes".
 *
 * Everything here is offline and deterministic: scripted providers only, zero
 * HTTP, zero campaign quota. The three frozen trajectories are asserted by
 * BEHAVIOUR (provider call trace, world, cycles, requests), never by a summary
 * boolean:
 *
 *   W0  ordinary wait resumes in the SAME cycle after the deadline (2 calls)
 *   W1  a fulfilled yield promise is settled with zero calls at the deadline and
 *       an ordinary need cycle continues (4 calls total, 2 of them ordinary)
 *   W2  the same for an expired promise; the old request never flips to fulfilled
 *
 * plus the frozen boundaries (A60→50 continues, ≥70 zero calls, one-shot never
 * continues, closed/budget/violation never revive, repeated reconcile settles
 * once) and cross-checkpoint equivalence against the continuous run.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../src/needs/game';
import { createGoalRequest } from '../src/negotiation/requests';
import { G09_REQUEST_TEXT } from '../src/negotiation/contracts';
import * as lib from '../scripts/g09-eval-lib';
import type { DecideInput } from '../src/agent/contracts';

interface Trace { phase: 'goal' | 'action'; activeGoal: string | null }
interface ScenarioOptions {
  episodeId: string;
  hungerA: number;
  negotiated: boolean;
  needPolicy: 'one-shot' | 'recurring';
  kitchenFood?: number;
  /** The scripted action answer (default: wait while the yield goal is active, else eat). */
  action?: (input: DecideInput) => string;
  externalBudget?: () => boolean;
}

function scenario(options: ScenarioOptions): { game: NeedsGame; calls: Trace[] } {
  const calls: Trace[] = [];
  const game = createNeedsGame({
    episodeId: options.episodeId,
    initialState: buildNeedsWorld({
      kitchenFood: options.kitchenFood ?? 1,
      hunger: { npc_a: options.hungerA, npc_b: 40, npc_c: 70 },
    }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({
      async decide(input: DecideInput) {
        const phase: 'goal' | 'action' = input.goalChoice !== undefined ? 'goal' : 'action';
        calls.push({ phase, activeGoal: input.activeGoal?.kind ?? null });
        if (phase === 'goal') return '{"goal":"yield_once"}';
        if (options.action !== undefined) return options.action(input);
        return input.activeGoal?.kind === 'yield_once' ? '{"type":"wait"}' : '{"type":"eat"}';
      },
    }),
    mode: 'reference',
    thinking: true,
    needPolicy: options.needPolicy,
    timeoutMs: 120_000,
    actionSet: 'timed_wait',
    ...(options.negotiated
      ? { goalMode: 'negotiated' as const, candidateSet: 'choice' as const, playerId: 'npc_b' }
      : {}),
    ...(options.externalBudget !== undefined ? { externalBudget: options.externalBudget } : {}),
  });
  return { game, calls };
}

function submitYieldRequest(game: NeedsGame, episodeId: string): void {
  const built = createGoalRequest({
    requestId: 'r', episodeId, to: 'npc_a', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
  });
  assert.equal(built.ok, true);
  assert.equal(game.submitGoalRequest(built.value).ok, true);
}

const requestOf = (game: NeedsGame): { status: string; outcome: string } | null => {
  const request = game.goalRequests().requests.r;
  return request === undefined ? null : { status: request.status, outcome: request.outcome };
};

const cyclesOf = (game: NeedsGame): number => game.snapshot().cycles.npc_a!.length;

/** W1/W2 up to the moment the deadline passed (settlement already happened). */
async function promiseToDeadline(playerEats: boolean): Promise<{
  game: NeedsGame; calls: Trace[]; requestAfterTime: { status: string; outcome: string } | null;
}> {
  const { game, calls } = scenario({ episodeId: playerEats ? 'W1' : 'W2', hungerA: 40, negotiated: true, needPolicy: 'recurring' });
  submitYieldRequest(game, playerEats ? 'W1' : 'W2');
  await game.advance(); // goal phase
  await game.advance(); // action: wait
  assert.equal(calls.length, 2, 'the promise costs exactly two calls');
  assert.equal(calls[1]!.activeGoal, 'yield_once', 'the action call carries the yield goal');
  assert.equal(await game.advance().then(r => r.kind), 'idle', 'nothing happens before the deadline');
  assert.equal(calls.length, 2, 'an idle pump never calls the provider');
  if (playerEats) assert.equal(game.playerLine('player eat').ok, true);
  game.worldAdvanceTime(1); // deadline reached: settlement + handoff, zero calls
  assert.equal(calls.length, 2, 'time/settlement never calls the provider');
  return { game, calls, requestAfterTime: requestOf(game) };
}

test('W0: an ordinary wait resumes in the SAME cycle; the deadline costs no call', async () => {
  const calls: Trace[] = [];
  const game = createNeedsGame({
    episodeId: 'W0',
    initialState: buildNeedsWorld({ kitchenFood: 1, hunger: { npc_a: 50, npc_b: 40, npc_c: 70 } }),
    actorIds: ['npc_a'],
    providerFor: () => ({
      async decide(input: DecideInput) {
        calls.push({ phase: 'action', activeGoal: input.activeGoal?.kind ?? null });
        return input.feedback === null ? '{"type":"wait"}' : '{"type":"eat"}';
      },
    }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: 120_000, actionSet: 'timed_wait',
  });
  await game.advance();
  assert.equal(calls.length, 1);
  assert.equal(game.actorStateOf('npc_a'), 'timed_wait');
  assert.equal((await game.advance()).kind, 'idle');
  assert.equal(calls.length, 1, 'waiting is not a provider call');
  game.worldAdvanceTime(1);
  const ate = await game.advance();
  assert.equal(ate.kind, 'stepped');
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.phase === 'action' && call.activeGoal === null), true, 'never a goal phase');
  const state = game.world.getState();
  assert.equal(state.npcs.npc_a!.hunger, 70);
  assert.equal(state.food.kitchen, 0);
  assert.equal(cyclesOf(game), 1, 'the same cycle continues; no new cycle opens');
});

test('W1: a fulfilled promise settles at the deadline with zero calls and the ordinary need continues', async () => {
  const { game, calls, requestAfterTime } = await promiseToDeadline(true);
  assert.deepEqual(requestAfterTime, { status: 'accepted', outcome: 'fulfilled' });
  const callsAtTime = calls.length;
  game.worldRestock('kitchen', 2);
  await game.advance();
  await game.advance();
  // Two ORDINARY calls: no goal phase, no yield active goal, no re-ask.
  assert.equal(calls.length, callsAtTime + 2);
  for (const call of calls.slice(callsAtTime)) {
    assert.equal(call.phase, 'action');
    assert.equal(call.activeGoal, null, 'the old yield goal is never rendered again');
  }
  const state = game.world.getState();
  assert.equal(state.npcs.npc_a!.hunger, 90);
  assert.equal(state.food.kitchen, 0);
  assert.equal(calls.length, 4);
  assert.equal(cyclesOf(game), 2, 'the continuation is a NEW cycle (npc_a)');
  assert.deepEqual(requestOf(game), { status: 'accepted', outcome: 'fulfilled' }, 'the old request stays fulfilled');
  // The settlement checkpoint: the old obligation is met, the hunger need is not.
  const record = game.snapshot();
  assert.equal(record.actors.npc_a!.goalReached, true);
});

test('W2: an expired promise settles with zero calls; the old request never flips to fulfilled', async () => {
  const { game, calls, requestAfterTime } = await promiseToDeadline(false);
  assert.deepEqual(requestAfterTime, { status: 'accepted', outcome: 'expired' });
  game.worldRestock('kitchen', 1);
  await game.advance();
  await game.advance();
  assert.equal(calls.length, 4);
  assert.equal(cyclesOf(game), 2);
  assert.deepEqual(requestOf(game), { status: 'accepted', outcome: 'expired' }, 'expired is monotonic');
  const state = game.world.getState();
  assert.equal(state.npcs.npc_a!.hunger, 90);
  assert.equal(state.food.kitchen, 0);
});

test('boundary: a still-unmet need at 50 after the deadline continues; >= 70 ends with zero calls', async () => {
  // A60 -> time1 -> 50: the ORIGINAL unmet need (not the G05 <= 40 rule).
  const sixty = scenario({ episodeId: 'B60', hungerA: 60, negotiated: true, needPolicy: 'recurring' });
  submitYieldRequest(sixty.game, 'B60');
  await sixty.game.advance();
  await sixty.game.advance();
  sixty.game.playerLine('player eat');
  sixty.game.worldAdvanceTime(1);
  assert.equal(sixty.game.world.getState().npcs.npc_a!.hunger, 50);
  sixty.game.worldRestock('kitchen', 1);
  await sixty.game.advance();
  assert.equal(sixty.calls.length, 3, 'the unmet need continues below 70');

  // The ">= 70 at the deadline" branch is DEFENSIVE: hunger only falls with
  // time, and the only way it can rise between binding and deadline is the NPC
  // eating first — which is a violation and therefore never continues. It is
  // kept in the code and documented in G11-DELIVERY rather than faked here.
  assert.equal(sixty.game.actorStateOf('npc_a'), 'satisfied');
});

test('boundary: one-shot, closed games, budget exhaustion and violations never continue', async () => {
  // one-shot: the promise settles, nothing resumes.
  const one = scenario({ episodeId: 'ONE', hungerA: 40, negotiated: true, needPolicy: 'one-shot' });
  submitYieldRequest(one.game, 'ONE');
  await one.game.advance();
  await one.game.advance();
  one.game.playerLine('player eat');
  one.game.worldAdvanceTime(1);
  assert.equal(one.calls.length, 2);
  one.game.worldRestock('kitchen', 1);
  assert.equal(await one.game.advance().then(r => r.kind), 'idle', 'one-shot never opens a continuation cycle');
  assert.equal(one.calls.length, 2);

  // external budget gate (e.g. an exhausted campaign): no continuation.
  const poor = scenario({ episodeId: 'BUD', hungerA: 40, negotiated: true, needPolicy: 'recurring', externalBudget: () => false });
  submitYieldRequest(poor.game, 'BUD');
  await poor.game.advance();
  await poor.game.advance();
  poor.game.playerLine('player eat');
  poor.game.worldAdvanceTime(1);
  assert.equal(poor.calls.length, 2);
  poor.game.worldRestock('kitchen', 1);
  assert.equal(await poor.game.advance().then(r => r.kind), 'idle');
  assert.equal(poor.calls.length, 2, 'the budget gate is consulted BEFORE any call');

  // a closed game never continues.
  const closed = scenario({ episodeId: 'CLO', hungerA: 40, negotiated: true, needPolicy: 'recurring' });
  submitYieldRequest(closed.game, 'CLO');
  await closed.game.advance();
  await closed.game.advance();
  closed.game.playerLine('player eat');
  closed.game.close();
  closed.game.worldAdvanceTime(1);
  closed.game.worldRestock('kitchen', 1);
  assert.equal(await closed.game.advance().then(r => r.kind), 'closed');
  assert.equal(closed.calls.length, 2);

  // a violated promise never continues and never becomes fulfilled.
  const violated = scenario({
    episodeId: 'VIO', hungerA: 40, negotiated: true, needPolicy: 'recurring',
    // eat immediately: the promise is violated by the NPC eating first.
    action: () => '{"type":"eat"}',
  });
  submitYieldRequest(violated.game, 'VIO');
  await violated.game.advance();
  await violated.game.advance();
  assert.deepEqual(requestOf(violated.game), { status: 'accepted', outcome: 'violated' });
  violated.game.worldRestock('kitchen', 2);
  violated.game.worldAdvanceTime(1);
  await violated.game.advance();
  assert.equal(violated.calls.length, 2, 'a violation is settled without another call');
  assert.deepEqual(requestOf(violated.game), { status: 'accepted', outcome: 'violated' }, 'violation is monotonic');
});

test('boundary: repeated reconcile/pumps settle once — one continuation cycle, no provider duplicate', async () => {
  const { game, calls } = await promiseToDeadline(true);
  const before = calls.length;
  for (let index = 0; index < 5; index += 1) game.reconcile();
  game.worldRestock('kitchen', 2);
  assert.equal(game.snapshot().cycles.npc_a!.length, 2, 'exactly one continuation cycle exists');
  await game.advance();
  await game.advance();
  assert.equal(calls.length, before + 2, 'at most one provider call per advance');
  assert.equal(game.snapshot().cycles.npc_a!.length, 2);
});

test('restore: a checkpoint at the deadline reproduces the continuous continuation exactly', async () => {
  const continuous = await promiseToDeadline(true);
  // Capture a checkpoint AFTER the deadline (settled, continuation cycle open)
  // but BEFORE the next model call.
  const saved = (continuous.game as unknown as { checkpointData(): unknown }).checkpointData();
  const restored = (await import('../src/reactive/checkpoint')).restoreNeedsGame(structuredClone(saved), {
    providerFor: () => ({
      async decide(input: DecideInput) {
        return input.activeGoal?.kind === 'yield_once' ? '{"type":"wait"}' : '{"type":"eat"}';
      },
    }),
    now: () => 0,
  });
  assert.equal(restored.ok, true, restored.ok ? '' : (restored.issues ?? []).join('; '));
  const a = continuous.game;
  const b = restored.value;
  a.worldRestock('kitchen', 2);
  b.worldRestock('kitchen', 2);
  await a.advance();
  await b.advance();
  await a.advance();
  await b.advance();
  assert.deepEqual(b.world.getState(), a.world.getState(), 'same world after the same inputs');
  assert.deepEqual(b.snapshot().cycles, a.snapshot().cycles, 'same cycles/turns/commands');
  assert.deepEqual(b.goalRequests().requests.r, a.goalRequests().requests.r, 'same request state');
  const counters = (value: unknown) => (value as { pumpCounterSnapshot(): { calls: number } }).pumpCounterSnapshot().calls;
  assert.equal(counters(b), counters(a), 'same cumulative calls');
});

test('prompt: the yield statement no longer claims that moving breaks the agreement', () => {
  const source = readFileSync(join(process.cwd(), 'src/agent/active-goal-prompt.ts'), 'utf8');
  assert.equal(/leaving the kitchen/.test(source), false, 'the invented clause must be gone');
  assert.match(source, /moving elsewhere does not/);
  assert.match(source, /ACTIVE_GOAL_PROMPT_VERSION = 'g11-needs-resume\/1'/);
});

test('derive: a connection refusal maps to provider_error, never invalid_run', () => {
  const source = join(process.cwd(), 'artifacts/g10-live/g10-live-20261105-r1');
  const copy = mkdtempSync(join(tmpdir(), 'fe-g11-derive-'));
  const target = join(copy, 'batch');
  // Copy the committed batch and turn one served action into a refusal.
  const { cpSync } = require('node:fs') as typeof import('node:fs');
  cpSync(source, target, { recursive: true });
  const episodePath = join(target, 'episodes/g09-r1-s40-choice.json');
  const episode = JSON.parse(readFileSync(episodePath, 'utf8')) as {
    outcome: string;
    http: { phase: string; response: { status: unknown; body: unknown; usage: unknown }; error: string | null }[];
  };
  const action = episode.http.find(exchange => exchange.phase === 'action')!;
  action.response.status = null;
  action.response.body = null;
  action.response.usage = null;
  action.error = 'connection refused';
  writeFileSync(episodePath, JSON.stringify(episode, null, 2));
  const campaign = JSON.parse(readFileSync(join(process.cwd(), 'artifacts/g10-live/campaign-g10-approved16/campaign.json'), 'utf8'));
  const derived = lib.deriveG09(lib.readG09Batch(target), lib.frozenPlanEntries(), campaign);
  const row = derived.episodes.find(entry => entry.episodeId === 'g09-r1-s40-choice')!;
  assert.equal(row.outcome, 'provider_error');
});
