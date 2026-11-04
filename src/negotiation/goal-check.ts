/**
 * G09-R1 worker A — authoritative fulfilment from the engine stream.
 *
 * The evidence is bounded by the acceptance sequence: commands at or before
 * it can never fulfil (or breach) the promise, and the outcome is folded in
 * ORDER with each command's own authoritative simTime. An NPC eat first is
 * violated immediately; a later player eat cannot repair it.
 */
import {
  fulfilmentVerdict, strictGoalChoice,
  type FulfillmentEvidence, type GoalBinding, type GoalFulfillment,
  type GoalRequestSnapshot,
} from './contracts';
import { processAcceptedCommand, expireRequestIfDue, type AuthoritativeCommand } from './requests';

export const G09_NPC_ACTOR = 'npc_a';
export const G09_PLAYER_ACTOR = 'npc_b';

export interface GoalCheckCommand extends AuthoritativeCommand {
  /** The authoritative simTime right after this command was submitted. */
  atSimTime?: number;
}

export interface GoalCheckSnapshot {
  commands: readonly GoalCheckCommand[];
  /** The engine's simTime after the whole ledger (never used to rewrite history). */
  finalSimTime?: number;
}

function accepted(command: GoalCheckCommand): boolean {
  return command.result?.status === 'accepted';
}

/**
 * Evidence for a yield promise, bounded by the acceptance seq:
 *   npcAteBeforePlayer — an ACCEPTED npc eat AFTER acceptance and before the
 *                        player's attempt resolved
 *   playerAte          — the player's ACCEPTED eat after acceptance
 */
export function deriveFulfilmentEvidence(
  binding: Pick<GoalBinding, 'goal' | 'acceptedAfterSeq'>,
  snapshot: GoalCheckSnapshot,
  npcActorId: string = G09_NPC_ACTOR,
  playerActorId: string = G09_PLAYER_ACTOR,
): FulfillmentEvidence {
  const after = (Array.isArray(snapshot.commands) ? snapshot.commands : [])
    .filter(command => Number.isSafeInteger(command?.seq) && command.seq > binding.acceptedAfterSeq)
    .sort((a, b) => a.seq - b.seq);
  const npcEats = after.filter(c => c.command.actorId === npcActorId && c.command.type === 'eat' && accepted(c));
  const playerEats = after.filter(c => c.command.actorId === playerActorId && c.command.type === 'eat');
  const playerAte = playerEats.some(accepted);
  const playerSeq = playerEats.length > 0 ? Math.min(...playerEats.map(c => c.seq)) : null;
  const npcAteBeforePlayer = npcEats.some(c => playerSeq === null || c.seq < playerSeq);
  return { goal: binding.goal, npcAteBeforePlayer, playerAte };
}

export function checkGoalFulfilment(
  binding: Pick<GoalBinding, 'goal' | 'acceptedAfterSeq'>,
  snapshot: GoalCheckSnapshot,
  npcActorId: string = G09_NPC_ACTOR,
  playerActorId: string = G09_PLAYER_ACTOR,
): GoalFulfillment {
  const evidence = deriveFulfilmentEvidence(binding, snapshot, npcActorId, playerActorId);
  return { verdict: fulfilmentVerdict(evidence), evidence };
}

/**
 * Replay the authoritative command ledger into the accepted request, in
 * order, using each command's own simTime, then apply the deadline. This is
 * the single derivation the verifier and the runner must agree on.
 */
export function replayRequestOutcome(
  request: GoalRequestSnapshot,
  binding: Pick<GoalBinding, 'acceptedAfterSeq' | 'expiresAtSimTime'> | null,
  snapshot: GoalCheckSnapshot,
): GoalRequestSnapshot {
  let current = request;
  const commands = (Array.isArray(snapshot.commands) ? snapshot.commands : [])
    .filter(command => Number.isSafeInteger(command?.seq))
    .sort((a, b) => a.seq - b.seq);
  for (const command of commands) {
    const simTime = typeof command.atSimTime === 'number' ? command.atSimTime : request.createdAtSimTime;
    current = processAcceptedCommand(current, binding, command, simTime);
  }
  const finalSimTime = snapshot.finalSimTime ?? request.createdAtSimTime;
  return expireRequestIfDue(current, finalSimTime);
}

/**
 * Cross-check a recorded binding against its request: acceptance status,
 * original expiry carried verbatim, the seq boundary, and that the raw text
 * still parses to the same goal.
 */
export function bindingIssues(binding: GoalBinding, request: GoalRequestSnapshot): string[] {
  const issues: string[] = [];
  if (binding.requestId !== request.requestId) {
    issues.push(`the binding answers request ${JSON.stringify(binding.requestId)} but the episode holds ${JSON.stringify(request.requestId)}`);
    return issues;
  }
  if (request.status !== 'accepted') issues.push(`the request is ${request.status}, an active binding requires accepted`);
  if (request.decision === null) issues.push('an accepted request holds no decision');
  else {
    if (request.decision.goal !== binding.goal) issues.push(`the decision ${request.decision.goal} contradicts the binding ${binding.goal}`);
    if (request.decision.round !== binding.decidedRound) issues.push('the decision round contradicts the binding round');
    if (request.decision.decidedAtSimTime !== binding.decidedAtSimTime) issues.push('the decision simTime contradicts the binding simTime');
  }
  const parse = strictGoalChoice(binding.raw, request.options);
  if (!parse.ok) issues.push(`the binding raw does not parse: ${parse.error}`);
  else if (parse.goal !== binding.goal) issues.push('the binding raw parses to a different goal');
  if (binding.expiresAtSimTime !== request.expiresAtSimTime) issues.push('the binding must carry the request expiry verbatim');
  if (binding.acceptedAfterSeq !== request.acceptedAfterSeq) issues.push('the binding must carry the request acceptance seq');
  if (binding.decidedAtSimTime >= binding.expiresAtSimTime) issues.push('a binding can never be produced at or after the expiry');
  return issues;
}
