/**
 * G10 action-contract: the ACTION phase's structured active goal.
 *
 * The goal phase decides; the action phase must render THAT decision as its
 * only current goal. The statement is derived from the structured decision
 * (goal kind + request contract), never from the goal-phase prompt text, so
 * the two phases can never disagree about what the session is doing.
 *
 * The statement is data about what THIS session declared. It adds no rule,
 * no authority, no distant state, and it never filters a legal action.
 */
import type { ActiveGoal } from './contracts';

/** Bumped when the rendered statement changes; the plan records it. */
export const ACTIVE_GOAL_PROMPT_VERSION = 'g11-needs-resume/1';

export function activeGoalStatement(goal: ActiveGoal): string[] {
  if (goal.kind === 'feed_self') {
    return [
      `activeGoal: ${JSON.stringify(goal)}`,
      `Your ONLY current goal is your own satiety: reach hunger >= ${goal.hungerAtLeast}. The player's request was declined in the goal phase, so no agreement restricts this session.`,
    ];
  }
  return [
    `activeGoal: ${JSON.stringify(goal)}`,
    'Your ONLY current goal is this agreement with the player: keep the food available to the player until the request expires, and the agreement is fulfilled only if the player actually eats before the deadline (logical time expiresAtSimTime).',
    // G11: the authoritative contract has exactly ONE violation — the NPC
    // eating before the player does. Moving is legal and never a violation;
    // the old sentence claimed a rule the engine does not have.
    "Your own hunger is background state, not this session's goal. Eating the food yourself before the player eats breaks the agreement; moving elsewhere does not.",
  ];
}
