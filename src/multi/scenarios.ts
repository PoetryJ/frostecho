/**
 * G03 workstream C — the three fixed M-scenarios from CONTRACTS.txt §5.
 * Initial states, reference step counts (4/4/3), the single scripted player
 * intervention for M3, and authoritative per-scenario verdicts.
 * Initial hunger: npc_a/npc_c = 40, npc_b (player) = 20 (CONTRACTS §1).
 * Per-actor decision budget: MAX_PROVIDER_CALLS = 5 (reused, not redefined).
 */
import { GOAL_HUNGER_AT_LEAST } from '../agent/contracts';
import type { WorldState } from '../types';
import type { MultiRecord } from './contracts';

export type MultiScenarioId = 'm1' | 'm2' | 'm3';
export const MULTI_SCENARIO_IDS: readonly MultiScenarioId[] = ['m1', 'm2', 'm3'];

/** M3 only: one player eat injected while the first actor is deciding. */
export interface PlayerIntervention {
  trigger: 'first-decision';
  line: 'player eat';
}

export interface MultiScenario {
  id: MultiScenarioId;
  description: string;
  initialState: WorldState;
  /** Total reference-policy NPC decisions for this scenario (either order). */
  expectedReferenceSteps: number;
  playerIntervention: PlayerIntervention | null;
}

const npc = (id: string, location: 'dorm' | 'kitchen', hunger: number) => ({ id, location, hunger });

export function loadMultiScenario(id: MultiScenarioId): MultiScenario {
  switch (id) {
    case 'm1':
      // Enough food: both NPCs walk to the kitchen and both eat (40 -> 70).
      // Reference: a move, c move, a eat, c eat = 4 decisions; b stays 20, food 0.
      return {
        id: 'm1',
        description: 'enough food: both autonomous NPCs reach 70; player stays at 20',
        initialState: {
          npcs: { npc_a: npc('npc_a', 'dorm', 40), npc_b: npc('npc_b', 'dorm', 20), npc_c: npc('npc_c', 'dorm', 40) },
          food: { kitchen: 2, dorm: 0 },
          tick: 0,
        },
        expectedReferenceSteps: 4,
        playerIntervention: null,
      };
    case 'm2':
      // Last portion: kitchen food = 1. Whoever is scheduled first eats (70),
      // the other observes an empty kitchen and stops at 40. Reversing the
      // actor order reverses the winner — recorded, not judged as unfairness.
      return {
        id: 'm2',
        description: 'last portion: the first-scheduled NPC reaches 70, the other stops at 40; order reversal flips the winner',
        initialState: {
          npcs: { npc_a: npc('npc_a', 'dorm', 40), npc_b: npc('npc_b', 'dorm', 20), npc_c: npc('npc_c', 'dorm', 40) },
          food: { kitchen: 1, dorm: 0 },
          tick: 0,
        },
        expectedReferenceSteps: 4,
        playerIntervention: null,
      };
    case 'm3':
      // Player steals the food: everyone starts in the kitchen with food 1.
      // While the first actor is deciding, the player eats (b 20 -> 50, food 0).
      // The first actor's eat hits NO_FOOD on revalidation; it stops next turn
      // seeing 0 food + NO_FOOD feedback; the other actor observes 0 and stops.
      // Reference: eat(NO_FOOD), stop, stop = 3 decisions; a/c stay 40, b 50.
      return {
        id: 'm3',
        description: 'player steals the only food: both NPCs stop at 40 with NO_FOOD recorded as expected contention',
        initialState: {
          npcs: { npc_a: npc('npc_a', 'kitchen', 40), npc_b: npc('npc_b', 'kitchen', 20), npc_c: npc('npc_c', 'kitchen', 40) },
          food: { kitchen: 1, dorm: 0 },
          tick: 0,
        },
        expectedReferenceSteps: 3,
        playerIntervention: { trigger: 'first-decision', line: 'player eat' },
      };
  }
}

