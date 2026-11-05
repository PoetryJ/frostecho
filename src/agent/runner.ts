import { WorldState } from '../types';
import {
  ActiveGoal, AgentAction, AgentSession, CommandIdScheme, DecideInput, DecidingPhase, DEFAULT_TIMEOUT_MS, GOAL_HUNGER_AT_LEAST, MAX_PROVIDER_CALLS, GoalDecisionRecord,
  Provider, RunOptions, RunOutcome, RunResult, SessionStatus, StepAgentResult, StepFeedback, StepRecord,
  SubmittedCommand, GoalProtocolOptions, GoalChoiceContext,
} from './contracts';
import { WAIT_SIM_STEPS, type ActionSet, type SessionWaitState } from '../temporal/contracts';
import { observe } from './observation';
import { parseAction } from './parser';
import {
  G09_BINDING_SCHEMA, goalChoiceLine, goalOptionsIssues, strictGoalChoice,
  type GoalBinding,
} from '../negotiation/contracts';

/** Structural rules of a per-session goal protocol (frozen arm semantics). */
export function goalProtocolIssues(protocol: GoalProtocolOptions): string[] {
  const issues: string[] = [];
  issues.push(...goalOptionsIssues(protocol.options));
  if (protocol.arm !== 'self_only' && protocol.arm !== 'choice') issues.push(`unknown arm ${JSON.stringify(protocol.arm)}`);
  if (!Number.isSafeInteger(protocol.expiresAtSimTime) || protocol.expiresAtSimTime < 1) {
    issues.push('expiresAtSimTime must be an integer ≥ 1 (createdAtSimTime + 1)');
  }
  if (typeof protocol.requestId !== 'string' || protocol.requestId.length === 0) {
    issues.push('requestId must be a non-empty host string');
  }
  if (typeof protocol.playerId !== 'string' || protocol.playerId.length === 0) issues.push('playerId must be a non-empty string');
  if (typeof protocol.text !== 'string' || protocol.text.length === 0) issues.push('text must be a non-empty string');
  // BOTH arms carry the SAME player request; only the candidates differ.
  if (protocol.arm === 'self_only') {
    if (protocol.options.length !== 1 || protocol.options[0] !== 'feed_self') {
      issues.push("the self_only control arm offers exactly ['feed_self']");
    }
  } else if (!protocol.options.includes('feed_self') || !protocol.options.includes('yield_once')) {
    issues.push('the choice arm offers both goals');
  }
  return issues;
}

type CallResult =
  | { raw: string; ms: number }
  | { failure: 'timeout' | 'provider_error'; message: string; ms: number };

interface TimeoutHandle { cancel(): void }

function defaultSchedule(fn: () => void, ms: number): TimeoutHandle {
  const timer = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(timer) };
}

function hungerOf(state: WorldState, actorId: string): number | undefined {
  if (!Object.hasOwn(state.npcs, actorId)) return undefined;
  const npc = state.npcs[actorId];
  if (!npc || typeof npc !== 'object' || typeof npc.hunger !== 'number') return undefined;
  return npc.hunger;
}

function toCommand(commandId: string, actorId: string, action: Exclude<AgentAction, { type: 'stop' } | { type: 'wait' }>): SubmittedCommand {
  if (action.type === 'move') return { commandId, actorId, type: 'move', payload: { to: action.to } };
  return { commandId, actorId, type: 'eat', payload: {} };
}

function publicError(err: unknown): string {
  if (err instanceof Error && err.name === 'ProviderTransportError') return err.message;
  return 'provider error';
}

/** G09: the authoritative acceptance boundary — the command ledger tail. */
function currentSeq(session: AgentSessionImpl): number {
  const port = session.options.world;
  if (typeof port.logLength === 'function') return port.logLength();
  let max = 0;
  for (const step of session.steps) {
    const seq = step.exec?.seq;
    if (typeof seq === 'number' && seq > max) max = seq;
  }
  return max;
}

function safeSimTime(state: WorldState): number | null {
  const simTime = state.simTime;
  return typeof simTime === 'number' && Number.isSafeInteger(simTime) && simTime >= 0 ? simTime : null;
}

/**
 * G09: build the frozen goal-choice context for the goal step. The player's
 * satiety and simTime come from the authoritative world state; a world
 * without either is a protocol failure, never a silent 0.
 */
