import { WorldState } from '../types';
import {
  AgentAction, AgentSession, DecideInput, DecidingPhase, DEFAULT_TIMEOUT_MS, GOAL_HUNGER_AT_LEAST, MAX_PROVIDER_CALLS,
  Provider, RunOptions, RunOutcome, RunResult, SessionStatus, StepAgentResult, StepFeedback, StepRecord,
  SubmittedCommand,
} from './contracts';
import { observe } from './observation';
import { parseAction } from './parser';

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

function toCommand(commandId: string, actorId: string, action: Exclude<AgentAction, { type: 'stop' }>): SubmittedCommand {
  if (action.type === 'move') return { commandId, actorId, type: 'move', payload: { to: action.to } };
  return { commandId, actorId, type: 'eat', payload: {} };
}

function publicError(err: unknown): string {
  if (err instanceof Error && err.name === 'ProviderTransportError') return err.message;
  return 'provider error';
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
  terminalOutcome: RunOutcome | null = null;
  explicitError?: string;
  phaseInfo: DecidingPhase | null = null;
  readonly waiters: ((info: DecidingPhase) => void)[] = [];

  constructor(options: RunOptions) {
    this.options = options;
    this.runId = options.runId;
    this.actorId = options.actorId;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.started = this.now();
    this.initialState = structuredClone(options.world.getState());
    this.eventsBefore = options.world.getEvents().length;
    this.onDeciding = options.onDeciding;
    this.commandIdFor = options.commandIdFor ?? ((round: number) => `${options.runId}:${round}`);
    if (typeof this.runId !== 'string' || this.runId.length === 0 || typeof this.actorId !== 'string' || this.actorId.length === 0) {
      this.failInvalid('runId and actorId must be non-empty strings');
      return;
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

  result(): RunResult {
    const finalState = structuredClone(this.options.world.getState());
    const events = structuredClone(this.options.world.getEvents()).slice(this.eventsBefore);
    const hunger = hungerOf(finalState, this.actorId);
    const reached = hunger !== undefined && hunger >= GOAL_HUNGER_AT_LEAST;
    const outcome: RunOutcome = this.terminalOutcome ?? (reached ? 'goal_reached' : 'stopped');
    const resolved: RunOutcome = outcome !== 'invalid_run' && reached ? 'goal_reached' : outcome;
    const result: RunResult = {
      runId: this.runId,
      actorId: this.actorId,
      outcome: resolved,
      goalReached: outcome === 'invalid_run' ? false : reached,
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
    if (hunger !== undefined && hunger >= GOAL_HUNGER_AT_LEAST) {
      finishTerminal(session, 'goal_reached', 'goal_reached');
      return { status: 'goal_reached', terminal: true, providerCalled: false };
    }
    if (session.providerCalls >= MAX_PROVIDER_CALLS) {
      finishTerminal(session, 'budget_exhausted', 'budget_exhausted');
      return { status: 'budget_exhausted', terminal: true, providerCalled: false };
    }

    const round = session.providerCalls + 1;
    session.round = round;
    const observation = observe(state, session.actorId);
    const phase: DecidingPhase = { round, observation: structuredClone(observation) };
    session.phaseInfo = phase;
    const waiters = session.waiters.splice(0, session.waiters.length);
    for (const waiter of waiters) waiter(phase);

    const input: DecideInput = {
      observation: structuredClone(observation),
      goal: { hungerAtLeast: GOAL_HUNGER_AT_LEAST },
      feedback: session.feedback ? { ...session.feedback } : null,
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
        error: decision.message,
      }, transport);
      session.steps.push(step);
      const status: SessionStatus = decision.failure === 'timeout' ? 'timeout' : 'provider_error';
      finishTerminal(session, status, decision.failure, decision.message);
      return { status, terminal: true, providerCalled: true, step };
    }

    const parse = parseAction(decision.raw);
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
