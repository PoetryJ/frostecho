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

/**
 * One planned physical step of a continuous action. The original map charges
 * one minute per tile and per door, so a travel plan is a list of legs whose
 * length IS the work minutes: the clock cannot reach the destination sooner,
 * and no leg can be paid for twice.
 */
export interface IntentLeg {
  index: number;
  kind: 'cell' | 'door';
  /** Map the leg starts on (and, for a cell step, the map it ends on). */
  mapId: string;
  /** For `cell`: the destination tile. For `door`: the door tile stepped from. */
  cell: { x: number; y: number };
  /** Room entered by a door leg; null for a plain cell step. */
  targetMapId: string | null;
  minutes: number;
}

/**
 * Serializable travel phase: path, current leg, paid minutes and the cancel
 * point all survive a save/restart, so a new process continues the walk from
 * the committed receipt instead of re-running it.
 */
export interface IntentProgress {
  kind: 'legacy-travel';
  target: string;
  /** Full planned path. Immutable once queued. */
  path: IntentLeg[];
  /** Index of the next leg to land (= number of legs already landed). */
  leg: number;
  /** Work minutes paid so far; equals the clock delta since `startedAt`. */
  progress: number;
  /** Authoritative duration of the plan (sum of leg minutes). */
  plannedMinutes: number;
  /** What the caller asked for; kept visible when it differs from the plan. */
  requestedMinutes: number | null;
  /** Clock at which a mid-way cancellation happened, if it did. */
  cancelAt: number | null;
  /** Clock of the last committed leg. */
  committedAt: number | null;
  /** One committed receipt per landed leg, in order. */
  legReceiptIds: string[];
  /** Clock of each landed leg, in order (evidence of the paid minutes). */
  landedAt: number[];
}

/** Atomic settlement claim: a nested settlement must not take the same work. */
export interface IntentClaim {
  at: number;
  token: string;
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
  /** Live settlement claim; cleared on commit so a restore cannot stay stuck. */
  claim: IntentClaim | null;
  /** Continuous travel phase; null for instant and one-shot work actions. */
  move: IntentProgress | null;
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
  /** Planned continuous phase; its duration overrides `minutes`. */
  move?: IntentProgress | null;
}

export function createIntent(input: BeginIntentInput, startedAt: number,
  requiredPlace: string | null, startPlace: string): ActionIntent {
  const move = input.move ?? null;
  const minutes = move ? move.plannedMinutes : input.minutes;
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
    dueAt: startedAt + minutes,
    requiredPlace,
    startPlace,
    status: 'working',
    claim: null,
    move,
    receiptIds: [],
    failureReason: null,
    projections: [],
    settledAt: null,
  };
}

/** Clock at which the next unlanded leg falls due (null when the path is done). */
export function nextLegAt(intent: ActionIntent): number | null {
  const move = intent.move;
  if (!move || move.leg >= move.path.length) return null;
  return intent.startedAt + move.progress + move.path[move.leg].minutes;
}

/** Every remaining leg time: advanceWorld must split the span at each of them. */
export function remainingLegTimes(intent: ActionIntent): number[] {
  const move = intent.move;
  if (!move) return [];
  const times: number[] = [];
  let paid = move.progress;
  for (let index = move.leg; index < move.path.length; index += 1) {
    paid += move.path[index].minutes;
    times.push(intent.startedAt + paid);
  }
  return times;
}

/** True when the continuous phase still owes a physical step at `at`. */
export function legDueAt(intent: ActionIntent, at: number): boolean {
  const next = nextLegAt(intent);
  return next !== null && at >= next;
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
