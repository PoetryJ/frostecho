/**
 * G04 workstream C — the three paired scenarios (CONTRACTS §4).
 *
 * Initial state is identical for every episode: A and C in the kitchen with
 * hunger 40, B in the kitchen with hunger 20, both locations empty.
 * Each scenario/order/policy episode is driven through the same public
 * interface an operator would use (runUntilIdle, worldRestock, notify).
 */
import { GOAL_HUNGER_AT_LEAST } from '../agent/contracts';
import type { WorldState } from '../types';
import {
  G04_THINKING, SCENARIO_IDS, SCENARIO_TITLES, WAKE_POLICIES,
  type ReactiveGame, type ReactiveRecord, type ScenarioId, type WakePolicy,
} from './contracts';

export const ACTOR_ORDERS = [['npc_a', 'npc_c'], ['npc_c', 'npc_a']] as const;
export type ActorOrder = (typeof ACTOR_ORDERS)[number];
export const ORDER_CODES = ['ac', 'ca'] as const;
export type OrderCode = (typeof ORDER_CODES)[number];

export const N2_PUMPS = 100;

export function initialState(): WorldState {
  return {
    npcs: {
      npc_a: { id: 'npc_a', location: 'kitchen', hunger: 40 },
      npc_b: { id: 'npc_b', location: 'kitchen', hunger: 20 },
      npc_c: { id: 'npc_c', location: 'kitchen', hunger: 40 },
    },
    food: { kitchen: 0, dorm: 0 },
    tick: 0,
  };
}

export function actorIdsFor(code: OrderCode): readonly string[] {
  return code === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
}

export function scenarioIdFor(id: ScenarioId, order: OrderCode, policy: WakePolicy): string {
  return `${id}-${order}-${policy}`;
}

/** Expected reference-path call counts (CONTRACTS §4): 15 per order, 30 total. */
export const EXPECTED_CALLS: Record<ScenarioId, Record<WakePolicy, number>> = {
  n1: { legacy: 2, event: 4 },
  n2: { legacy: 2, event: 2 },
  n3: { legacy: 2, event: 3 },
};

export interface ScenarioJudgement {
  pass: boolean;
  detail: string;
}

export interface ReactiveScenario {
  id: ScenarioId;
  title: string;
  /** N3 only: restock while the first empty-kitchen stop is in flight. */
  restockDuringFirstDecision: boolean;
  drive(game: ReactiveGame): Promise<void>;
  judge(record: ReactiveRecord): ScenarioJudgement;
}

function hunger(state: WorldState, actorId: string): number {
  return state.npcs[actorId]?.hunger ?? -1;
}

function calls(record: ReactiveRecord): number {
  return Object.values(record.actors).reduce((sum, actor) => sum + actor.providerCalls, 0);
}

function judgeN1(record: ReactiveRecord): ScenarioJudgement {
  const policy = record.wakePolicy;
  const expected = EXPECTED_CALLS.n1[policy];
  const got = calls(record);
  const a = hunger(record.finalState, 'npc_a');
  const c = hunger(record.finalState, 'npc_c');
  const kitchen = record.finalState.food.kitchen;
  if (got !== expected) return { pass: false, detail: `reference call count ${got} != ${expected}` };
  if (policy === 'legacy') {
    if (a !== 40 || c !== 40) return { pass: false, detail: `legacy hungers must stay at 40 (got ${a}/${c})` };
    if (kitchen !== 2) return { pass: false, detail: `legacy kitchen must stay at 2 (got ${kitchen})` };
    return { pass: true, detail: 'legacy: both stay stopped at 40, kitchen keeps 2' };
  }
  if (a < GOAL_HUNGER_AT_LEAST || c < GOAL_HUNGER_AT_LEAST) return { pass: false, detail: `event hungers must reach 70 (got ${a}/${c})` };
  if (kitchen !== 0) return { pass: false, detail: `event kitchen must end at 0 (got ${kitchen})` };
  return { pass: true, detail: 'event: both wake, eat and reach 70, kitchen drains to 0' };
}

