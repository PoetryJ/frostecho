/**
 * G06 worker B — ReactiveGame checkpoint (schema frostecho.g06.checkpoint/1).
 *
 * Export: only at a decision boundary with no request in flight; a busy game
 * (or a session still deciding) is SAVE_BUSY. Restore: validate structure,
 * ranges, actor association and causal consistency first, then rebuild through
 * ReactiveGameImpl.restoreFromCheckpoint — never the fresh-game constructor,
 * so no new cycle is opened, no provider is called and no command is
 * submitted. Budgets, counters, rotation and lifecycle states come from the
 * data; runtime supplies providers/clock/timer only.
 */
import {
  G06_CHECKPOINT_SCHEMA,
  checkpointFail, checkpointOk,
  type GameCheckpoint, type GameRestoreRuntime, type Result,
} from '../persistence/contracts';
import { ReactiveGameImpl, CheckpointExportError } from './game';
import { G04_SCHEMA, G05_SCHEMA, type ReactiveActorState, type ReactiveGame } from './contracts';
import {
  G08_GAME_SCHEMA, ACTION_SETS,
  type ActionSet, type G08GameCheckpoint,
} from '../temporal/contracts';

const ACTOR_STATES: readonly ReactiveActorState[] = [
  'active', 'waiting', 'hungry', 'satisfied', 'stopped', 'failed', 'budget_exhausted',
];
/** G08 adds the non-terminal timed_wait actor state; the G06 set stays frozen. */
const ACTOR_STATES_G08: readonly ReactiveActorState[] = [...ACTOR_STATES, 'timed_wait'];