function goalChoiceContext(
  protocol: GoalProtocolOptions,
  state: WorldState,
): GoalChoiceContext | { failure: string } {
  const simTime = safeSimTime(state);
  if (simTime === null) return { failure: 'goal choice without a valid authoritative simTime' };
  if (state.npcs[protocol.playerId] === undefined) {
    return { failure: `goal choice needs the player ${protocol.playerId} in the world` };
  }
  return {
    arm: protocol.arm,
    requestId: protocol.requestId,
    text: protocol.text,
    options: protocol.options,
    expiresAtSimTime: protocol.expiresAtSimTime,
    playerId: protocol.playerId,
    simTime,
  };
}

/**
 * G10: the action phase's structured active goal, rebuilt from the
 * AUTHORITATIVE decision and the request deadline — never from the goal
 * prompt text. A restored session rebuilds it from the restored binding, so
 * recovery costs no extra provider call.
 */
function activeGoalOf(session: AgentSessionImpl): ActiveGoal | null {
  const decision = session.goalDecision;
  if (decision === null) return null;
  if (decision.goal === 'feed_self') return { kind: 'feed_self', hungerAtLeast: GOAL_HUNGER_AT_LEAST };
  const expires = session.goalBinding?.expiresAtSimTime ?? session.goalProtocol?.expiresAtSimTime;
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < 0) return null;
  return { kind: 'yield_once', requestId: decision.requestId, expiresAtSimTime: expires };
}

/** The G09 binding records the episode it belongs to (runId `<episode>:<actor>:c<cycle>`). */
function episodeIdOfRunId(runId: string): string {
  const match = /^(.*):[^:]+:c\d+$/.exec(runId);
  return match?.[1] ?? runId;
}

/**
 * One provider call. On timeout the AbortSignal is fired and a late raw string
 * is discarded: the returned failure is what the runner acts on.
 * provider.decide is started synchronously so a caller can interleave before the result is used.
 */
function takeDecision(
  provider: Provider,
  input: DecideInput,
  timeoutMs: number,
  now: () => number,
  schedule: (fn: () => void, ms: number) => TimeoutHandle,
): Promise<CallResult> {
  const ac = new AbortController();
  const started = now();
  let timedOut = false;
  let finished = false;
  let timer: TimeoutHandle | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = schedule(() => {
      if (finished) return;
      timedOut = true;
      ac.abort();
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });
  let call: Promise<string>;
  try {
    call = Promise.resolve(provider.decide(input, ac.signal));
  } catch (err) {
    call = Promise.reject(err);
  }
  // A loser that rejects after race settles must not surface as an unhandled rejection.
  void call.then(() => undefined, () => undefined);
  void timeout.then(() => undefined, () => undefined);
  const elapsed = () => Math.max(0, now() - started);
  return Promise.race([call, timeout]).then(
    raw => {
      finished = true;
      timer?.cancel();
      if (timedOut || ac.signal.aborted) return { failure: 'timeout' as const, message: 'timeout', ms: elapsed() };
      if (typeof raw !== 'string') return { failure: 'provider_error' as const, message: 'provider returned non-string', ms: elapsed() };
      return { raw, ms: elapsed() };
    },
    err => {
      finished = true;
      timer?.cancel();
      if (timedOut || ac.signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
        return { failure: 'timeout' as const, message: 'timeout', ms: elapsed() };
      }
      return { failure: 'provider_error' as const, message: publicError(err), ms: elapsed() };
    },
  );
}

function stepForDeterministic(step: StepRecord): StepRecord {
  if (!step.transport) return step;
  const copy: StepRecord = { ...step };
  delete copy.transport;
  return copy;
}

/** Deterministic view of a run. Timing and HTTP latency are omitted on purpose. */
export function deterministicRecord(result: RunResult): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    runId: result.runId,
    actorId: result.actorId,
    outcome: result.outcome,
    goalReached: result.goalReached,
    providerCalls: result.providerCalls,
    steps: result.steps.map(stepForDeterministic),
    initialState: result.initialState,
    events: result.events,
    finalState: result.finalState,
  };
  if (result.error !== undefined) rec.error = result.error;
  return rec;
}

