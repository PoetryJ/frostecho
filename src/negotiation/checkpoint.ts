/**
 * G09-R1 worker C — the goal-choice save slot (`<slot>.g09.json`, v2).
 *
 * The envelope carries the AUTHORITATIVE negotiation state (the game-level
 * request store with processed ids, the phase and the bindings) plus the G08
 * game checkpoint and the SAVED effective configuration. Restore is pure data:
 * zero provider calls, zero Engine.submit, no re-choice, no re-issue.
 */
import { resolve as resolvePath } from 'node:path';
import { readSlot, slotPath, writeExclusiveSlot } from '../persistence/atomic-slot';
import type { MessageResult } from '../communication/contracts';
import { messageFail, messageOk } from '../communication/contracts';
import { exportGameCheckpoint, restoreNeedsGame } from '../reactive/checkpoint';
import type { ReactiveGame } from '../reactive/contracts';
import type { G08CheckpointRuntime, G08EffectiveConfig, G08GameCheckpoint } from '../temporal/contracts';
import { effectiveConfigIssues, effectiveConfigMatchesRecord } from '../temporal/checkpoint';
import {
  G09_CHECKPOINT_SCHEMA, G09_CHECKPOINT_SCHEMA_V2, GOAL_ARMS, G09_SATIETY_LEVELS,
  type GoalArm, type GoalBinding, type SatietyLevel,
} from './contracts';
import { validateGoalRequestSnapshot, type GoalRequestStore } from './requests';
import { bindingIssues } from './goal-check';

export const G09_FILE_SUFFIX = '.g09.json';

export interface G09Checkpoint {
  schema: typeof G09_CHECKPOINT_SCHEMA;
  arm: GoalArm;
  satiety: SatietyLevel;
  /** The game-level request store: the single authority for request lifecycle. */
  requests: GoalRequestStore;
  /** The active binding, or null while the goal phase has not decided. */
  binding: GoalBinding | null;
  effectiveConfig: G08EffectiveConfig;
  game: G08GameCheckpoint;
  savedAtUtc: string;
  /** G10 (v3): the game mode the slot was saved with; v2 slots are negotiated. */
  goalMode?: 'legacy' | 'negotiated';
  /** G10 (v3): application metadata (providerKind/fixtureId/...). Never a secret. */
  app?: Record<string, unknown>;
}

export interface G09SnapshotState {
  arm: GoalArm;
  satiety: SatietyLevel;
  requests: GoalRequestStore;
  binding: GoalBinding | null;
  /** G10: metadata written into the v3 envelope (absent for R1/R2 callers). */
  goalMode?: 'legacy' | 'negotiated';
  app?: Record<string, unknown>;
}

export interface LoadedG09Checkpoint { path: string; envelope: G09Checkpoint }

export function g09CheckpointPath(root: string, slot: string): string {
  return slotPath(root, slot, G09_FILE_SUFFIX);
}

export function validateG09Checkpoint(value: unknown, schema: string = G09_CHECKPOINT_SCHEMA): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['envelope must be an object'];
  const envelope = value as Partial<G09Checkpoint>;
  const issues: string[] = [];
  if (envelope.schema !== schema) issues.push(`schema must be ${schema}`);
  if (!GOAL_ARMS.includes(envelope.arm as GoalArm)) issues.push(`unknown arm ${JSON.stringify(envelope.arm)}`);
  if (!(G09_SATIETY_LEVELS as readonly number[]).includes(envelope.satiety as number)) issues.push(`unknown satiety ${JSON.stringify(envelope.satiety)}`);
  const store = envelope.requests;
  if (store === null || typeof store !== 'object' || typeof store.requests !== 'object' || !Array.isArray(store.processed)) {
    issues.push('requests must be a {requests, processed} store');
  } else {
    for (const [id, request] of Object.entries(store.requests)) {
      const validated = validateGoalRequestSnapshot(request);
      if (!validated.ok) issues.push(`request ${id}: ${validated.issues.join('; ')}`);
    }
    if (envelope.binding !== null && envelope.binding !== undefined) {
      const request = store.requests[envelope.binding.requestId];
      if (request === undefined) issues.push('the binding names a request the store does not hold');
      else {
        issues.push(...bindingIssues(envelope.binding, request));
        if (!store.processed.includes(envelope.binding.requestId)) issues.push('a bound request must be marked processed');
      }
    }
  }
  issues.push(...effectiveConfigIssues(envelope.effectiveConfig));
  if (envelope.game === null || typeof envelope.game !== 'object') issues.push('game must be an object');
  if (envelope.goalMode !== undefined && envelope.goalMode !== 'legacy' && envelope.goalMode !== 'negotiated') {
    issues.push(`unknown goalMode ${JSON.stringify(envelope.goalMode)}`);
  }
  return issues;
}

