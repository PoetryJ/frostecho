/**
 * G09 worker A — the structured request store (pure data).
 *
 * One request per episode: created pending with a frozen option offer,
 * decided at most once (accepted on yield_once, rejected on feed_self when
 * there was an ask), expired when the deadline round passed without a
 * decision. The builder cannot see satiety, so no threshold can force or
 * filter the offer; a yield-only offer is refused outright.
 */
import {
  G09_GOAL_DEADLINE_ROUND, G09_REQUEST_SCHEMA,
  goalOptionsIssues, strictGoalChoice,
  type GoalBinding, type GoalChoiceId, type GoalRequestSnapshot, type GoalRequestStatus,
} from './contracts';

export interface CreateGoalRequestInput {
  requestId: string;
  episodeId: string;
  to: string;
  text: string;
  options: readonly GoalChoiceId[];
  createdAtSimTime: number;
  deadlineAfterRound?: number;
  /** The arm decides whether an ask exists; self_only never offers yield. */
  arm: 'self_only' | 'choice';
}

export type RequestResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

const REQUEST_STATUSES: readonly GoalRequestStatus[] = ['pending', 'accepted', 'rejected', 'expired'];

export function createGoalRequest(input: CreateGoalRequestInput): RequestResult<GoalRequestSnapshot> {
  const issues: string[] = [];
  if (typeof input.requestId !== 'string' || input.requestId.length === 0) issues.push('requestId must be a non-empty string');
  if (typeof input.episodeId !== 'string' || input.episodeId.length === 0) issues.push('episodeId must be a non-empty string');
  if (typeof input.to !== 'string' || input.to.length === 0) issues.push('to must be a non-empty string');
  if (typeof input.text !== 'string' || input.text.length === 0) issues.push('text must be a non-empty string');
  if (!Number.isSafeInteger(input.createdAtSimTime) || input.createdAtSimTime < 0) issues.push('createdAtSimTime must be a non-negative integer');
  issues.push(...goalOptionsIssues(input.options));
  if (input.arm === 'self_only' && input.options.includes('yield_once')) {
    issues.push('the self_only arm may not offer yield_once (there is no ask to accept)');
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
      text: input.text,
      options: [...input.options],
      deadlineAfterRound: input.deadlineAfterRound ?? G09_GOAL_DEADLINE_ROUND,
      createdAtSimTime: input.createdAtSimTime,
      status: 'pending',
      decision: null,
    },
  };
}

/** Structural validation for a snapshot read back from a record. */
export function validateGoalRequestSnapshot(value: unknown): RequestResult<GoalRequestSnapshot> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['request must be an object'] };
  }
  const r = value as Partial<GoalRequestSnapshot> & { schema?: unknown };
  const issues: string[] = [];
  if (r.schema !== G09_REQUEST_SCHEMA) issues.push(`schema must be ${G09_REQUEST_SCHEMA}`);
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) issues.push('requestId must be a non-empty string');
  if (typeof r.episodeId !== 'string' || r.episodeId.length === 0) issues.push('episodeId must be a non-empty string');
  if (r.from !== 'player') issues.push("from must be 'player'");
  if (typeof r.to !== 'string' || r.to.length === 0) issues.push('to must be a non-empty string');
  if (typeof r.text !== 'string' || r.text.length === 0) issues.push('text must be a non-empty string');
  issues.push(...goalOptionsIssues(r.options ?? []));
  if (!Number.isSafeInteger(r.deadlineAfterRound) || (r.deadlineAfterRound ?? 0) < 1) {
    issues.push('deadlineAfterRound must be an integer ≥ 1');
  }
  if (!Number.isSafeInteger(r.createdAtSimTime) || (r.createdAtSimTime ?? -1) < 0) {
    issues.push('createdAtSimTime must be a non-negative integer');
  }
  if (!REQUEST_STATUSES.includes(r.status as GoalRequestStatus)) issues.push(`unknown status ${JSON.stringify(r.status)}`);
  if (r.status === 'pending' && r.decision !== null) issues.push('a pending request cannot hold a decision');
  if (r.status !== 'pending') {
    const decision = r.decision;
    if (decision === null || decision === undefined
      || typeof decision.goal !== 'string' || !(['feed_self', 'yield_once'] as const).includes(decision.goal as GoalChoiceId)
      || !Number.isSafeInteger(decision.round) || decision.round < 1
      || typeof decision.raw !== 'string') {
      issues.push(`a ${String(r.status)} request must hold {goal, round ≥ 1, raw}`);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: r as GoalRequestSnapshot };
}

