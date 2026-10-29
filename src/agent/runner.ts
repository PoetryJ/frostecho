import { WorldState } from '../types';
import {
  AgentAction, DecideInput, DEFAULT_TIMEOUT_MS, GOAL_HUNGER_AT_LEAST, MAX_PROVIDER_CALLS,
  Provider, RunOptions, RunOutcome, RunResult, StepFeedback, StepRecord, SubmittedCommand,
} from './contracts';
import { observe } from './observation';
import { parseAction } from './parser';

type CallResult =
  | { raw: string; ms: number }
  | { failure: 'timeout' | 'provider_error'; message: string; ms: number };

function hungerOf(state: WorldState, actorId: string): number | undefined {
  if (!Object.hasOwn(state.npcs, actorId)) return undefined;
  const npc = state.npcs[actorId];
  if (!npc || typeof npc !== 'object' || typeof npc.hunger !== 'number') return undefined;
  return npc.hunger;
}

function toCommand(runId: string, round: number, actorId: string, action: Exclude<AgentAction, { type: 'stop' }>): SubmittedCommand {
  const commandId = `${runId}:${round}`;
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
 */
async function takeDecision(provider: Provider, input: DecideInput, timeoutMs: number, now: () => number): Promise<CallResult> {
  const ac = new AbortController();
  const started = now();
  let timedOut = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      ac.abort();
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });
  const call = Promise.resolve().then(() => provider.decide(input, ac.signal));
  // A loser that rejects after race settles must not surface as an unhandled rejection.
  void call.then(() => undefined, () => undefined);
  void timeout.then(() => undefined, () => undefined);
  const elapsed = () => Math.max(0, now() - started);
  try {
    const raw = await Promise.race([call, timeout]);
    finished = true;
    if (timedOut || ac.signal.aborted) return { failure: 'timeout', message: 'timeout', ms: elapsed() };
    if (typeof raw !== 'string') return { failure: 'provider_error', message: 'provider returned non-string', ms: elapsed() };
    return { raw, ms: elapsed() };
  } catch (err) {
    finished = true;
    if (timedOut || ac.signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
      return { failure: 'timeout', message: 'timeout', ms: elapsed() };
    }
    return { failure: 'provider_error', message: publicError(err), ms: elapsed() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Deterministic view of a run. Timing is omitted on purpose. */
export function deterministicRecord(result: RunResult): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    runId: result.runId,
    actorId: result.actorId,
    outcome: result.outcome,
    goalReached: result.goalReached,
    providerCalls: result.providerCalls,
    steps: result.steps,
    initialState: result.initialState,
    events: result.events,
    finalState: result.finalState,
  };
  if (result.error !== undefined) rec.error = result.error;
  return rec;
}

/**
 * observe → decide → parse → submit → feedback, up to MAX_PROVIDER_CALLS.
 * actorId is the caller's. commandId is `${runId}:${round}`. stop is not submitted.
 * Success is authoritative hunger >= 70, never the model's stop token.
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { world, provider, actorId, runId } = options;
  const calls: { round: number; ms: number }[] = [];
  const steps: StepRecord[] = [];
  const initialState = structuredClone(world.getState());
  const eventsBefore = world.getEvents().length;

  const build = (outcome: RunOutcome, error?: string): RunResult => {
    const finalState = structuredClone(world.getState());
    const events = structuredClone(world.getEvents()).slice(eventsBefore);
    const hunger = hungerOf(finalState, actorId);
    const reached = hunger !== undefined && hunger >= GOAL_HUNGER_AT_LEAST;
    const resolved: RunOutcome = outcome !== 'invalid_run' && reached ? 'goal_reached' : outcome;
    const result: RunResult = {
      runId,
      actorId,
      outcome: resolved,
      goalReached: outcome === 'invalid_run' ? false : reached,
      providerCalls: calls.length,
      steps,
      initialState,
      events,
      finalState,
      timing: { totalMs: Math.max(0, now() - started), calls: calls.slice() },
    };
    if (error !== undefined) result.error = error;
    else if (resolved === 'budget_exhausted') result.error = 'provider call budget exhausted';
    return result;
  };

  if (typeof runId !== 'string' || runId.length === 0 || typeof actorId !== 'string' || actorId.length === 0) {
    return build('invalid_run', 'runId and actorId must be non-empty strings');
  }
  try {
    observe(initialState, actorId);
  } catch (err) {
    return build('invalid_run', err instanceof Error ? err.message : 'unknown actor');
  }

  let feedback: StepFeedback | null = null;
  for (let round = 1; round <= MAX_PROVIDER_CALLS; round++) {
    const state = structuredClone(world.getState());
    const hunger = hungerOf(state, actorId);
    if (hunger !== undefined && hunger >= GOAL_HUNGER_AT_LEAST) return build('goal_reached');

    const observation = observe(state, actorId);
    const input: DecideInput = {
      observation: structuredClone(observation),
      goal: { hungerAtLeast: GOAL_HUNGER_AT_LEAST },
      feedback: feedback ? { ...feedback } : null,
    };
    const decision = await takeDecision(provider, input, timeoutMs, now);
    calls.push({ round, ms: decision.ms });
    if ('failure' in decision) {
      steps.push({
        round,
        observation: structuredClone(observation),
        raw: '',
        parse: { ok: false, error: decision.failure },
        error: decision.message,
      });
      return build(decision.failure, decision.message);
    }

    const parse = parseAction(decision.raw);
    if (!parse.ok) {
      steps.push({
        round,
        observation: structuredClone(observation),
        raw: decision.raw,
        parse,
        error: parse.error,
      });
      feedback = { round, kind: 'invalid_output', detail: parse.error };
      continue;
    }
    if (parse.action.type === 'stop') {
      steps.push({ round, observation: structuredClone(observation), raw: decision.raw, parse });
      return build('stopped');
    }

    const command = toCommand(runId, round, actorId, parse.action);
    const exec = structuredClone(world.submit(structuredClone(command)));
    const step: StepRecord = {
      round,
      observation: structuredClone(observation),
      raw: decision.raw,
      parse,
      command,
      exec,
    };
    if (exec.status === 'accepted') {
      feedback = { round, kind: 'accepted', detail: command.type };
    } else {
      const reason = exec.reason ?? exec.status;
      const detail = exec.detail ? `${exec.status} ${reason}: ${exec.detail}` : `${exec.status} ${reason}`;
      step.error = detail;
      feedback = exec.reason
        ? { round, kind: 'rejected', detail, reason: exec.reason }
        : { round, kind: 'rejected', detail };
    }
    steps.push(step);
  }
  return build('budget_exhausted');
}