function judgeN2(record: ReactiveRecord): ScenarioJudgement {
  const policy = record.wakePolicy;
  const expected = EXPECTED_CALLS.n2[policy];
  const got = calls(record);
  const a = hunger(record.finalState, 'npc_a');
  const c = hunger(record.finalState, 'npc_c');
  const food = record.finalState.food;
  if (got !== expected) return { pass: false, detail: `reference call count ${got} != ${expected}` };
  if (a !== 40 || c !== 40) return { pass: false, detail: `hungers must stay at 40 (got ${a}/${c})` };
  if (food.kitchen !== 0 || food.dorm !== 2) return { pass: false, detail: `food must stay kitchen=0 dorm=2 (got ${food.kitchen}/${food.dorm})` };
  if (record.idlePumps.pumps !== N2_PUMPS) return { pass: false, detail: `expected ${N2_PUMPS} recorded pumps, got ${record.idlePumps.pumps}` };
  if (record.idlePumps.callsAfter !== record.idlePumps.callsBefore) return { pass: false, detail: 'notification pumps must not add provider calls' };
  if (record.idlePumps.cyclesAfter !== record.idlePumps.cyclesBefore) return { pass: false, detail: 'notification pumps must not open cycles' };
  if (policy === 'event') {
    if (record.actors.npc_a.state !== 'waiting' || record.actors.npc_c.state !== 'waiting') {
      return { pass: false, detail: `event actors must both wait (got ${record.actors.npc_a.state}/${record.actors.npc_c.state})` };
    }
    return { pass: true, detail: 'event: both wait, dorm food is invisible, 100 pumps add nothing' };
  }
  if (record.actors.npc_a.state !== 'stopped' || record.actors.npc_c.state !== 'stopped') {
    return { pass: false, detail: `legacy actors must keep the G03 terminal state (got ${record.actors.npc_a.state}/${record.actors.npc_c.state})` };
  }
  return { pass: true, detail: 'legacy: both keep stopped, dorm food is invisible' };
}

function judgeN3(record: ReactiveRecord): ScenarioJudgement {
  const policy = record.wakePolicy;
  const expected = EXPECTED_CALLS.n3[policy];
  const got = calls(record);
  const a = hunger(record.finalState, 'npc_a');
  const c = hunger(record.finalState, 'npc_c');
  const kitchen = record.finalState.food.kitchen;
  const first = record.actorOrder[0];
  const second = record.actorOrder[1];
  const firstHunger = hunger(record.finalState, first);
  const secondHunger = hunger(record.finalState, second);
  if (got !== expected) return { pass: false, detail: `reference call count ${got} != ${expected}` };
  if (policy === 'legacy') {
    if (firstHunger !== 40) return { pass: false, detail: `legacy first actor must stay at 40 (got ${firstHunger})` };
    if (secondHunger < GOAL_HUNGER_AT_LEAST) return { pass: false, detail: `legacy second actor must reach 70 (got ${secondHunger})` };
    if (kitchen !== 1) return { pass: false, detail: `legacy kitchen must keep 1 (got ${kitchen})` };
    return { pass: true, detail: 'legacy: the in-flight stop is not recovered, the second actor eats' };
  }
  if (a < GOAL_HUNGER_AT_LEAST || c < GOAL_HUNGER_AT_LEAST) return { pass: false, detail: `event hungers must reach 70 (got ${a}/${c})` };
  if (kitchen !== 0) return { pass: false, detail: `event kitchen must end at 0 (got ${kitchen})` };
  return { pass: true, detail: 'event: the interrupted stop wakes and both reach 70' };
}

function withJudgement(id: ScenarioId, base: Omit<ReactiveScenario, 'id' | 'title' | 'judge'>, judge: (record: ReactiveRecord) => ScenarioJudgement): ReactiveScenario {
  return { id, title: SCENARIO_TITLES[id], judge, ...base };
}

export const SCENARIOS: Record<ScenarioId, ReactiveScenario> = {
  n1: withJudgement('n1', {
    restockDuringFirstDecision: false,
    async drive(game) {
      await game.runUntilIdle();
      game.worldRestock('kitchen', 2);
      await game.runUntilIdle();
    },
  }, judgeN1),
  n2: withJudgement('n2', {
    restockDuringFirstDecision: false,
    async drive(game) {
      await game.runUntilIdle();
      // Count exactly what the 100 notifications do, then pump.
      const before = (game as unknown as { pumpCounterSnapshot(): { calls: number; cycles: number; states: Record<string, never> } }).pumpCounterSnapshot();
      game.worldRestock('dorm', 2);
      for (let i = 0; i < N2_PUMPS; i++) await game.runUntilIdle();
      (game as unknown as { setPumpCounters(p: number, b: unknown): void }).setPumpCounters(N2_PUMPS, before);
    },
  }, judgeN2),
  n3: withJudgement('n3', {
    restockDuringFirstDecision: true,
    async drive(game) {
      await game.runUntilIdle();
    },
  }, judgeN3),
};

export function loadScenario(id: ScenarioId): ReactiveScenario {
  return SCENARIOS[id];
}

export const ALL_SCENARIO_IDS = SCENARIO_IDS;
export const ALL_POLICIES = WAKE_POLICIES;
export const THINKING = G04_THINKING;
