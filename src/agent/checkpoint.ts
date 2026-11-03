/**
 * G06 worker A — AgentSession checkpoint (schema frostecho.g06.session/1).
 *
 * Export is only allowed at a decision boundary with no request in flight
 * (status 'deciding' → SAVE_BUSY) and only for a known command-id scheme (a
 * custom formula without a declared scheme is refused, never guessed). Restore
 * validates structure, ranges and causal consistency first and then rebuilds
 * the session from the data alone: runtime contributes only resources (world,
 * provider, clock, timer) — never round/feedback/budget/timeout — and it never
 * calls the provider, submits a command or resets anything.
 *
 * The default `${runId}:${round}` formula must not be silently re-derived for
 * a G06 session: the saved scheme is checked against the injected
 * commandIdFor, so a mismatched formula is rejected at restore time.
 */
import {
  G06_SESSION_SCHEMA,
  checkpointFail, checkpointOk,
  type Result, type SessionCheckpoint, type SessionRestoreRuntime,
} from '../persistence/contracts';
import {
  G08_SESSION_SCHEMA, ACTION_SETS,
  type ActionSet, type G08SessionCheckpoint,
} from '../temporal/contracts';
import {
  createAgentSession, hydrateAgentSession,
} from './runner';
import {
  MAX_PROVIDER_CALLS,
  type AgentSession, type RunOutcome, type SessionStatus, type StepFeedback,
} from './contracts';
import type { WorldState } from '../types';

/** Internal fields the export reads (AgentSessionImpl shape, duck-typed). */
interface SessionInternals extends AgentSession {
  readonly timeoutMs: number;
  readonly started: number;
  readonly calls: readonly { round: number; ms: number }[];
  terminalOutcome: RunOutcome | null;
  explicitError?: string;
  readonly initialState: WorldState;
  readonly eventsBefore: number;
}

const SESSION_STATUSES: readonly SessionStatus[] = [
  'ready', 'deciding', 'goal_reached', 'stopped', 'budget_exhausted', 'timeout', 'provider_error', 'invalid_run',
];
/** G08 adds the non-terminal pause status; the legacy set stays frozen. */
const SESSION_STATUSES_G08: readonly SessionStatus[] = [...SESSION_STATUSES, 'waiting_time'];
const RUN_OUTCOMES: readonly RunOutcome[] = [
  'goal_reached', 'stopped', 'budget_exhausted', 'timeout', 'provider_error', 'invalid_run',
];
const FEEDBACK_KINDS: readonly StepFeedback['kind'][] = ['accepted', 'rejected', 'invalid_output'];

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateFeedback(value: unknown, providerCalls: number, issues: string[]): void {
  if (value === null) return;
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    issues.push('feedback must be null or an object');
    return;
  }
  const f = value as Partial<StepFeedback>;
  if (!isNonNegInt(f.round) || f.round < 1 || f.round > Math.max(1, providerCalls)) {
    issues.push('feedback.round must be a positive integer within the recorded calls');
  }
  if (!FEEDBACK_KINDS.includes(f.kind as StepFeedback['kind'])) {
    issues.push(`feedback.kind must be one of ${FEEDBACK_KINDS.join('|')}`);
  }
  if (typeof f.detail !== 'string') issues.push('feedback.detail must be a string');
  if (f.reason !== undefined && typeof f.reason !== 'string') issues.push('feedback.reason must be a string when present');
}

/** `${episodeId}:${actorId}:c${cycle}` → {episodeId, cycle} or null. */
export function parseG06RunId(runId: string, actorId: string): { episodeId: string; cycle: number } | null {
  const suffix = `:${actorId}:c`;
  const idx = runId.lastIndexOf(suffix);
  if (idx <= 0) return null;
  const episodeId = runId.slice(0, idx);
  const cycleText = runId.slice(idx + suffix.length);
  if (!/^[1-9][0-9]*$/.test(cycleText)) return null;
  return { episodeId, cycle: Number(cycleText) };
}