class AgentSessionImpl implements AgentSession {
  readonly runId: string;
  readonly actorId: string;
  round = 0;
  feedback: StepFeedback | null = null;
  status: SessionStatus = 'ready';
  providerCalls = 0;
  readonly steps: StepRecord[] = [];
  onDeciding?: (info: DecidingPhase) => void | Promise<void>;

  readonly options: RunOptions;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly started: number;
  readonly initialState: WorldState;
  readonly eventsBefore: number;
  readonly calls: { round: number; ms: number }[] = [];
  readonly commandIdFor: (round: number) => string;
  readonly commandIdScheme: CommandIdScheme;
  terminalOutcome: RunOutcome | null = null;
  explicitError?: string;
  phaseInfo: DecidingPhase | null = null;
  readonly waiters: ((info: DecidingPhase) => void)[] = [];
  /** G08 capability axis; 'legacy' unless RunOptions opted in. */
  readonly actionSet: ActionSet;
  /** Single wait deadline source; null unless status is 'waiting_time'. */
  wakeAtSimTime: number | null = null;
  /** True once resumeIfDue consumed the current wait (reset per accepted wait). */
  resumedOnce = false;
  /** G09: the frozen goal protocol, or null for a plain action session. */
  goalProtocol: GoalProtocolOptions | null;
  /** G09: the binding produced by the goal phase; a restored session never re-chooses. */
  goalBinding: GoalBinding | null = null;
  /** G09: the recorded decision — feed_self closes the phase without a binding. */
  goalDecision: GoalDecisionRecord | null = null;

  constructor(options: RunOptions) {
    this.options = options;
    this.runId = options.runId;
    this.actorId = options.actorId;
    this.actionSet = options.actionSet ?? 'legacy';
    this.goalProtocol = options.goalProtocol ?? null;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.started = this.now();
    this.initialState = structuredClone(options.world.getState());
    this.eventsBefore = options.world.getEvents().length;
    this.onDeciding = options.onDeciding;
    this.commandIdFor = options.commandIdFor ?? ((round: number) => `${options.runId}:${round}`);
    this.commandIdScheme = options.commandIdScheme
      ?? (options.commandIdFor !== undefined ? 'unknown' : 'run-round');
    if (typeof this.runId !== 'string' || this.runId.length === 0 || typeof this.actorId !== 'string' || this.actorId.length === 0) {
      this.failInvalid('runId and actorId must be non-empty strings');
      return;
    }
    if (this.goalProtocol !== null) {
      const issues = goalProtocolIssues(this.goalProtocol);
      if (issues.length > 0) {
        this.failInvalid(`invalid goal protocol: ${issues.join('; ')}`);
        return;
      }
      if (this.goalProtocol.playerId === this.actorId) {
        this.failInvalid('invalid goal protocol: the player must differ from the deciding actor');
        return;
      }
    }
    try {
      observe(this.initialState, this.actorId);
    } catch (err) {
      this.failInvalid(err instanceof Error ? err.message : 'unknown actor');
    }
  }

  private failInvalid(message: string) {
    this.status = 'invalid_run';
    this.terminalOutcome = 'invalid_run';
    this.explicitError = message;
  }

  whenDeciding(): Promise<DecidingPhase> {
    if (this.status === 'deciding' && this.phaseInfo) return Promise.resolve(this.phaseInfo);
    return new Promise(resolve => { this.waiters.push(resolve); });
  }

  /** G08: resume only when due; exactly one resume per accepted wait. */
  resumeIfDue(nowSimTime: number): boolean {
    if (this.status !== 'waiting_time' || this.wakeAtSimTime === null) return false;
    if (nowSimTime < this.wakeAtSimTime) return false;
    this.status = 'ready';
    this.wakeAtSimTime = null;
    this.resumedOnce = true;
    return true;
  }

  /** G08: terminal budget end for the episode-level limit; clears the deadline. */
  exhaustBudget(detail: string): void {
    if (this.status === 'waiting_time') {
      this.wakeAtSimTime = null;
    }
    if (this.status === 'ready' || this.status === 'waiting_time') {
      finishTerminal(this, 'budget_exhausted', 'budget_exhausted', detail);
    }
  }

  /** G08: deep-copied wait projection for records and checkpoints. */
  waitState(): SessionWaitState {
    return {
      actionSet: this.actionSet,
      status: this.status,
      wakeAtSimTime: this.wakeAtSimTime,
      providerCalls: this.providerCalls,
      resumedOnce: this.resumedOnce,
    };
  }