interface CheckpointSource {
  checkpointData(): GameCheckpoint;
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exportGameCheckpoint(game: unknown): Result<GameCheckpoint> {
  if (!isPlainObject(game) || typeof (game as unknown as CheckpointSource).checkpointData !== 'function') {
    return checkpointFail('INVALID_CHECKPOINT', 'object is not a checkpointable ReactiveGame');
  }
  let data: GameCheckpoint;
  try {
    data = (game as unknown as CheckpointSource).checkpointData();
  } catch (err) {
    if (err instanceof CheckpointExportError) return checkpointFail(err.code as 'SAVE_BUSY', ...err.issues);
    return checkpointFail('INVALID_CHECKPOINT', err instanceof Error ? err.message : String(err));
  }
  if (data.busy) {
    return checkpointFail('SAVE_BUSY', 'a decision is in flight; save at a decision boundary only');
  }
  return checkpointOk(data);
}

export function restoreNeedsGame(data: unknown, runtime: GameRestoreRuntime): Result<ReactiveGame> {
  if (!isPlainObject(data)) return checkpointFail('SCHEMA_MISMATCH', 'checkpoint must be a JSON object');
  const isG08 = data.schema === G08_GAME_SCHEMA;
  if (data.schema !== G06_CHECKPOINT_SCHEMA && !isG08) {
    return checkpointFail('SCHEMA_MISMATCH', `schema ${JSON.stringify(data.schema)} is not ${G06_CHECKPOINT_SCHEMA}`);
  }
  const actorStates = isG08 ? ACTOR_STATES_G08 : ACTOR_STATES;
  const d = data as unknown as GameCheckpoint;
  const g08d = isG08 ? data as unknown as G08GameCheckpoint : null;
  const issues: string[] = [];
  let g08ActionSet: ActionSet | undefined;
  if (g08d !== null) {
    if (g08d.actionSet === undefined || !ACTION_SETS.includes(g08d.actionSet)) {
      issues.push(`actionSet must be one of ${ACTION_SETS.join('|')}`);
    } else {
      g08ActionSet = g08d.actionSet;
    }
    if (g08d.recordSchema !== G08_GAME_SCHEMA) issues.push(`recordSchema ${JSON.stringify(g08d.recordSchema)} is not ${G08_GAME_SCHEMA}`);
    if (!isPlainObject(g08d.wakeAtSimTime)) {
      issues.push('wakeAtSimTime must be an object keyed by actor');
    } else {
      for (const actorId of Array.isArray(g08d.actorIds) ? g08d.actorIds : []) {
        const deadline = g08d.wakeAtSimTime[actorId];
        if (deadline !== null && !isNonNegInt(deadline)) {
          issues.push(`wakeAtSimTime[${actorId}] must be null or a non-negative integer`);
        }
      }
    }
  }
  if (typeof d.episodeId !== 'string' || d.episodeId.length === 0) issues.push('episodeId must be a non-empty string');
  if (!Array.isArray(d.actorIds) || d.actorIds.length === 0 || d.actorIds.some(a => typeof a !== 'string' || a.length === 0)) {
    issues.push('actorIds must be a non-empty string array');
  }
  const actorIds = Array.isArray(d.actorIds) ? d.actorIds : [];
  if (new Set(actorIds).size !== actorIds.length) issues.push('actorIds must not repeat');
  if (d.wakePolicy !== 'legacy' && d.wakePolicy !== 'event') issues.push(`unknown wakePolicy ${JSON.stringify(d.wakePolicy)}`);
  if (d.mode !== 'fixture' && d.mode !== 'live' && d.mode !== 'reference') issues.push(`unknown mode ${JSON.stringify(d.mode)}`);
  if (typeof d.thinking !== 'boolean') issues.push('thinking must be a boolean');
  if (d.actionThinking !== undefined && typeof d.actionThinking !== 'boolean') issues.push('actionThinking must be a boolean when present');
  if (d.needPolicy !== 'one-shot' && d.needPolicy !== 'recurring') issues.push('needPolicy must be one-shot or recurring');
  if (g08d === null && d.recordSchema !== G04_SCHEMA && d.recordSchema !== G05_SCHEMA) issues.push(`unknown recordSchema ${JSON.stringify(d.recordSchema)}`);
  if (d.requestModel !== null && typeof d.requestModel !== 'string') issues.push('requestModel must be a string or null');
  if (typeof d.timeoutMs !== 'number' || !Number.isFinite(d.timeoutMs) || d.timeoutMs <= 0) issues.push('timeoutMs must be positive');
  if (typeof d.startedAt !== 'number' || !Number.isFinite(d.startedAt)) issues.push('startedAt must be a number');
  if (!isPlainObject(d.engine) || d.engine.version !== 1) issues.push('engine must be a version-1 SaveData object');
  if (!isPlainObject(d.initialState) || !isPlainObject(d.initialState.npcs)) issues.push('initialState must contain npcs');
  if (!isPlainObject(d.states)) issues.push('states must be an object');
  if (!Array.isArray(d.transitions)) issues.push('transitions must be an array');
  if (!isNonNegInt(d.cursor) || d.cursor >= actorIds.length) issues.push('cursor must index actorIds');
  if (!isNonNegInt(d.globalTurn)) issues.push('globalTurn must be a non-negative integer');
  if (!isNonNegInt(d.playerSeq) || d.playerSeq < 1) issues.push('playerSeq must be a positive integer');
  if (!isNonNegInt(d.worldSeq) || d.worldSeq < 1) issues.push('worldSeq must be a positive integer');
  if (d.busy !== false) issues.push('busy must be false — a busy game cannot be restored from a torn save');
  if (typeof d.closed !== 'boolean' || typeof d.interrupted !== 'boolean') issues.push('closed/interrupted must be booleans');
  if (d.lastInterruptedActor !== null && (typeof d.lastInterruptedActor !== 'string' || !actorIds.includes(d.lastInterruptedActor))) {
    issues.push('lastInterruptedActor must be null or one of actorIds');
  }
  if (!isNonNegInt(d.totalCalls)) issues.push('totalCalls must be a non-negative integer');
  if (!isPlainObject(d.idlePumps) || !isNonNegInt(d.idlePumps.pumps)) issues.push('idlePumps must be an object with pumps');
  if (!isPlainObject(d.cycles)) issues.push('cycles must be an object');
  // G09 (optional): when present the negotiation state must be well-formed and
  // must agree with the saved ledger.
  if (d.goalMode !== undefined && d.goalMode !== 'legacy' && d.goalMode !== 'negotiated') {
    issues.push(`unknown goalMode ${JSON.stringify(d.goalMode)}`);
  }
  if (d.candidateSet !== undefined && d.candidateSet !== 'self_only' && d.candidateSet !== 'choice') {
    issues.push(`unknown candidateSet ${JSON.stringify(d.candidateSet)}`);
  }
  if (d.playerId !== undefined && (typeof d.playerId !== 'string' || d.playerId.length === 0)) {
    issues.push('playerId must be a non-empty string when present');
  }
  if (d.requestStore !== undefined) {
    if (!isPlainObject(d.requestStore) || !isPlainObject(d.requestStore.requests) || !Array.isArray(d.requestStore.processed)) {
      issues.push('requestStore must be a {requests, processed} store');
    }
    if (d.foldCursor !== undefined && !isNonNegInt(d.foldCursor)) issues.push('foldCursor must be a non-negative integer');
  }

  let sessionCalls = 0;
  if (isPlainObject(d.states)) {
    for (const actorId of actorIds) {
      const state = d.states[actorId];
      if (!actorStates.includes(state as ReactiveActorState)) issues.push(`states[${actorId}] is not a known lifecycle state`);
    }
    if (g08d !== null && isPlainObject(g08d.wakeAtSimTime)) {
      // The pause state and the deadline map must agree exactly.
      for (const actorId of actorIds) {
        const paused = d.states[actorId] === 'timed_wait';
        const deadline = g08d.wakeAtSimTime[actorId];
        if (paused && !isNonNegInt(deadline)) issues.push(`a timed_wait actor ${actorId} must carry a non-negative wakeAtSimTime`);
        if (!paused && deadline !== null && deadline !== undefined) issues.push(`wakeAtSimTime[${actorId}] must be null unless the actor is timed_wait`);
      }
    }
  }
  const logLength = isPlainObject(d.engine) && Array.isArray(d.engine.log) ? d.engine.log.length : null;
  if (isPlainObject(d.cycles)) {
    for (const actorId of actorIds) {
      const list = d.cycles[actorId];
      if (!Array.isArray(list) || list.length === 0) {
        issues.push(`cycles[${actorId}] must be a non-empty array`);
        continue;
      }
      list.forEach((cycle, index) => {
        const label = `cycles[${actorId}][${index}]`;
        if (!isPlainObject(cycle)) {
          issues.push(`${label} must be an object`);
          return;
        }
        if (cycle.cycle !== index + 1) issues.push(`${label}.cycle must be ${index + 1} (consecutive, never reset)`);
        if (typeof cycle.reason !== 'string') issues.push(`${label}.reason must be a string`);
        if (!isNonNegInt(cycle.startLogCursor) || (logLength !== null && cycle.startLogCursor > logLength)) {
          issues.push(`${label}.startLogCursor is outside the saved log`);
        }
        if (!actorStates.includes(cycle.endState as ReactiveActorState)) issues.push(`${label}.endState unknown`);
        if (!Array.isArray(cycle.turns)) issues.push(`${label}.turns must be an array`);
        const session = cycle.session;
        if (!isPlainObject(session)) {
          issues.push(`${label}.session must be an object`);
          return;
        }
        if (session.actorId !== actorId) issues.push(`${label}.session.actorId must be ${actorId}`);
        if (session.runId !== `${d.episodeId}:${actorId}:c${cycle.cycle}`) {
          issues.push(`${label}.session.runId must be ${d.episodeId}:${actorId}:c${cycle.cycle}`);
        }
        if (session.commandIdScheme !== 'g06-episode-cycle') issues.push(`${label}.session.commandIdScheme must be g06-episode-cycle`);
        if (isNonNegInt(session.providerCalls)) {
          sessionCalls += session.providerCalls;
          if (Array.isArray(cycle.turns) && cycle.turns.length < session.providerCalls) {
            issues.push(`${label}.turns shorter than the session's provider calls`);
          }
        } else {
          issues.push(`${label}.session.providerCalls must be a non-negative integer`);
        }
      });
    }
  }
  if (isNonNegInt(d.totalCalls) && sessionCalls !== d.totalCalls) {
    issues.push(`totalCalls ${d.totalCalls} does not equal the sum of session providerCalls ${sessionCalls}`);
  }

  /* ---------------------------------------------------------------- */
  /* G08-R1 cross-layer invariants (named failures, no half-restore)   */
  /* ---------------------------------------------------------------- */
  if (g08d !== null && isPlainObject(d.cycles)) {
    const actionSetIssues: string[] = [];
    const deadlineIssues: string[] = [];
    const stateIssues: string[] = [];
    const projected = isPlainObject(g08d.wakeAtSimTime) ? g08d.wakeAtSimTime : null;
    for (const actorId of actorIds) {
      const list = (d.cycles as Record<string, unknown>)[actorId];
      if (!Array.isArray(list) || list.length === 0) continue;
      const current = list[list.length - 1];
      const session = isPlainObject(current) && isPlainObject(current.session) ? current.session : null;
      const actorState = isPlainObject(d.states) ? (d.states as Record<string, unknown>)[actorId] : undefined;
      // Every G08 session carries the game's capability axis.
      if (session !== null && g08ActionSet !== undefined && session.actionSet !== g08ActionSet) {
        actionSetIssues.push(
          `cycles[${actorId}] session actionSet ${JSON.stringify(session.actionSet)} contradicts the game actionSet ${JSON.stringify(g08ActionSet)}`,
        );
      }
      const sessionDeadline = session !== null ? session.wakeAtSimTime : undefined;
      const gameDeadline = projected !== null ? projected[actorId] : undefined;
      if (actorState === 'timed_wait') {
        // A paused actor needs a waiting session and one agreeing deadline.
        if (session === null || session.status !== 'waiting_time') {
          stateIssues.push(`actor ${actorId} is timed_wait but its current session status is ${JSON.stringify(session?.status ?? null)}`);
        } else if (gameDeadline !== sessionDeadline) {
          deadlineIssues.push(
            `actor ${actorId} game deadline ${JSON.stringify(gameDeadline ?? null)} contradicts the session deadline ${JSON.stringify(sessionDeadline ?? null)}`,
          );
        }
      } else if (session !== null && session.status === 'waiting_time') {
        // Only a timed_wait actor may hold a waiting session (covers active
        // and terminal actors alike).
        stateIssues.push(`actor ${actorId} is ${JSON.stringify(actorState ?? null)} but its session is waiting_time`);
      }
    }
    // waiting_time exists only on the timed_wait axis — enforce at game level too.
    if (g08ActionSet === 'legacy' && projected !== null) {
      for (const actorId of actorIds) {
        if (projected[actorId] !== null && projected[actorId] !== undefined) {
          actionSetIssues.push(`legacy game carries a wake deadline for ${actorId} (wait is not in the legacy action set)`);
          break;
        }
      }
    }
    // The timed_wait axis is meaningless without an authoritative clock.
    if (g08ActionSet === 'timed_wait') {
      const simTime = isPlainObject(d.initialState) ? (d.initialState as Record<string, unknown>).simTime : undefined;
      if (typeof simTime !== 'number' || !Number.isSafeInteger(simTime) || simTime < 0) {
        return checkpointFail('MISSING_SIMTIME',
          `actionSet timed_wait requires a non-negative integer initialState.simTime, got ${JSON.stringify(simTime ?? null)}`);
      }
    }
    if (actionSetIssues.length > 0) {
      return checkpointFail('ACTION_SET_CONFLICT', ...actionSetIssues, ...deadlineIssues, ...stateIssues);
    }
    if (deadlineIssues.length > 0) {
      return checkpointFail('DEADLINE_CONFLICT', ...deadlineIssues, ...stateIssues);
    }
    if (stateIssues.length > 0) {
      return checkpointFail('SESSION_STATE_CONFLICT', ...stateIssues);
    }
  }

  if (issues.length > 0) return checkpointFail('INVALID_CHECKPOINT', ...issues);

  try {
    const game = ReactiveGameImpl.restoreFromCheckpoint(d, {
      episodeId: d.episodeId,
      actorIds: [...d.actorIds],
      initialState: d.initialState,
      wakePolicy: d.wakePolicy,
      mode: d.mode,
      thinking: d.thinking,
      ...(d.actionThinking !== undefined ? { actionThinking: d.actionThinking } : {}),
      needPolicy: d.needPolicy,
      schemaVersion: d.recordSchema,
      requestModel: d.requestModel ?? undefined,
      timeoutMs: d.timeoutMs,
      providerFor: runtime.providerFor,
      now: runtime.now,
      scheduleTimeout: runtime.scheduleTimeout,
      onDeciding: runtime.onDeciding,
      ...(g08ActionSet !== undefined ? { actionSet: g08ActionSet } : {}),
      // G09: the saved data wins inside restoreFromCheckpoint; the runtime
      // values are only a fallback for pre-G09 saves.
      ...(runtime.goalMode !== undefined ? { goalMode: runtime.goalMode } : {}),
      ...(runtime.candidateSet !== undefined ? { candidateSet: runtime.candidateSet } : {}),
      ...(runtime.playerId !== undefined ? { playerId: runtime.playerId } : {}),
      // G11-live: the external campaign budget gate is a RUNTIME dependency —
      // injected by the loader, never serialized into the checkpoint, so a
      // restored game re-consults the authoritative ledger on continuation.
      ...(runtime.externalBudget !== undefined ? { externalBudget: runtime.externalBudget } : {}),
    });
    return checkpointOk(game);
  } catch (err) {
    if (err instanceof CheckpointExportError) return checkpointFail('INVALID_CHECKPOINT', ...err.issues);
    return checkpointFail('INVALID_CHECKPOINT', err instanceof Error ? err.message : String(err));
  }
}