export function exportSessionCheckpoint(
  session: AgentSession,
  format: 'g06' | 'g08' = 'g06',
): Result<SessionCheckpoint | G08SessionCheckpoint> {
  if (session.status === 'deciding') {
    return checkpointFail('SAVE_BUSY', 'session is deciding; checkpoint at a decision boundary only');
  }
  if (session.commandIdScheme === 'unknown') {
    return checkpointFail('INVALID_CHECKPOINT', 'session uses a custom commandId formula without a declared scheme; refusing to checkpoint');
  }
  const impl = session as SessionInternals;
  const base = {
    runId: impl.runId,
    actorId: impl.actorId,
    round: impl.round,
    feedback: impl.feedback === null ? null : structuredClone(impl.feedback),
    status: impl.status,
    providerCalls: impl.providerCalls,
    steps: structuredClone([...impl.steps]) as SessionCheckpoint['steps'],
    timeoutMs: impl.timeoutMs,
    commandIdScheme: impl.commandIdScheme as SessionCheckpoint['commandIdScheme'],
    timing: { started: impl.started, calls: impl.calls.map(c => ({ round: c.round, ms: c.ms })) },
    terminalOutcome: impl.terminalOutcome,
    ...(impl.explicitError !== undefined ? { explicitError: impl.explicitError } : {}),
    initialState: structuredClone(impl.initialState),
    eventsBefore: impl.eventsBefore,
  };
  if (format === 'g08') {
    // G08: every group (legacy included) saves the capability axis and the
    // wait deadline verbatim, so a paused session restores recoverable.
    return checkpointOk({
      ...base,
      schema: G08_SESSION_SCHEMA,
      actionSet: impl.actionSet,
      wakeAtSimTime: impl.status === 'waiting_time' ? impl.wakeAtSimTime : null,
    } as G08SessionCheckpoint);
  }
  return checkpointOk({ ...base, schema: G06_SESSION_SCHEMA });
}

