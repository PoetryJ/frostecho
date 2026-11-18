/**
 * One persistent, resumable execution record for every action that spends
 * authoritative time.
 *
 * The R9 defect was that "work started, effect later" was stored as a small
 * tuple plus a process-local settlement closure. That lost the instance, the
 * authorisation token, the place premise and the target ledger on restore, so a
 * cancelled or restored action could still produce a late physical effect.
 *
 * This record carries everything settlement needs, so a new process can decide
 * again from data alone:
 *   - who acts, which candidate/command/input produced it;
 *   - the generation (authorisation token) captured when it was queued;
 *   - the exact task/commitment instance and revision it discharges;
 *   - where it must happen, when it starts and when it is due;
 *   - what actually landed (receipt ids) and why it failed otherwise;
 *   - which ledger projection still owes an update.
 */
import { canonicalJson, sha256Hex } from '../../decision/contracts';
import type { Candidate } from '../../decision/contracts';

export type ActionStatus = 'working' | 'applied' | 'rejected' | 'cancelled' | 'unresolved';

/** The identity of one demand, i.e. one real request for one action. */
export interface DemandIdentity {
  actorId: string;
  candidate: Candidate;
  taskId?: string | null;
  commitmentId?: string | null;
  commitmentRevision?: number | null;
}

/**
 * Identity of ONE demand, never of one attempt.
 *
 * The same actor re-issuing the same action for the same ledger instance is the
 * same demand: it may occupy the body once and produce one receipt. Two task
 * instances of the same type carry different ids (and `legacyTaskId` in their
 * parameters), so they remain two demands and are never silently merged.
 */
export function demandIdOf(input: DemandIdentity): string {
  return `dem-${sha256Hex(canonicalJson({
    actorId: input.actorId,
    candidateId: input.candidate.id,
    action: String(input.candidate.parameters.action ?? ''),
    parameters: input.candidate.parameters,
    taskId: input.taskId ?? null,
    commitmentId: input.commitmentId ?? null,
    commitmentRevision: input.commitmentRevision ?? null,
  })).slice(0, 24)}`;
}

export interface ProjectionClaim {
  kind: 'task' | 'commitment';
  /** taskId or commitmentId. */
  id: string;
  /** Commitment revision the action was queued under (null for tasks). */
  revision: number | null;
  receiptId: string;
  applied: boolean;
  appliedAt: number | null;
}

export interface ActionIntent {
  intentId: string;
  commandId: string;
  actorId: string;
  candidateId: string;
  /** One demand per (actor, action identity, ledger instance); re-issues dedupe. */
  demandId: string;
  candidate: Candidate;
  /** Identity of the model/request input that produced this action, if any. */
  inputSha256: string | null;
  /** Authorisation token captured at enqueue time. */
  generation: number;
  taskId: string | null;
  taskType: string | null;
  commitmentId: string | null;
  commitmentRevision: number | null;
  startedAt: number;
  dueAt: number;
  requiredPlace: string | null;
  startPlace: string;
  status: ActionStatus;
  receiptIds: string[];
  failureReason: string | null;
  /** One claim per committed receipt that a ledger still has to absorb. */
  projections: ProjectionClaim[];
  settledAt: number | null;
}

export interface BeginIntentInput {
  intentId: string;
  commandId: string;
  actorId: string;
  candidate: Candidate;
  minutes: number;
  generation: number;
  /** Explicit demand identity; derived from the action when omitted. */
  demandId?: string | null;
  inputSha256?: string | null;
  taskId?: string | null;
  taskType?: string | null;
  commitmentId?: string | null;
  commitmentRevision?: number | null;
}

export function createIntent(input: BeginIntentInput, startedAt: number,
  requiredPlace: string | null, startPlace: string): ActionIntent {
  return {
    intentId: input.intentId,
    commandId: input.commandId,
    actorId: input.actorId,
    candidateId: input.candidate.id,
    demandId: input.demandId ?? demandIdOf(input),
    candidate: input.candidate,
    inputSha256: input.inputSha256 ?? null,
    generation: input.generation,
    taskId: input.taskId ?? null,
    taskType: input.taskType ?? null,
    commitmentId: input.commitmentId ?? null,
    commitmentRevision: input.commitmentRevision ?? null,
    startedAt,
    dueAt: startedAt + input.minutes,
    requiredPlace,
    startPlace,
    status: 'working',
    receiptIds: [],
    failureReason: null,
    projections: [],
    settledAt: null,
  };
}

/** The action record is the only thing a settlement may read. */
export function projectionOf(intent: ActionIntent, receiptId: string): ProjectionClaim | null {
  if (intent.commitmentId) {
    return { kind: 'commitment', id: intent.commitmentId, revision: intent.commitmentRevision,
      receiptId, applied: false, appliedAt: null };
  }
  if (intent.taskId) {
    return { kind: 'task', id: intent.taskId, revision: null, receiptId,
      applied: false, appliedAt: null };
  }
  return null;
}
