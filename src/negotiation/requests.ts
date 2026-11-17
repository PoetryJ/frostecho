/**
 * G09-R1 worker A — the structured request store and its state machine.
 *
 * Corrected contract:
 *   - the deadline is ENGINE LOGICAL TIME: expiresAtSimTime = createdAt + 1;
 *     a provider round is only a call counter and never expires anything;
 *   - an answer received at or after the expiry produces NO active binding
 *     and ends the request as expired;
 *   - fulfilment is judged from authoritative commands processed IN ORDER,
 *     only those after the acceptance seq and before the expiry; an NPC eat
 *     first is violated immediately and a later player eat cannot repair it;
 *   - the store lives at game level and is consumed at most once: the same
 *     id with the same parameters is a duplicate (no deadline refresh), a
 *     different parameter set is a conflict.
 */
import {
  G09_HUNGER_GOAL_AT_LEAST, G09_REQUEST_SCHEMA,
  goalOptionsIssues, strictGoalChoice,
  type GoalBinding, type GoalChoiceId, type GoalEvaluation, type GoalOutcome,
  type GoalRequestSnapshot, type GoalRequestStatus,
} from './contracts';

export interface CreateGoalRequestInput {
  requestId: string;
  episodeId: string;
  to: string;
  text: string;
  options: readonly GoalChoiceId[];
  createdAtSimTime: number;
  arm: 'self_only' | 'choice';
}

export type RequestResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const STATUSES: readonly GoalRequestStatus[] = ['pending', 'accepted', 'declined', 'expired', 'cancelled'];

/** Create a pending request with the frozen logical-time deadline. */
export function createGoalRequest(input: CreateGoalRequestInput): RequestResult<GoalRequestSnapshot> {
  const issues: string[] = [];
  if (typeof input.requestId !== 'string' || input.requestId.length === 0) issues.push('requestId must be a non-empty string');
  if (typeof input.episodeId !== 'string' || input.episodeId.length === 0) issues.push('episodeId must be a non-empty string');
  if (typeof input.to !== 'string' || input.to.length === 0) issues.push('to must be a non-empty string');
  if (typeof input.text !== 'string' || input.text.length === 0) issues.push('text must be a non-empty string');
  if (!Number.isSafeInteger(input.createdAtSimTime) || input.createdAtSimTime < 0) issues.push('createdAtSimTime must be a non-negative integer');
  issues.push(...goalOptionsIssues(input.options));
  if (input.arm === 'self_only' && input.options.includes('yield_once')) {
    issues.push('the self_only control arm may not offer yield_once');
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schema: G09_REQUEST_SCHEMA,
      requestId: input.requestId,
      episodeId: input.episodeId,
      from: 'player',
      to: input.to,
      kind: 'yield_once',
      text: input.text,
      options: [...input.options],
      createdAtSimTime: input.createdAtSimTime,
      expiresAtSimTime: input.createdAtSimTime + 1,
      status: 'pending',
      decision: null,
      acceptedAfterSeq: null,
      lastProcessedSeq: 0,
      outcome: 'pending',
      outcomeReason: null,
    },
  };
}

export function validateGoalRequestSnapshot(value: unknown): RequestResult<GoalRequestSnapshot> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['request must be an object'] };
  }
  const r = value as Partial<GoalRequestSnapshot>;
  const issues: string[] = [];
  if (r.schema !== G09_REQUEST_SCHEMA) issues.push(`schema must be ${G09_REQUEST_SCHEMA}`);
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) issues.push('requestId must be a non-empty string');
  if (typeof r.episodeId !== 'string' || r.episodeId.length === 0) issues.push('episodeId must be a non-empty string');
  if (r.from !== 'player') issues.push("from must be 'player'");
  if (r.kind !== 'yield_once') issues.push("kind must be 'yield_once'");
  if (typeof r.to !== 'string' || r.to.length === 0) issues.push('to must be a non-empty string');
  if (typeof r.text !== 'string' || r.text.length === 0) issues.push('text must be a non-empty string');
  issues.push(...goalOptionsIssues(r.options ?? []));
  if (!Number.isSafeInteger(r.createdAtSimTime) || (r.createdAtSimTime ?? -1) < 0) issues.push('createdAtSimTime must be a non-negative integer');
  if (r.expiresAtSimTime !== (r.createdAtSimTime ?? -2) + 1) issues.push('expiresAtSimTime must be createdAtSimTime + 1');
  if (!STATUSES.includes(r.status as GoalRequestStatus)) issues.push(`unknown status ${JSON.stringify(r.status)}`);
  if (r.status !== 'accepted' && r.acceptedAfterSeq !== null) issues.push('only an accepted request carries an acceptance seq');
  if (r.status === 'accepted' && (!Number.isSafeInteger(r.acceptedAfterSeq) || (r.acceptedAfterSeq ?? -1) < 0)) {
    issues.push('an accepted request must carry its acceptance seq');
  }
  if (!Number.isSafeInteger(r.lastProcessedSeq) || (r.lastProcessedSeq ?? -1) < 0) issues.push('lastProcessedSeq must be a non-negative integer');
  if (r.status === 'declined' && r.outcome !== 'pending') issues.push('a declined request has no fulfilment outcome');
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: r as GoalRequestSnapshot };
}