  /**
   * G09: attach the protocol at the natural decision point. A game opens its
   * cycles eagerly, so the request may arrive just before the first call; if
   * the session has not decided or called yet the protocol is accepted, and
   * nothing is ever re-attached.
   */
  attachGoalProtocol(protocol: GoalProtocolOptions): boolean {
    if (this.goalProtocol !== null || this.goalDecision !== null || this.providerCalls > 0) return false;
    if (goalProtocolIssues(protocol).length > 0) return false;
    this.goalProtocol = protocol;
    return true;
  }

  /** G09: which phase the next step belongs to. */
  get phase(): 'goal_choice' | 'action' {
    return this.goalProtocol !== null && this.goalDecision === null ? 'goal_choice' : 'action';
  }

  result(): RunResult {
    const finalState = structuredClone(this.options.world.getState());
    const events = structuredClone(this.options.world.getEvents()).slice(this.eventsBefore);
    const hunger = hungerOf(finalState, this.actorId);
    const reached = hunger !== undefined && hunger >= GOAL_HUNGER_AT_LEAST;
    // G09: the selected yield goal is judged by the AUTHORITATIVE request
    // outcome; the hunger need is a separate axis. Without a yield binding the
    // original hunger rule still decides goalReached.
    const bound = this.goalBinding !== null && this.goalBinding.goal === 'yield_once'
      ? this.goalBinding
      : null;
    const view = bound === null ? null : (this.options.goalHost?.outcome(bound.requestId) ?? null);
    const selected = view !== null && view.outcome === 'fulfilled';
    const goalReached = bound !== null ? selected : reached;
    // G10 P0a: one label, one truth. A bound yield promise is labelled by the
    // AUTHORITATIVE request outcome — hunger never upgrades a violation, a
    // timeout or an invalid run to goal_reached. Legacy sessions (no yield
    // binding) keep the original hunger label, including stop-at-goal.
    const terminal = this.terminalOutcome;
    let resolved: RunOutcome;
    if (bound !== null) {
      if (selected) resolved = 'goal_reached';
      else if (view !== null && view.outcome === 'violated') resolved = 'selected_goal_yield';
      else resolved = terminal ?? 'stopped';
    } else {
      resolved = terminal ?? (reached ? 'goal_reached' : 'stopped');
      if (resolved === 'stopped' && reached) resolved = 'goal_reached';
    }
    const result: RunResult = {
      runId: this.runId,
      actorId: this.actorId,
      outcome: resolved,
      goalReached: this.terminalOutcome === 'invalid_run' ? false : goalReached,
      hungerNeedSatisfied: reached,
      selectedGoalReached: selected,
      providerCalls: this.providerCalls,
      steps: this.steps,
      initialState: this.initialState,
      events,
      finalState,
      timing: { totalMs: Math.max(0, this.now() - this.started), calls: this.calls.slice() },
    };
    if (this.explicitError !== undefined) result.error = this.explicitError;
    else if (resolved === 'budget_exhausted') result.error = 'provider call budget exhausted';
    return result;
  }
}

function finishTerminal(session: AgentSessionImpl, status: SessionStatus, outcome: RunOutcome, error?: string) {
  session.status = status;
  session.terminalOutcome = outcome;
  if (error !== undefined) session.explicitError = error;
}

function withTransport(step: StepRecord, transport: StepRecord['transport']): StepRecord {
  if (transport) step.transport = transport;
  return step;
}

/**
 * One iteration of observe → decide → parse → submit.
 * The provider call is started before onDeciding, and Engine.submit runs only after that call's text is in hand.
 * The submit reads the world at that later moment, so a player command during the wait is visible to the engine.
 */
