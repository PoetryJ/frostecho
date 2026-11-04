/**
 * G09 worker A — authoritative fulfilment from the engine stream.
 *
 * The verdict NEVER reads a recorded flag: it re-derives what actually
 * happened from the command ledger (the same stream a fresh Engine
 * re-executes) and applies the frozen rule from the contracts. Acceptance is
 * not fulfilment — only the player's real eat result兑现 a yield_once.
 */
import {
  fulfilmentVerdict, strictGoalChoice,
  type FulfillmentEvidence, type GoalBinding, type GoalFulfillment, type GoalRequestSnapshot,
} from './contracts';

export const G09_NPC_ACTOR = 'npc_a';
export const G09_PLAYER_ACTOR = 'player';

export interface GoalCheckCommand {
  seq: number;
  command: { commandId: string; actorId: string; type: string; payload?: unknown };
  result?: { status?: string; reason?: string } | null;
}

export interface GoalCheckSnapshot {
  commands: readonly GoalCheckCommand[];
}

function accepted(command: GoalCheckCommand): boolean {
  return command.result?.status === 'accepted';
}

/**
 * Derive the fulfilment evidence from the command ledger:
 *   npcAteBeforePlayer — an ACCEPTED npc eat that ran before the player's
 *                        attempt resolved (or with no player attempt at all)
 *   playerAte          — the player's single eat attempt was ACCEPTED
 */
export function deriveFulfilmentEvidence(
  binding: Pick<GoalBinding, 'goal'>,
  snapshot: GoalCheckSnapshot,
  npcActorId: string = G09_NPC_ACTOR,
  playerActorId: string = G09_PLAYER_ACTOR,
): FulfillmentEvidence {
  const commands = Array.isArray(snapshot.commands) ? snapshot.commands : [];
  const npcEats = commands.filter(c => c?.command?.actorId === npcActorId && c.command.type === 'eat' && accepted(c));
  const playerEats = commands.filter(c => c?.command?.actorId === playerActorId && c.command.type === 'eat');
  const playerAte = playerEats.some(accepted);
  const playerSeq = playerEats.length > 0 ? Math.min(...playerEats.map(c => c.seq)) : null;
  const npcAteBeforePlayer = npcEats.some(c => playerSeq === null || c.seq < playerSeq);
  return { goal: binding.goal, npcAteBeforePlayer, playerAte };
}

/** Evidence + the frozen verdict rule in one step. */
export function checkGoalFulfilment(
  binding: Pick<GoalBinding, 'goal'>,
  snapshot: GoalCheckSnapshot,
  npcActorId: string = G09_NPC_ACTOR,
  playerActorId: string = G09_PLAYER_ACTOR,
): GoalFulfillment {
  const evidence = deriveFulfilmentEvidence(binding, snapshot, npcActorId, playerActorId);
  return { verdict: fulfilmentVerdict(evidence), evidence };
}

/**
 * Cross-check a recorded binding against its request. The status must match
 * the goal (yield_once ⇔ accepted, feed_self ⇔ rejected), the decision must
 * have met the deadline, and the raw text must still parse to the same goal.
 */
export function bindingIssues(binding: GoalBinding, request: GoalRequestSnapshot | null): string[] {
  const issues: string[] = [];
  if (request === null) {
    if (binding.requestId !== null) issues.push('the binding names a request but the episode holds none');
    if (binding.goal !== 'feed_self') issues.push('a self_only binding may only declare feed_self');
    return issues;
  }
  if (binding.requestId !== request.requestId) {
    issues.push(`the binding answers request ${JSON.stringify(binding.requestId)} but the episode holds ${JSON.stringify(request.requestId)}`);
    return issues;
  }
  if (request.status === 'pending') issues.push('the request is still pending although a binding exists');
  if (request.decision === null) {
    issues.push('the decided request holds no decision');
  } else {
    if (request.decision.goal !== binding.goal) issues.push(`the request decision ${request.decision.goal} contradicts the binding ${binding.goal}`);
    if (request.decision.round !== binding.decidedRound) issues.push('the request decision round contradicts the binding round');
    const parse = strictGoalChoice(binding.raw, request.options);
    if (!parse.ok) issues.push(`the binding raw does not parse: ${parse.error}`);
    else if (parse.goal !== binding.goal) issues.push('the binding raw parses to a different goal');
    if (binding.decidedRound > request.deadlineAfterRound) issues.push('the decision missed the deadline round');
  }
  if (request.status === 'expired' && binding.goal !== undefined) {
    // An expired request still records the late answer; the binding stands
    // only as evidence, never as an acceptance.
    if (request.decision?.goal === 'yield_once') issues.push('a late yield answer can never count as accepted');
  }
  if (request.status === 'accepted' && request.decision?.goal !== 'yield_once') {
    issues.push('an accepted request must have decided yield_once');
  }
  if (request.status === 'rejected' && request.decision?.goal !== 'feed_self') {
    issues.push('a rejected request must have decided feed_self');
  }
  return issues;
}