export function isMultiScenarioId(value: string): value is MultiScenarioId {
  return (MULTI_SCENARIO_IDS as readonly string[]).includes(value);
}

export interface MultiScenarioVerdict {
  pass: boolean;
  reasons: string[];
}

/**
 * Deterministic verdicts from the authoritative record — never model claims.
 * - m1: both autonomous NPCs hunger >= 70; player 20; kitchen food 0.
 * - m2: exactly one NPC reaches the goal and it must be the first-scheduled
 *       actor (actorOrder[0]); the other stops at 40; player 20; food 0.
 * - m3: neither NPC reaches the goal (both stop at 40); player 50; food 0;
 *       at least one NPC eat was rejected with NO_FOOD (recorded contention).
 * All scenarios additionally require replayMatches.
 */
export function judgeMultiScenario(id: MultiScenarioId, record: MultiRecord): MultiScenarioVerdict {
  const reasons: string[] = [];
  const state = record.finalState;
  const a = record.actors.npc_a;
  const c = record.actors.npc_c;
  if (!a || !c || !state?.npcs?.npc_a || !state?.npcs?.npc_c || !state?.npcs?.npc_b) {
    return { pass: false, reasons: ['missing actor summary or final state'] };
  }
  const hungerA = state.npcs.npc_a.hunger;
  const hungerC = state.npcs.npc_c.hunger;
  const hungerB = state.npcs.npc_b.hunger;
  const kitchen = state.food?.kitchen;
  switch (id) {
    case 'm1':
      if (hungerA < GOAL_HUNGER_AT_LEAST) reasons.push(`npc_a hunger ${hungerA} < ${GOAL_HUNGER_AT_LEAST}`);
      if (hungerC < GOAL_HUNGER_AT_LEAST) reasons.push(`npc_c hunger ${hungerC} < ${GOAL_HUNGER_AT_LEAST}`);
      if (hungerB !== 20) reasons.push(`npc_b hunger ${hungerB} != 20 (player should not eat)`);
      if (kitchen !== 0) reasons.push(`kitchen food ${kitchen} != 0`);
      break;
    case 'm2': {
      const first = record.actorOrder[0];
      const second = record.actorOrder[1];
      const firstSummary = record.actors[first];
      const secondSummary = record.actors[second];
      if (!firstSummary || !secondSummary) return { pass: false, reasons: ['missing actor summary'] };
      if (!firstSummary.goalReached) reasons.push(`${first} is scheduled first but did not reach the goal`);
      if (secondSummary.goalReached) reasons.push(`${second} reached the goal but only the first-scheduled NPC may`);
      if (!firstSummary.goalReached || secondSummary.goalReached) break;
      const secondHunger = record.actorOrder[1] === 'npc_a' ? hungerA : hungerC;
      if (secondHunger !== 40) reasons.push(`${second} hunger ${secondHunger} != 40 (should stop unfed)`);
      if (hungerB !== 20) reasons.push(`npc_b hunger ${hungerB} != 20`);
      if (kitchen !== 0) reasons.push(`kitchen food ${kitchen} != 0`);
      break;
    }
    case 'm3':
      if (a.goalReached || c.goalReached) reasons.push('no autonomous NPC may reach the goal');
      if (hungerA !== 40 || hungerC !== 40) reasons.push(`npc hungers ${hungerA}/${hungerC} != 40/40`);
      if (hungerB !== 50) reasons.push(`npc_b hunger ${hungerB} != 50 (player should have eaten exactly once)`);
      if (kitchen !== 0) reasons.push(`kitchen food ${kitchen} != 0`);
      if (!record.commands.some(e => e.command.actorId !== 'npc_b' && e.command.type === 'eat' && e.result.status !== 'accepted')) {
        reasons.push('no rejected NPC eat found: expected a NO_FOOD contention record');
      }
      break;
  }
  if (!record.replayMatches) reasons.push('replay does not reproduce the final state');
  return { pass: reasons.length === 0, reasons };
}

export { GOAL_HUNGER_AT_LEAST };