async function executeStep(session: AgentSessionImpl): Promise<StepAgentResult> {
  try {
    const state = structuredClone(session.options.world.getState());
    const hunger = hungerOf(state, session.actorId);
    // G09: with yield_once selected the session's temporary goal is the
    // request, not its own hunger — the hunger target comes back afterwards.
    const yieldBound = session.goalBinding !== null && session.goalBinding.goal === 'yield_once';
    if (!yieldBound && hunger !== undefined && hunger >= GOAL_HUNGER_AT_LEAST) {
      finishTerminal(session, 'goal_reached', 'goal_reached');
      return { status: 'goal_reached', terminal: true, providerCalled: false };
    }
    if (session.providerCalls >= MAX_PROVIDER_CALLS) {
      finishTerminal(session, 'budget_exhausted', 'budget_exhausted');
      return { status: 'budget_exhausted', terminal: true, providerCalled: false };
    }

    // G09: with the protocol enabled and undecided, this step is the goal
    // phase — the budget must cover the protocol (this call + one action
    // call), otherwise the session ends without spending anything.
    const inGoalPhase = session.goalProtocol !== null && session.goalDecision === null;
    if (inGoalPhase && session.providerCalls + 2 > MAX_PROVIDER_CALLS) {
      // The two-phase protocol needs both calls. One remaining call is NOT
      // exhausted and NOT spent: the session ends, the budget stays intact.
      finishTerminal(session, 'stopped', 'insufficient_budget',
        `insufficient budget: ${MAX_PROVIDER_CALLS - session.providerCalls} call(s) remain, the protocol needs 2`);
      return { status: 'stopped', terminal: true, providerCalled: false };
    }

    const round = session.providerCalls + 1;
    session.round = round;
    const observation = observe(state, session.actorId);
    const phase: DecidingPhase = { round, observation: structuredClone(observation) };
    session.phaseInfo = phase;
    const waiters = session.waiters.splice(0, session.waiters.length);
    for (const waiter of waiters) waiter(phase);

    let goalContext: GoalChoiceContext | { failure: string } | null = null;
    if (inGoalPhase && session.goalProtocol !== null) {
      goalContext = goalChoiceContext(session.goalProtocol, state);
      if ('failure' in goalContext) {
        finishTerminal(session, 'invalid_run', 'invalid_run', goalContext.failure);
        return { status: 'invalid_run', terminal: true, providerCalled: false };
      }
    }

    const input: DecideInput = {
      observation: structuredClone(observation),
      goal: { hungerAtLeast: GOAL_HUNGER_AT_LEAST },
      feedback: session.feedback ? { ...session.feedback } : null,
      ...(session.options.actionSet !== undefined ? { allowedActions: session.actionSet } : {}),
      ...(inGoalPhase && goalContext !== null && !('failure' in goalContext) ? { goalChoice: goalContext } : {}),
      // G10: the action phase renders the STRUCTURED decision, so the two
      // phases cannot disagree. The legacy line stays as a fallback only for
      // a session whose authoritative deadline is missing (never a normal run).
      ...(!inGoalPhase && session.goalDecision !== null
        ? (activeGoalOf(session) !== null
          ? { activeGoal: activeGoalOf(session)! }
          : { goalLine: goalChoiceLine({ goal: session.goalDecision.goal, requestId: session.goalDecision.requestId }) })
        : {}),
    };
    const done = takeDecision(
      session.options.provider,
      input,
      session.timeoutMs,
      session.now,
      session.options.scheduleTimeout ?? defaultSchedule,
    );
    session.providerCalls = round;
    if (session.onDeciding) await session.onDeciding(phase);
    const decision = await done;
    session.calls.push({ round, ms: decision.ms });
    const transport = session.options.provider.consumeTransport?.() ?? undefined;

    if ('failure' in decision) {
      const step = withTransport({
        round,
        observation: structuredClone(observation),
        raw: '',
        parse: { ok: false, error: decision.failure },
        ...(inGoalPhase && session.goalProtocol !== null
          ? { goal: { requestId: session.goalProtocol.requestId, goal: null, decidedRound: round, decidedAtSimTime: safeSimTime(state) ?? 0, parseOk: false } }
          : {}),
        error: decision.message,
      }, transport);
      session.steps.push(step);
      const status: SessionStatus = decision.failure === 'timeout' ? 'timeout' : 'provider_error';
      finishTerminal(session, status, decision.failure, decision.message);
      return { status, terminal: true, providerCalled: true, step };
    }

    // G09 goal phase: the one legal answer is the frozen one-key object. A
    // failing answer terminates the session — the protocol has no retry
    // round, so nothing else may spend the remaining budget.
    if (inGoalPhase && session.goalProtocol !== null) {
      const protocol = session.goalProtocol;
      // Re-read the AUTHORITATIVE receive point — a fresh world state and the
      // CURRENT request, never the pre-await snapshot and never the attach-time
      // seq. A late or already-resolved answer is discarded: no binding, no
      // submit, the call stays spent.
      const receiveState = session.options.world.getState();
      const receiveSimTime = safeSimTime(receiveState);
      const requestView = session.options.goalHost?.refresh(protocol.requestId) ?? null;
      const expiredBeforeAnswer = (receiveSimTime !== null && receiveSimTime >= protocol.expiresAtSimTime)
        || (requestView !== null && requestView.status !== 'pending');
      if (expiredBeforeAnswer) {
        const step = withTransport({
          round,
          observation: structuredClone(observation),
          raw: decision.raw,
          parse: { ok: false, error: 'late goal answer: the request expired' },
          goal: { requestId: protocol.requestId, goal: null, decidedRound: round, decidedAtSimTime: receiveSimTime ?? 0, parseOk: false },
          error: 'request expired before the goal answer',
        }, transport);
        session.steps.push(step);
        finishTerminal(session, 'failed', 'request_expired', 'request expired before the goal answer');
        return { status: 'failed', terminal: true, providerCalled: true, step };
      }
      const parse = strictGoalChoice(decision.raw, protocol.options);
      const decidedAtSimTime = receiveSimTime ?? 0;
      if (!parse.ok) {
        const step = withTransport({
          round,
          observation: structuredClone(observation),
          raw: decision.raw,
          parse: { ok: false, error: `goal: ${parse.error}` },
          goal: { requestId: protocol.requestId, goal: null, decidedRound: round, decidedAtSimTime, parseOk: false },
          error: `invalid goal output: ${parse.error}`,
        }, transport);
        session.steps.push(step);
        finishTerminal(session, 'invalid_run', 'invalid_run', `invalid goal output: ${parse.error}`);
        return { status: 'invalid_run', terminal: true, providerCalled: true, step };
      }
      session.goalDecision = {
        requestId: protocol.requestId,
        goal: parse.goal,
        decidedRound: round,
        decidedAtSimTime,
        raw: decision.raw,
      };
      if (parse.goal === 'feed_self') {
        // The decline is still recorded in the ONE authoritative store.
        const acceptedSeq = currentSeq(session);
        session.options.goalHost?.accept(session.goalDecision, acceptedSeq, decidedAtSimTime);
        const selfStep = withTransport({
          round,
          observation: structuredClone(observation),
          raw: decision.raw,
          parse: { ok: false, error: 'goal phase: feed_self chosen' },
          goal: { requestId: protocol.requestId, goal: 'feed_self', decidedRound: round, decidedAtSimTime, parseOk: true },
        }, transport);
        session.steps.push(selfStep);
        return { status: 'ready', terminal: false, providerCalled: true, step: selfStep };
      }
      // The acceptance boundary is the world's ledger length AT RESPONSE
      // ARRIVAL — never the seq captured when the protocol was attached.
      const acceptedSeq = currentSeq(session);
      const hostBinding = session.options.goalHost?.accept(session.goalDecision, acceptedSeq, decidedAtSimTime) ?? null;
      const binding: GoalBinding = hostBinding ?? {
        schema: G09_BINDING_SCHEMA,
        episodeId: episodeIdOfRunId(session.runId),
        requestId: protocol.requestId,
        goal: parse.goal,
        decidedRound: round,
        decidedAtSimTime,
        expiresAtSimTime: protocol.expiresAtSimTime,
        acceptedAfterSeq: acceptedSeq,
        raw: decision.raw,
      };
      session.goalBinding = binding;
      const step = withTransport({
        round,
        observation: structuredClone(observation),
        raw: decision.raw,
        parse: { ok: false, error: 'goal phase: no action parsed' },
        goal: { requestId: protocol.requestId, goal: parse.goal, decidedRound: round, decidedAtSimTime, parseOk: true },
      }, transport);
      session.steps.push(step);
      return { status: 'ready', terminal: false, providerCalled: true, step };
    }

    // G09: a yield promise that already expired must discard a late action:
    // no Engine submit, no new wait deadline, the call stays spent.
    if (yieldBound && session.goalBinding !== null) {
      // Re-read the receive point: the request may have expired or already
      // been fulfilled (the player ate while the answer was in flight). Either
      // way the late answer is discarded — no submit, no new wait deadline.
      const receiveState = session.options.world.getState();
      const receiveSimTime = safeSimTime(receiveState);
      const view = session.options.goalHost?.refresh(session.goalBinding.requestId) ?? null;
      const ended = (receiveSimTime !== null && receiveSimTime >= session.goalBinding.expiresAtSimTime)
        || (view !== null && (view.status !== 'accepted' || view.outcome !== 'pending'));
      if (ended) {
        const lateStep = withTransport({
          round,
          observation: structuredClone(observation),
          raw: decision.raw,
          parse: { ok: false, error: 'late action answer: the request is no longer open' },
          error: 'the request ended before the action answer',
        }, transport);
        session.steps.push(lateStep);
        finishTerminal(session, 'failed', 'request_expired', 'the request ended before the action answer');
        return { status: 'failed', terminal: true, providerCalled: true, step: lateStep };
      }
    }

    const parse = parseAction(decision.raw, session.actionSet);
    if (!parse.ok) {
      const step = withTransport({
        round,
        observation: structuredClone(observation),
        raw: decision.raw,
        parse,
        error: parse.error,
      }, transport);
      session.steps.push(step);
      session.feedback = { round, kind: 'invalid_output', detail: parse.error };
      if (session.providerCalls >= MAX_PROVIDER_CALLS) {
        finishTerminal(session, 'budget_exhausted', 'budget_exhausted');
        return { status: 'budget_exhausted', terminal: true, providerCalled: true, step };
      }
      return { status: 'ready', terminal: false, providerCalled: true, step };
    }

    if (parse.action.type === 'stop') {
      const step = withTransport({
        round,
        observation: structuredClone(observation),
        raw: decision.raw,
        parse,
      }, transport);
      session.steps.push(step);
      finishTerminal(session, 'stopped', 'stopped');
      return { status: 'stopped', terminal: true, providerCalled: true, step };
    }

    if (parse.action.type === 'wait') {
      // G08: the wait consumed this provider call. The deadline comes from the
      // authoritative simTime; the budget takes precedence over pausing, so a
      // wait on the last call ends budget_exhausted with no recoverable
      // deadline. Round/feedback/cycle survive the pause untouched.
      // G08-R1: a missing simTime is a protocol failure — never ?? 0.
      const simTime = session.options.world.getState().simTime;
      if (typeof simTime !== 'number' || !Number.isSafeInteger(simTime) || simTime < 0) {
        const step = withTransport({
          round,
          observation: structuredClone(observation),
          raw: decision.raw,
          parse,
        }, transport);
        session.steps.push(step);
        finishTerminal(session, 'invalid_run', 'invalid_run', 'timed_wait wait without a valid authoritative simTime');
        return { status: 'invalid_run', terminal: true, providerCalled: true, step };
      }
      const budgetTerminated = session.providerCalls >= MAX_PROVIDER_CALLS;
      const wakeAtSimTime = budgetTerminated ? null : simTime + WAIT_SIM_STEPS;
      const step = withTransport({
        round,
        observation: structuredClone(observation),
        raw: decision.raw,
        parse,
        wait: { wakeAtSimTime },
      }, transport);
      session.steps.push(step);
      session.feedback = { round, kind: 'accepted', detail: 'wait' };
      if (budgetTerminated) {
        finishTerminal(session, 'budget_exhausted', 'budget_exhausted');
        return { status: 'budget_exhausted', terminal: true, providerCalled: true, step };
      }
      session.status = 'waiting_time';
      session.wakeAtSimTime = wakeAtSimTime;
      session.resumedOnce = false;
      return { status: 'waiting_time', terminal: false, providerCalled: true, step };
    }

    const command = toCommand(session.commandIdFor(round), session.actorId, parse.action);
    const exec = structuredClone(session.options.world.submit(structuredClone(command)));
    const step = withTransport({
      round,
      observation: structuredClone(observation),
      raw: decision.raw,
      parse,
      command,
      exec,
    }, transport);
    if (exec.status === 'accepted') {
      session.feedback = { round, kind: 'accepted', detail: command.type };
    } else {
      const reason = exec.reason ?? exec.status;
      const detail = exec.detail ? `${exec.status} ${reason}: ${exec.detail}` : `${exec.status} ${reason}`;
      step.error = detail;
      session.feedback = exec.reason
        ? { round, kind: 'rejected', detail, reason: exec.reason }
        : { round, kind: 'rejected', detail };
    }
    session.steps.push(step);

    // G09: the yield action closes the protocol; fulfilment is judged from
    // the authoritative commands, never from the NPC's own hunger.
    if (yieldBound) {
      finishTerminal(session, 'stopped', 'selected_goal_yield');
      return { status: 'stopped', terminal: true, providerCalled: true, step };
    }
    const after = hungerOf(session.options.world.getState(), session.actorId);
    if (after !== undefined && after >= GOAL_HUNGER_AT_LEAST) {
      finishTerminal(session, 'goal_reached', 'goal_reached');
      return { status: 'goal_reached', terminal: true, providerCalled: true, step };
    }
    if (session.providerCalls >= MAX_PROVIDER_CALLS) {
      finishTerminal(session, 'budget_exhausted', 'budget_exhausted');
      return { status: 'budget_exhausted', terminal: true, providerCalled: true, step };
    }
    return { status: 'ready', terminal: false, providerCalled: true, step };
  } finally {
    session.phaseInfo = null;
    if (session.status === 'deciding') session.status = 'ready';
  }
}