export interface DecideGoalInput {
  raw: string;
  round: number;
  decidedAtSimTime: number;
  /** The snapshot being decided. */
  request: GoalRequestSnapshot;
  /** The binding's episode (must match the request's episode). */
  episodeId: string;
}

/**
 * Apply one model answer to a pending request. The raw text is re-parsed with
 * the frozen strict parser; the goal decides accept/reject:
 *   yield_once → accepted, feed_self → rejected (a legal refusal).
 * A decision that misses the deadline round expires instead.
 */
export function decideGoalRequest(input: DecideGoalInput): RequestResult<{ request: GoalRequestSnapshot; binding: GoalBinding }> {
  const issues: string[] = [];
  if (input.request.status !== 'pending') issues.push(`request ${input.request.requestId} is ${input.request.status}, not pending`);
  if (input.episodeId !== input.request.episodeId) issues.push('the binding episode does not match the request episode');
  if (!Number.isSafeInteger(input.round) || input.round < 1) issues.push('round must be an integer ≥ 1');
  if (!Number.isSafeInteger(input.decidedAtSimTime) || input.decidedAtSimTime < 0) issues.push('decidedAtSimTime must be a non-negative integer');
  if (issues.length > 0) return { ok: false, issues };

  const parse = strictGoalChoice(input.raw, input.request.options);
  if (!parse.ok) return { ok: false, issues: [`request ${input.request.requestId}: invalid goal answer: ${parse.error}`] };
  if (input.round > input.request.deadlineAfterRound) {
    return {
      ok: true,
      value: {
        request: { ...input.request, status: 'expired', decision: { goal: parse.goal, round: input.round, raw: input.raw } },
        binding: {
          schema: 'frostecho.g09.goal-binding/1' as const,
          episodeId: input.episodeId,
          requestId: input.request.requestId,
          goal: parse.goal,
          decidedRound: input.round,
          decidedAtSimTime: input.decidedAtSimTime,
          raw: input.raw,
        },
      },
    };
  }
  const status: GoalRequestStatus = parse.goal === 'yield_once' ? 'accepted' : 'rejected';
  return {
    ok: true,
    value: {
      request: { ...input.request, status, decision: { goal: parse.goal, round: input.round, raw: input.raw } },
      binding: {
        schema: 'frostecho.g09.goal-binding/1' as const,
        episodeId: input.episodeId,
        requestId: input.request.requestId,
        goal: parse.goal,
        decidedRound: input.round,
        decidedAtSimTime: input.decidedAtSimTime,
        raw: input.raw,
      },
    },
  };
}

/** The self_only arm has no ask: the declaration only produces a binding. */
export function selfGoalBinding(episodeId: string, raw: string, round: number, decidedAtSimTime: number): RequestResult<GoalBinding> {
  const parse = strictGoalChoice(raw, ['feed_self']);
  if (!parse.ok) return { ok: false, issues: [`invalid self declaration: ${parse.error}`] };
  return {
    ok: true,
    value: {
      schema: 'frostecho.g09.goal-binding/1',
      episodeId,
      requestId: null,
      goal: parse.goal,
      decidedRound: round,
      decidedAtSimTime,
      raw,
    },
  };
}

/** Pending → expired once the deadline round passed with no decision. */
export function expireGoalRequest(request: GoalRequestSnapshot, currentRound: number): GoalRequestSnapshot {
  if (request.status !== 'pending') return request;
  if (currentRound <= request.deadlineAfterRound) return request;
  return { ...request, status: 'expired' };
}