export interface DecideGoalInput {
  request: GoalRequestSnapshot;
  episodeId: string;
  raw: string;
  /** Call accounting only — never a deadline. */
  round: number;
  /** The authoritative simTime when the answer was received. */
  decidedAtSimTime: number;
  /** The highest command seq already applied in the world. */
  currentSeq?: number;
}

export interface DecideGoalOutcome {
  request: GoalRequestSnapshot;
  /** Null whenever no ACTIVE goal was bound (expiry, conflict, decline). */
  binding: GoalBinding | null;
}

/**
 * Apply one model answer. Past the deadline the answer is late: the request
 * ends expired and NO binding is produced (the call is still charged by the
 * caller). Otherwise yield_once accepts and bind the request with its
 * original expiry and the current command-seq boundary.
 */
export function decideGoalRequest(input: DecideGoalInput): RequestResult<DecideGoalOutcome> {
  const request = input.request;
  const issues: string[] = [];
  if (request.status !== 'pending') issues.push(`request ${request.requestId} is ${request.status}, not pending`);
  if (input.episodeId !== request.episodeId) issues.push('the answer episode does not match the request episode');
  if (!Number.isSafeInteger(input.round) || input.round < 1) issues.push('round must be an integer ≥ 1');
  if (!Number.isSafeInteger(input.decidedAtSimTime) || input.decidedAtSimTime < 0) issues.push('decidedAtSimTime must be a non-negative integer');
  const currentSeq = input.currentSeq ?? 0;
  if (!Number.isSafeInteger(currentSeq) || currentSeq < 0) issues.push('currentSeq must be a non-negative integer');
  if (issues.length > 0) return { ok: false, issues };

  // Logical-time expiry comes FIRST: no answer can be accepted at/after it.
  if (input.decidedAtSimTime >= request.expiresAtSimTime) {
    return {
      ok: true,
      value: {
        request: {
          ...request,
          status: 'expired',
          decision: null,
          outcome: 'expired',
          outcomeReason: `the answer arrived at simTime ${input.decidedAtSimTime}, at or after the expiry ${request.expiresAtSimTime}`,
          lastProcessedSeq: currentSeq,
        },
        binding: null,
      },
    };
  }

  const parse = strictGoalChoice(input.raw, request.options);
  if (!parse.ok) return { ok: false, issues: [`request ${request.requestId}: invalid goal answer: ${parse.error}`] };

  const decision = { goal: parse.goal, round: input.round, decidedAtSimTime: input.decidedAtSimTime, raw: input.raw };
  if (parse.goal === 'feed_self') {
    // A self goal (the control arm's only option) declines the yield request.
    return {
      ok: true,
      value: {
        request: { ...request, status: 'declined', decision, outcome: 'pending', lastProcessedSeq: currentSeq },
        binding: null,
      },
    };
  }
  return {
    ok: true,
    value: {
      request: {
        ...request,
        status: 'accepted',
        decision,
        acceptedAfterSeq: currentSeq,
        lastProcessedSeq: currentSeq,
      },
      binding: {
        schema: 'frostecho.g09.goal-binding/2' as const,
        episodeId: request.episodeId,
        requestId: request.requestId,
        goal: 'yield_once',
        decidedRound: input.round,
        decidedAtSimTime: input.decidedAtSimTime,
        expiresAtSimTime: request.expiresAtSimTime,
        acceptedAfterSeq: currentSeq,
        raw: input.raw,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Authoritative command processing (in order, boundary-safe)          */
/* ------------------------------------------------------------------ */

export interface AuthoritativeCommand {
  seq: number;
  command: { actorId: string; type: string };
  result?: { status?: string; reason?: string } | null;
}

/**
 * Fold ONE authoritative command into the accepted request. Terminal
 * outcomes are monotonic: once violated always violated, and a later player
 * eat cannot repair an earlier NPC eat. Commands at or before the acceptance
 * seq are ignored (they cannot fulfil a promise made later).
 */
export function processAcceptedCommand(
  request: GoalRequestSnapshot,
  binding: Pick<GoalBinding, 'acceptedAfterSeq' | 'expiresAtSimTime'> | null,
  command: AuthoritativeCommand,
  simTime: number,
): GoalRequestSnapshot {
  if (request.status !== 'accepted' || binding === null) return request;
  if (request.outcome !== 'pending') return request; // terminal and idempotent
  if (!Number.isSafeInteger(command?.seq)) return request;
  if (command.seq <= binding.acceptedAfterSeq) return request; // an old event proves nothing
  const next = { ...request, lastProcessedSeq: Math.max(request.lastProcessedSeq, command.seq) };
  // The deadline is checked at the command's OWN authoritative time.
  if (simTime >= binding.expiresAtSimTime) {
    return { ...next, outcome: 'expired', outcomeReason: `no fulfilment before the expiry ${binding.expiresAtSimTime}` };
  }
  const accepted = command.result?.status === 'accepted';
  const playerActor = 'player';
  const playerActorId = request.to === 'npc_a' ? 'npc_b' : 'player';
  if (command.command.actorId === request.to && command.command.type === 'eat' && accepted) {
    return { ...next, outcome: 'violated', outcomeReason: `${request.to} ate first at seq ${command.seq}` };
  }
  if ((command.command.actorId === playerActor || command.command.actorId === playerActorId) && command.command.type === 'eat') {
    if (accepted) return { ...next, outcome: 'fulfilled', outcomeReason: `the player ate at seq ${command.seq}` };
    return {
      ...next,
      outcome: 'failed',
      outcomeReason: `the player's eat failed at seq ${command.seq}${command.result?.reason === undefined ? '' : ` (${String(command.result.reason)})`}`,
    };
  }
  // Another NPC taking the last food is a failed promise, not a fulfilment.
  if (command.command.type === 'eat' && accepted && command.command.actorId !== request.to) {
    return { ...next, outcome: 'failed', outcomeReason: `${command.command.actorId} took the resource at seq ${command.seq}` };
  }
  return next;
}

/** Logical-time expiry of a pending or accepted request (idempotent). */
export function expireRequestIfDue(request: GoalRequestSnapshot, simTime: number): GoalRequestSnapshot {
  if (request.status === 'cancelled') return request;
  if (request.status === 'accepted') {
    if (request.outcome !== 'pending') return request;
    if (simTime < request.expiresAtSimTime) return request;
    return { ...request, outcome: 'expired', outcomeReason: `no fulfilment before the expiry ${request.expiresAtSimTime}` };
  }
  if (request.status === 'pending') {
    if (simTime < request.expiresAtSimTime) return request;
    return { ...request, status: 'expired', outcome: 'expired', outcomeReason: `no goal answer before the expiry ${request.expiresAtSimTime}` };
  }
  return request;
}

export function cancelRequest(request: GoalRequestSnapshot, reason: string): GoalRequestSnapshot {
  // A declined answer is a terminal game result, not an unfinished promise.
  if (request.outcome !== 'pending' || request.status === 'cancelled' || request.status === 'declined') return request;
  return { ...request, status: 'cancelled', outcome: 'cancelled', outcomeReason: reason };
}

/* ------------------------------------------------------------------ */
/* Game-level store: dedupe, conflict, consume once                    */
/* ------------------------------------------------------------------ */

export interface GoalRequestStore {
  /** Every request ever enqueued, by id. */
  requests: Record<string, GoalRequestSnapshot>;
  /** Ids already consumed by a goal_choice phase (never asked twice). */
  processed: string[];
}

export function createRequestStore(): GoalRequestStore {
  return { requests: {}, processed: [] };
}

export type EnqueueResult =
  | { ok: true; state: 'enqueued' | 'duplicate'; request: GoalRequestSnapshot }
  | { ok: false; issues: string[] };

function sameParams(a: GoalRequestSnapshot, b: GoalRequestSnapshot): boolean {
  return a.episodeId === b.episodeId
    && a.to === b.to
    && a.text === b.text
    && a.createdAtSimTime === b.createdAtSimTime
    && JSON.stringify([...a.options]) === JSON.stringify([...b.options]);
}

/**
 * Enqueue a request. The same id with the same parameters is a duplicate (no
 * deadline refresh, no new count); the same id with different parameters is
 * a conflict. Only one un-terminated request per target is allowed.
 */
export function enqueueGoalRequest(store: GoalRequestStore, request: GoalRequestSnapshot): EnqueueResult {
  const existing = store.requests[request.requestId];
  if (existing !== undefined) {
    if (sameParams(existing, request)) return { ok: true, state: 'duplicate', request: existing };
    return { ok: false, issues: [`request ${request.requestId} already exists with different parameters`] };
  }
  const live = Object.values(store.requests).find(candidate => candidate.to === request.to
    && (candidate.status === 'pending' || (candidate.status === 'accepted' && candidate.outcome === 'pending')));
  if (live !== undefined) {
    return { ok: false, issues: [`target ${request.to} already holds the un-terminated request ${live.requestId}`] };
  }
  store.requests[request.requestId] = request;
  return { ok: true, state: 'enqueued', request };
}

/** The one pending request for an actor that has never been consumed. */
export function pendingRequestFor(store: GoalRequestStore, actorId: string, simTime: number): GoalRequestSnapshot | null {
  for (const request of Object.values(store.requests)) {
    if (request.to !== actorId || request.status !== 'pending') continue;
    if (store.processed.includes(request.requestId)) continue;
    if (simTime >= request.expiresAtSimTime) continue; // expired; never asked
    return request;
  }
  return null;
}

/** Mark a request as asked. The same id is never asked again. */
export function markRequestProcessed(store: GoalRequestStore, requestId: string): boolean {
  if (store.processed.includes(requestId)) return false;
  store.processed.push(requestId);
  return true;
}

export function updateRequest(store: GoalRequestStore, request: GoalRequestSnapshot): void {
  store.requests[request.requestId] = request;
}

/* ------------------------------------------------------------------ */
/* Goal evaluation                                                     */
/* ------------------------------------------------------------------ */

/**
 * The selected goal's evaluator. feed_self keeps the original hunger rule;
 * yield_once is decided by the authoritative request outcome — never by the
 * NPC's own hunger.
 */
export function evaluateGoal(
  binding: Pick<GoalBinding, 'goal'> | null,
  world: { npcs: Record<string, { hunger?: number } | undefined> },
  actorId: string,
  request: GoalRequestSnapshot | null,
): GoalEvaluation {
  if (binding === null) {
    return { goal: 'feed_self', achieved: false, basis: 'hunger', outcome: null, detail: 'no goal selected' };
  }
  if (binding.goal === 'yield_once') {
    const outcome: GoalOutcome = request === null ? 'pending' : request.outcome;
    return {
      goal: 'yield_once',
      achieved: outcome === 'fulfilled',
      basis: 'request',
      outcome,
      detail: request === null
        ? 'the bound request is missing'
        : `request ${request.requestId} is ${outcome}${request.outcomeReason === null ? '' : `: ${request.outcomeReason}`}`,
    };
  }
  const hunger = world.npcs[actorId]?.hunger;
  const value = typeof hunger === 'number' ? hunger : 0;
  return {
    goal: 'feed_self',
    achieved: value >= G09_HUNGER_GOAL_AT_LEAST,
    basis: 'hunger',
    outcome: null,
    detail: `hunger ${value} vs ${G09_HUNGER_GOAL_AT_LEAST}`,
  };
}