export function createAgentSession(options: RunOptions): AgentSession {
  return new AgentSessionImpl(options);
}

/** At most one provider call. A second call while status is `deciding` returns `busy` and does not call the provider. */
export function stepAgent(session: AgentSession): Promise<StepAgentResult> {
  const impl = session as AgentSessionImpl;
  if (impl.status === 'deciding') {
    return Promise.resolve({ status: 'busy', terminal: false, providerCalled: false });
  }
  if (impl.status === 'waiting_time') {
    // G08: paused on logical time; stepping does not resume it.
    return Promise.resolve({ status: 'waiting_time', terminal: false, providerCalled: false });
  }
  if (impl.status !== 'ready') {
    return Promise.resolve({ status: impl.status, terminal: true, providerCalled: false });
  }
  impl.status = 'deciding';
  return executeStep(impl);
}

/**
 * observe → decide → parse → submit → feedback, up to MAX_PROVIDER_CALLS.
 * Same execution path as stepAgent. actorId is the caller's. commandId defaults to `${runId}:${round}`.
 * stop is not submitted. Success is authoritative hunger >= 70, never the model's stop token.
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const session = createAgentSession(options);
  while (session.status === 'ready') {
    const step = await stepAgent(session);
    if (step.status === 'busy') break;
  }
  return session.result();
}

/**
 * G06 checkpoint restore core: overwrites the mutable causal fields of an
 * existing session with values from a validated SessionCheckpoint. All
 * validation lives in agent/checkpoint.ts; this function assigns only.
 */