export function restoreAgentSession(data: unknown, runtime: SessionRestoreRuntime): Result<AgentSession> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return checkpointFail('SCHEMA_MISMATCH', 'session checkpoint must be a JSON object');
  }
  const d = data as Partial<SessionCheckpoint> & Partial<G08SessionCheckpoint>;
  const isG08 = d.schema === G08_SESSION_SCHEMA;
  if (d.schema !== G06_SESSION_SCHEMA && !isG08) {
    return checkpointFail('SCHEMA_MISMATCH', `schema ${JSON.stringify(d.schema)} is not ${G06_SESSION_SCHEMA}`);
  }
  const issues: string[] = [];
  let actionSet: ActionSet | undefined;
  let wakeAtSimTime: number | null = null;
  if (isG08) {
    if (d.actionSet === undefined || !ACTION_SETS.includes(d.actionSet)) {
      issues.push(`actionSet must be one of ${ACTION_SETS.join('|')}`);
    } else {
      actionSet = d.actionSet;
    }
    if (d.status === 'waiting_time') {
      if (!isNonNegInt(d.wakeAtSimTime)) {
        issues.push('a waiting_time session must carry a non-negative integer wakeAtSimTime');
      } else {
        wakeAtSimTime = d.wakeAtSimTime;
      }
    } else if (d.wakeAtSimTime !== null && d.wakeAtSimTime !== undefined) {
      issues.push('wakeAtSimTime must be null unless the status is waiting_time');
    }
  }
  if (typeof d.runId !== 'string' || d.runId.length === 0) issues.push('runId must be a non-empty string');
  if (typeof d.actorId !== 'string' || d.actorId.length === 0) issues.push('actorId must be a non-empty string');
  if (!isNonNegInt(d.round)) issues.push('round must be a non-negative integer');
  if (!isNonNegInt(d.providerCalls) || d.providerCalls > MAX_PROVIDER_CALLS) {
    issues.push(`providerCalls must be an integer in [0, ${MAX_PROVIDER_CALLS}]`);
  }
  if (!(isG08 ? SESSION_STATUSES_G08 : SESSION_STATUSES).includes(d.status as SessionStatus)) {
    issues.push(`unknown status ${JSON.stringify(d.status)}`);
  }
  else if (d.status === 'deciding') issues.push("status 'deciding' can never be serialized");
  if (d.terminalOutcome !== null && d.terminalOutcome !== undefined) {
    if (!RUN_OUTCOMES.includes(d.terminalOutcome)) issues.push(`unknown terminalOutcome ${JSON.stringify(d.terminalOutcome)}`);
  }
  if (d.terminalOutcome === undefined) issues.push('terminalOutcome must be present (null allowed)');
  if (d.commandIdScheme !== 'run-round' && d.commandIdScheme !== 'g06-episode-cycle') {
    issues.push(`commandIdScheme must be 'run-round' or 'g06-episode-cycle'`);
  }
  if (typeof d.timeoutMs !== 'number' || !Number.isFinite(d.timeoutMs) || d.timeoutMs <= 0) {
    issues.push('timeoutMs must be a positive number');
  }
  if (!isNonNegInt(d.eventsBefore)) issues.push('eventsBefore must be a non-negative integer');
  if (d.explicitError !== undefined && typeof d.explicitError !== 'string') issues.push('explicitError must be a string when present');
  if (d.steps !== undefined && !Array.isArray(d.steps)) issues.push('steps must be an array');
  if (Array.isArray(d.steps)) {
    if (d.steps.length !== d.providerCalls) issues.push(`steps length ${d.steps.length} must equal providerCalls ${String(d.providerCalls)}`);
    d.steps.forEach((step, i) => {
      if (step === null || typeof step !== 'object' || step.round !== i + 1) {
        issues.push(`steps[${i}].round must be ${i + 1}`);
      }
    });
  }
  validateFeedback(d.feedback, d.providerCalls ?? 0, issues);
  const timing = d.timing;
  if (timing === null || typeof timing !== 'object' || Array.isArray(timing)
    || typeof timing.started !== 'number' || !Array.isArray(timing.calls)
    || timing.calls.some(c => c === null || typeof c !== 'object' || !isNonNegInt(c.round) || typeof c.ms !== 'number')) {
    issues.push('timing must be {started: number, calls: [{round, ms}]}');
  }
  const initial = d.initialState;
  if (initial === null || typeof initial !== 'object' || Array.isArray(initial)
    || initial.npcs === null || typeof initial.npcs !== 'object' || Array.isArray(initial.npcs)
    || typeof d.actorId !== 'string'
    || !((initial.npcs as Record<string, unknown>)[d.actorId] !== undefined)) {
    issues.push('initialState must contain npcs[actorId]');
  }
  if (issues.length > 0) return checkpointFail('INVALID_CHECKPOINT', ...issues);

  // From here on the data is well-formed; cast once.
  const checkpoint = d as SessionCheckpoint;

  // Command-id formula consistency: the saved scheme decides the expected id
  // shape, so a restored default `${runId}:${round}` cannot masquerade as a
  // G06 episode-cycle session (or vice versa).
  const nextRound = Math.max(checkpoint.round, checkpoint.providerCalls + 1, 1);
  let expectedId: string;
  if (checkpoint.commandIdScheme === 'run-round') {
    expectedId = `${checkpoint.runId}:${nextRound}`;
  } else {
    const parsed = parseG06RunId(checkpoint.runId, checkpoint.actorId);
    if (parsed === null) {
      return checkpointFail('INVALID_CHECKPOINT', `runId ${checkpoint.runId} does not match the g06-episode-cycle scheme`);
    }
    expectedId = `${parsed.episodeId}:npc:${checkpoint.actorId}:${parsed.cycle}:${nextRound}`;
  }
  const injectedId = runtime.commandIdFor(nextRound);
  if (injectedId !== expectedId) {
    return checkpointFail(
      'INVALID_CHECKPOINT',
      `commandIdFor(${nextRound}) produced '${injectedId}' but the saved scheme '${checkpoint.commandIdScheme}' requires '${expectedId}'`,
    );
  }

  const session = createAgentSession({
    world: runtime.world,
    provider: runtime.provider,
    runId: checkpoint.runId,
    actorId: checkpoint.actorId,
    timeoutMs: checkpoint.timeoutMs,
    now: runtime.now,
    scheduleTimeout: runtime.scheduleTimeout,
    commandIdFor: runtime.commandIdFor,
    commandIdScheme: checkpoint.commandIdScheme,
    ...(actionSet !== undefined ? { actionSet } : {}),
  });
  if (session.status === 'invalid_run') {
    return checkpointFail('INVALID_CHECKPOINT', `actor ${checkpoint.actorId} is not present in the restored world`);
  }
  hydrateAgentSession(session, {
    round: checkpoint.round,
    feedback: checkpoint.feedback === null ? null : structuredClone(checkpoint.feedback),
    status: checkpoint.status,
    providerCalls: checkpoint.providerCalls,
    steps: structuredClone(checkpoint.steps) as SessionCheckpoint['steps'],
    terminalOutcome: checkpoint.terminalOutcome,
    ...(checkpoint.explicitError !== undefined ? { explicitError: checkpoint.explicitError } : {}),
    initialState: structuredClone(checkpoint.initialState),
    eventsBefore: checkpoint.eventsBefore,
    started: checkpoint.timing.started,
    calls: checkpoint.timing.calls.map(c => ({ round: c.round, ms: c.ms })),
    ...(isG08 ? { wakeAtSimTime } : {}),
  });
  return checkpointOk(session);
}
