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

const ACTOR_STATES: readonly ReactiveActorState[] = [
  'active', 'waiting', 'hungry', 'satisfied', 'stopped', 'failed', 'budget_exhausted',
];

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
  if (data.schema !== G06_CHECKPOINT_SCHEMA) {
    return checkpointFail('SCHEMA_MISMATCH', `schema ${JSON.stringify(data.schema)} is not ${G06_CHECKPOINT_SCHEMA}`);
  }
  const d = data as unknown as GameCheckpoint;
  const issues: string[] = [];
  if (typeof d.episodeId !== 'string' || d.episodeId.length === 0) issues.push('episodeId must be a non-empty string');
  if (!Array.isArray(d.actorIds) || d.actorIds.length === 0 || d.actorIds.some(a => typeof a !== 'string' || a.length === 0)) {
    issues.push('actorIds must be a non-empty string array');
  }
  const actorIds = Array.isArray(d.actorIds) ? d.actorIds : [];
  if (new Set(actorIds).size !== actorIds.length) issues.push('actorIds must not repeat');
  if (d.wakePolicy !== 'legacy' && d.wakePolicy !== 'event') issues.push(`unknown wakePolicy ${JSON.stringify(d.wakePolicy)}`);
  if (d.mode !== 'fixture' && d.mode !== 'live' && d.mode !== 'reference') issues.push(`unknown mode ${JSON.stringify(d.mode)}`);
  if (typeof d.thinking !== 'boolean') issues.push('thinking must be a boolean');
  if (d.needPolicy !== 'one-shot' && d.needPolicy !== 'recurring') issues.push('needPolicy must be one-shot or recurring');
  if (d.recordSchema !== G04_SCHEMA && d.recordSchema !== G05_SCHEMA) issues.push(`unknown recordSchema ${JSON.stringify(d.recordSchema)}`);
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

  let sessionCalls = 0;
  if (isPlainObject(d.states)) {
    for (const actorId of actorIds) {
      const state = d.states[actorId];
      if (!ACTOR_STATES.includes(state as ReactiveActorState)) issues.push(`states[${actorId}] is not a known lifecycle state`);
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
        if (!ACTOR_STATES.includes(cycle.endState as ReactiveActorState)) issues.push(`${label}.endState unknown`);
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
  if (issues.length > 0) return checkpointFail('INVALID_CHECKPOINT', ...issues);

  try {
    const game = ReactiveGameImpl.restoreFromCheckpoint(d, {
      episodeId: d.episodeId,
      actorIds: [...d.actorIds],
      initialState: d.initialState,
      wakePolicy: d.wakePolicy,
      mode: d.mode,
      thinking: d.thinking,
      needPolicy: d.needPolicy,
      schemaVersion: d.recordSchema,
      requestModel: d.requestModel ?? undefined,
      timeoutMs: d.timeoutMs,
      providerFor: runtime.providerFor,
      now: runtime.now,
      scheduleTimeout: runtime.scheduleTimeout,
      onDeciding: runtime.onDeciding,
    });
    return checkpointOk(game);
  } catch (err) {
    if (err instanceof CheckpointExportError) return checkpointFail('INVALID_CHECKPOINT', ...err.issues);
    return checkpointFail('INVALID_CHECKPOINT', err instanceof Error ? err.message : String(err));
  }
}