export type DetailedSaveCode =
  | 'OK' | 'QUEUE_FULL' | 'EXISTS' | 'INVALID_SLOT' | 'SCHEMA_MISMATCH'
  | 'INVALID_SNAPSHOT' | 'IO_ERROR' | 'INVALID_COMMAND';

export interface DetailedSaveResult {
  ok: boolean;
  path: string | null;
  code: DetailedSaveCode;
  issues: string[];
}

/**
 * G10-R1: the same save, but the slot layer's original code is preserved
 * (EXISTS / INVALID_SLOT / IO_ERROR / QUEUE_FULL). The user-actionable
 * refusals and a durable write failure must never collapse into one code.
 */
export function saveG09CheckpointDetailed(
  root: string,
  slot: string,
  game: unknown,
  state: G09SnapshotState,
  effectiveConfig: G08EffectiveConfig,
): DetailedSaveResult {
  const configIssues = effectiveConfigIssues(effectiveConfig);
  if (configIssues.length > 0) return { ok: false, path: null, code: 'INVALID_COMMAND', issues: [...configIssues] };
  if (!GOAL_ARMS.includes(state.arm)) return { ok: false, path: null, code: 'INVALID_COMMAND', issues: [`unknown arm ${JSON.stringify(state.arm)}`] };
  if (!(G09_SATIETY_LEVELS as readonly number[]).includes(state.satiety)) {
    return { ok: false, path: null, code: 'INVALID_COMMAND', issues: [`unknown satiety ${JSON.stringify(state.satiety)}`] };
  }
  for (const [id, request] of Object.entries(state.requests.requests)) {
    const validated = validateGoalRequestSnapshot(request);
    if (!validated.ok) return { ok: false, path: null, code: 'INVALID_SNAPSHOT', issues: [`request ${id}: ${validated.issues.join('; ')}`] };
  }
  if (state.binding !== null) {
    const request = state.requests.requests[state.binding.requestId];
    if (request === undefined) return { ok: false, path: null, code: 'INVALID_SNAPSHOT', issues: ['the binding names an unknown request'] };
    const issues = bindingIssues(state.binding, request);
    if (issues.length > 0) return { ok: false, path: null, code: 'INVALID_SNAPSHOT', issues: [...issues] };
  }
  const exported = exportGameCheckpoint(game);
  if (!exported.ok) {
    if (exported.code === 'SAVE_BUSY') return { ok: false, path: null, code: 'QUEUE_FULL', issues: ['a decision is in flight; save at a decision boundary only'] };
    return { ok: false, path: null, code: exported.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', issues: exported.issues ?? [] };
  }
  if (!effectiveConfigMatchesRecord(effectiveConfig, exported.value)) {
    return { ok: false, path: null, code: 'INVALID_COMMAND', issues: ['the effectiveConfig disagrees with the game record; the game was built with a different runtime'] };
  }
  const envelope: G09Checkpoint = {
    schema: G09_CHECKPOINT_SCHEMA,
    arm: state.arm,
    satiety: state.satiety,
    requests: state.requests,
    binding: state.binding,
    effectiveConfig,
    game: exported.value as unknown as G08GameCheckpoint,
    savedAtUtc: new Date().toISOString(),
    goalMode: state.goalMode ?? 'negotiated',
    ...(state.app === undefined ? {} : { app: state.app }),
  };
  const written = writeExclusiveSlot(root, slot, G09_FILE_SUFFIX, G09_CHECKPOINT_SCHEMA, envelope);
  if (!written.ok) {
    const code: DetailedSaveCode = written.code === 'CHECKSUM_MISMATCH'
      ? 'INVALID_SNAPSHOT'
      : written.code as DetailedSaveCode;
    return { ok: false, path: null, code, issues: written.issues ?? [] };
  }
  return { ok: true, path: written.value.path, code: 'OK', issues: [] };
}

/** MessageResult facade kept for every existing G09 caller. */
export function saveG09Checkpoint(
  root: string,
  slot: string,
  game: unknown,
  state: G09SnapshotState,
  effectiveConfig: G08EffectiveConfig,
): MessageResult<{ path: string }> {
  const detailed = saveG09CheckpointDetailed(root, slot, game, state, effectiveConfig);
  if (detailed.ok) return messageOk({ path: detailed.path! });
  if (detailed.code === 'QUEUE_FULL') return messageFail('QUEUE_FULL', ...detailed.issues);
  if (detailed.code === 'INVALID_COMMAND') return messageFail('INVALID_COMMAND', ...detailed.issues);
  if (detailed.code === 'SCHEMA_MISMATCH') return messageFail('SCHEMA_MISMATCH', ...detailed.issues);
  return messageFail('INVALID_SNAPSHOT', ...detailed.issues);
}


export function loadG09Checkpoint(path: string): MessageResult<LoadedG09Checkpoint> {
  const absolute = resolvePath(path);
  // v3 is the current writer; v2 slots stay readable (goalMode defaults to
  // negotiated) so R1/R2 evidence and play slots are not invalidated.
  let schema = G09_CHECKPOINT_SCHEMA;
  let read = readSlot<G09Checkpoint>(absolute, schema);
  if (!read.ok && read.code === 'SCHEMA_MISMATCH') {
    schema = G09_CHECKPOINT_SCHEMA_V2;
    read = readSlot<G09Checkpoint>(absolute, schema);
  }
  if (!read.ok) return messageFail(read.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(read.issues ?? []));
  const issues = validateG09Checkpoint(read.value, schema);
  if (issues.length > 0) return messageFail('SCHEMA_MISMATCH', ...issues);
  return messageOk({ path: absolute, envelope: read.value });
}

export interface G09RestoreRuntime extends Omit<G08CheckpointRuntime, 'actionSet' | 'messageMode'> {
  playerId?: string;
}

/**
 * Rebuild the game from the envelope. Sessions restore in their own phase with
 * their own binding: no provider call, no goal choice, no re-delivery. The
 * envelope store and every session must agree on the request state.
 */
export function restoreG09Game(
  loaded: LoadedG09Checkpoint,
  runtime: G09RestoreRuntime,
): MessageResult<{ game: ReactiveGame; store: GoalRequestStore; binding: GoalBinding | null }> {
  const envelope = loaded.envelope;
  if (!effectiveConfigMatchesRecord(envelope.effectiveConfig, envelope.game)) {
    return messageFail('SCHEMA_MISMATCH', 'the game record effective configuration disagrees with the envelope effectiveConfig');
  }
  const restored = restoreNeedsGame(envelope.game, {
    ...runtime,
    actionSet: 'timed_wait',
    messageMode: 'off',
    goalMode: envelope.goalMode ?? 'negotiated',
    candidateSet: envelope.arm,
    playerId: runtime.playerId ?? 'npc_b',
  } as never);
  if (!restored.ok) {
    return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  }
  const game = restored.value;
  const sessions = (game as unknown as { sessionsOf?: () => { session: { goalBinding: GoalBinding | null; providerCalls: number } }[] }).sessionsOf?.() ?? [];
  for (const entry of sessions) {
    if (entry.session.goalBinding !== null && envelope.binding !== null) {
      if (entry.session.goalBinding.goal !== envelope.binding.goal
        || entry.session.goalBinding.raw !== envelope.binding.raw
        || entry.session.goalBinding.decidedRound !== envelope.binding.decidedRound) {
        return messageFail('SCHEMA_MISMATCH', 'a restored session binding disagrees with the envelope binding');
      }
    }
    if (entry.session.goalBinding !== null && envelope.binding === null) {
      return messageFail('SCHEMA_MISMATCH', 'a restored session holds a binding the envelope does not');
    }
  }
  // The envelope store is the restored game's store (single authority). A
  // G09 game checkpoint carries it; a pre-G09 slot is adopted verbatim.
  let gameStore = (game as unknown as { goalRequests?: () => GoalRequestStore }).goalRequests?.();
  if (gameStore === undefined || Object.keys(gameStore.requests).length === 0) {
    (game as unknown as { requestStore: GoalRequestStore }).requestStore = {
      requests: JSON.parse(JSON.stringify(envelope.requests.requests)) as GoalRequestStore['requests'],
      processed: [...envelope.requests.processed],
    };
    gameStore = (game as unknown as { requestStore: GoalRequestStore }).requestStore;
  }
  if (JSON.stringify(gameStore.requests) !== JSON.stringify(envelope.requests.requests)
    || JSON.stringify([...gameStore.processed].sort()) !== JSON.stringify([...envelope.requests.processed].sort())) {
    return messageFail('SCHEMA_MISMATCH', 'the restored game request store disagrees with the envelope');
  }
  return messageOk({ game, store: gameStore, binding: envelope.binding });
}
