/**
 * R4 (G4): the reference negotiation policy. Deterministic rules over visible
 * state — NOT model understanding, and never a claim about what the NPC
 * "really" wants. Each rule is a candidate input, kept separate from the
 * authoritative command path.
 *
 * Contract mapping:
 *  - requests never auto-activate; the policy only answers them;
 *  - survival outranks a promise, but the promisor must SAY so (propose a
 *    change) and wait for an explicit acceptance — proposal ≠ agreement;
 *  - a rejected change keeps the ORIGINAL terms; the promisor may keep going,
 *    or withdraw explicitly (with relation consequences), never silently.
 */
import type { NpcState } from '../survival/world-v2';
import type { Commitment, CommitmentChange, CommitmentTerms } from './commitments';

export type NegotiationVerdict = 'accept' | 'decline' | 'counter';

export interface NegotiationAnswer {
  verdict: NegotiationVerdict;
  reason: string;
  terms?: CommitmentTerms;
}

/** Thresholds are part of the frozen reference policy (documented, testable). */
export const NEGOTIATION = {
  /** Below this hunger the promisor cannot honestly accept new work. */
  acceptHungerFloor: 20,
  /** Below this stamina the promisor asks to rest first. */
  acceptStaminaFloor: 10,
  /** At/below this hunger an active promise must be renegotiated. */
  survivalHunger: 25,
  /** A suspended promise resumes once hunger is back above this. */
  resumeHunger: 45,
  /** A rejected proposal plus this hunger makes an explicit exit honest. */
  withdrawHunger: 8,
} as const;

/** The promisor's answer to a fresh request (visible state only). */
export function initialResponse(npc: NpcState,
  _existing: Commitment[] = []): NegotiationAnswer {
  if (!npc.alive) return { verdict: 'decline', reason: 'dead' };
  if (npc.hunger < NEGOTIATION.acceptHungerFloor) {
    return { verdict: 'counter', reason: 'need-food-first',
      terms: { resumeWhen: `hunger>=${NEGOTIATION.acceptHungerFloor + 20}`,
        reason: '先让我吃一口再答应' } };
  }
  if (npc.stamina < NEGOTIATION.acceptStaminaFloor) {
    return { verdict: 'counter', reason: 'need-rest',
      terms: { resumeWhen: 'stamina>=30', reason: '体力不足，先休息' } };
  }
  return { verdict: 'accept', reason: 'available' };
}

/** A survival-driven change proposal; null while the promise is tenable. */
export function survivalProposal(npc: NpcState, commitment: Commitment):
  { kind: CommitmentChange['kind']; reason: string; terms: CommitmentTerms } | null {
  if (commitment.status !== 'active') return null;
  if (!npc.alive) return null;
  if (npc.hunger <= NEGOTIATION.survivalHunger) {
    return { kind: 'suspend', reason: 'hunger-critical',
      terms: { resumeWhen: `hunger>=${NEGOTIATION.resumeHunger}`,
        reason: '我要先保证自己活下来，之后再送' } };
  }
  return null;
}

/** Is the agreed resume condition satisfied? Player resume bypasses the wait. */
export function resumeReady(npc: NpcState, commitment: Commitment,
  options: { playerResume?: boolean } = {}): boolean {
  if (options.playerResume) return true;
  const accepted = [...commitment.changes].reverse()
    .find(change => change.status === 'accepted');
  const when = accepted?.terms.resumeWhen;
  if (!when) return true;
  const hunger = when.match(/^hunger>=(\d+(?:\.\d+)?)$/);
  if (hunger) return npc.hunger >= Number(hunger[1]);
  const stamina = when.match(/^stamina>=(\d+(?:\.\d+)?)$/);
  if (stamina) return npc.stamina >= Number(stamina[1]);
  return true;
}

/** A rejected proposal plus a dying promisor makes the explicit exit honest. */
export function shouldWithdraw(npc: NpcState, commitment: Commitment): boolean {
  if (commitment.status !== 'pending-change') return false;
  const open = commitment.changes.some(change => change.status === 'open');
  if (open) return false; // still waiting for the answer: never act unilaterally
  const rejected = commitment.changes.some(change => change.status === 'rejected');
  return rejected && npc.hunger < NEGOTIATION.withdrawHunger;
}