export function hydrateAgentSession(
  session: AgentSession,
  state: {
    round: number;
    feedback: StepFeedback | null;
    status: SessionStatus;
    providerCalls: number;
    steps: StepRecord[];
    terminalOutcome: RunOutcome | null;
    explicitError?: string;
    initialState: WorldState;
    eventsBefore: number;
    started: number;
    calls: { round: number; ms: number }[];
    /** G08: original wait deadline preserved verbatim; null unless waiting_time. */
    wakeAtSimTime?: number | null;
    /** G09: the binding restored verbatim; the session never chooses again. */
    goalBinding?: GoalBinding | null;
    goalDecision?: GoalDecisionRecord | null;
  },
): void {
  const impl = session as AgentSessionImpl;
  impl.round = state.round;
  impl.feedback = state.feedback;
  impl.status = state.status;
  impl.providerCalls = state.providerCalls;
  impl.wakeAtSimTime = state.status === 'waiting_time' ? (state.wakeAtSimTime ?? null) : null;
  impl.resumedOnce = false;
  impl.steps.length = 0;
  impl.steps.push(...state.steps);
  impl.terminalOutcome = state.terminalOutcome;
  if (state.explicitError !== undefined) impl.explicitError = state.explicitError;
  const mutable = impl as unknown as { initialState: WorldState; eventsBefore: number; started: number };
  mutable.initialState = state.initialState;
  mutable.eventsBefore = state.eventsBefore;
  mutable.started = state.started;
  if (state.goalBinding !== undefined) impl.goalBinding = state.goalBinding;
  if (state.goalDecision !== undefined) impl.goalDecision = state.goalDecision;
  impl.calls.length = 0;
  impl.calls.push(...state.calls);
}
