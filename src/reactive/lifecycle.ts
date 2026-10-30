/**
 * G04 lifecycle predicates — pure, no I/O, no timers.
 *
 * The only automatic continuation in G04 is "re-check a condition": an actor
 * that stopped because *its own* observation showed an empty kitchen and it was
 * still hungry becomes `waiting`; it becomes active again when its own current
 * observation shows food at that same location. Nothing else wakes an actor,
 * and no notification by itself causes a provider call.
 */
import { GOAL_HUNGER_AT_LEAST, type Observation, type SessionStatus } from '../agent/contracts';
import { RULES } from '../types';

export const GOAL = GOAL_HUNGER_AT_LEAST;

const TERMINAL: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['goal_reached', 'stopped', 'budget_exhausted', 'timeout', 'provider_error']);

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The stop reasons that may turn into `waiting`: kitchen observed empty while
 * still hungry. A stop for any other reason (already full, dorm, parse error on
 * a non-empty kitchen) is final.
 */
export function isWaitingObservation(observation: Observation): boolean {
  return observation.location === 'kitchen' && observation.foodHere <= 0 && observation.hunger < GOAL;
}

/** Wake predicate: this actor's own current observation offers edible food. */
export function canWake(observation: Observation): boolean {
  return observation.location === 'kitchen' && observation.foodHere >= RULES.EAT_FOOD_COST && observation.hunger < GOAL;
}

export function describeObservation(observation: Observation): string {
  return `${observation.location} hunger=${observation.hunger} foodHere=${observation.foodHere}`;
}
