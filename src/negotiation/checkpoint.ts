/**
 * G09 worker C — the goal-choice save slot (`<slot>.g09.json`).
 *
 * The envelope is the G08 game checkpoint plus the *negotiation* state: the
 * frozen arm, the starting satiety, the structured request and the binding.
 * Restore is pure data: it rebuilds the game from the checkpoint alone, spends
 * ZERO provider calls and never re-chooses a goal — the session comes back in
 * its action phase with the binding it already made.
 */
import { resolve as resolvePath } from 'node:path';
import { readSlot, slotPath, writeExclusiveSlot } from '../persistence/atomic-slot';
import type { MessageResult } from '../communication/contracts';
import { messageFail, messageOk } from '../communication/contracts';
import { exportGameCheckpoint, restoreNeedsGame } from '../reactive/checkpoint';
import type { ReactiveGame } from '../reactive/contracts';
import type { G08GameCheckpoint } from '../temporal/contracts';
import type { G08EffectiveConfig, G08CheckpointRuntime } from '../temporal/contracts';
import { effectiveConfigIssues, effectiveConfigMatchesRecord } from '../temporal/checkpoint';
import { restoreAgentSession } from '../agent/checkpoint';
import type { AgentSession, GoalProtocolOptions } from '../agent/contracts';
import {
  G09_CHECKPOINT_SCHEMA, G09_SELF_TEXT, GOAL_ARMS, G09_SATIETY_LEVELS,
  strictGoalChoice,
  type GoalArm, type GoalBinding, type GoalRequestSnapshot, type SatietyLevel,
} from './contracts';
import { validateGoalRequestSnapshot } from './requests';

export const G09_FILE_SUFFIX = '.g09.json';

export interface G09Checkpoint {
  schema: typeof G09_CHECKPOINT_SCHEMA;
  arm: GoalArm;
  satiety: SatietyLevel;
  /** The structured request (choice arm) or null (self_only arm). */
  request: GoalRequestSnapshot | null;
  /** The binding already made, or null while the goal phase is pending. */
  binding: GoalBinding | null;
  effectiveConfig: G08EffectiveConfig;
  game: G08GameCheckpoint;
  savedAtUtc: string;
}

export interface G09SnapshotState {
  arm: GoalArm;
  satiety: SatietyLevel;
  request: GoalRequestSnapshot | null;
  binding: GoalBinding | null;
}

export interface LoadedG09Checkpoint {
  path: string;
  envelope: G09Checkpoint;
}

export function g09CheckpointPath(root: string, slot: string): string {
  return slotPath(root, slot, G09_FILE_SUFFIX);
}

function protocolFrom(state: G09SnapshotState, to: string): GoalProtocolOptions {
  return {
    arm: state.arm,
    requestId: state.request === null ? null : state.request.requestId,
    text: state.request === null ? G09_SELF_TEXT : state.request.text,
    options: state.request === null ? ['feed_self'] : [...state.request.options],
    deadlineAfterRound: state.request === null ? 1 : state.request.deadlineAfterRound,
    playerId: to,
  };
}

/** The protocol the envelope describes (used on restore and by the eval). */
export function envelopeProtocol(envelope: Pick<G09Checkpoint, 'arm' | 'request'>, to = 'npc_b'): GoalProtocolOptions {
  return protocolFrom({
    arm: envelope.arm,
    satiety: 40,
    request: envelope.request,
    binding: null,
  }, to);
}

export function saveG09Checkpoint(
  root: string,
  slot: string,
  game: unknown,
  state: G09SnapshotState,
  effectiveConfig: G08EffectiveConfig,
): MessageResult<{ path: string }> {
  const configIssues = effectiveConfigIssues(effectiveConfig);
  if (configIssues.length > 0) return messageFail('INVALID_COMMAND', ...configIssues);
  if (!GOAL_ARMS.includes(state.arm)) return messageFail('INVALID_COMMAND', `unknown arm ${JSON.stringify(state.arm)}`);
  if (!(G09_SATIETY_LEVELS as readonly number[]).includes(state.satiety)) {
    return messageFail('INVALID_COMMAND', `unknown satiety ${JSON.stringify(state.satiety)}`);
  }
  if (state.request !== null) {
    const validated = validateGoalRequestSnapshot(state.request);
    if (!validated.ok) return messageFail('INVALID_SNAPSHOT', ...validated.issues);
    if (state.arm === 'self_only') return messageFail('INVALID_COMMAND', 'the self_only arm carries no request');
  } else if (state.arm === 'choice') {
    return messageFail('INVALID_COMMAND', 'the choice arm must carry its request');
  }
  if (state.binding !== null) {
    if (state.binding.episodeId.length === 0) return messageFail('INVALID_SNAPSHOT', 'binding without an episode');
    const options: readonly string[] = state.request === null ? ['feed_self'] : state.request.options;
    const parse = strictGoalChoice(state.binding.raw, options as never);
    if (!parse.ok || parse.goal !== state.binding.goal) {
      return messageFail('INVALID_SNAPSHOT', 'the binding raw does not parse to its goal');
    }
    if (state.request !== null && state.binding.requestId !== state.request.requestId) {
      return messageFail('INVALID_SNAPSHOT', 'the binding names another request');
    }
  }
  const exported = exportGameCheckpoint(game);
  if (!exported.ok) {
    if (exported.code === 'SAVE_BUSY') return messageFail('QUEUE_FULL', 'a decision is in flight; save at a decision boundary only');
    return messageFail(exported.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(exported.issues ?? []));
  }
  if (!effectiveConfigMatchesRecord(effectiveConfig, exported.value)) {
    return messageFail('INVALID_COMMAND',
      'the effectiveConfig passed to save disagrees with the game record; the game was built with a different runtime');
  }
  const envelope: G09Checkpoint = {
    schema: G09_CHECKPOINT_SCHEMA,
    arm: state.arm,
    satiety: state.satiety,
    request: state.request,
    binding: state.binding,
    effectiveConfig,
    game: exported.value as unknown as G08GameCheckpoint,
    savedAtUtc: new Date().toISOString(),
  };
  const written = writeExclusiveSlot(root, slot, G09_FILE_SUFFIX, G09_CHECKPOINT_SCHEMA, envelope);
  if (!written.ok) return messageFail(written.code as 'INVALID_SNAPSHOT', ...(written.issues ?? []));
  return messageOk({ path: written.value.path });
}

/** Validate one envelope (also used by the eval's read-only verification). */
export function validateG09Checkpoint(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['envelope must be an object'];
  const envelope = value as Partial<G09Checkpoint>;
  const issues: string[] = [];
  if (envelope.schema !== G09_CHECKPOINT_SCHEMA) issues.push(`schema must be ${G09_CHECKPOINT_SCHEMA}`);
  if (!GOAL_ARMS.includes(envelope.arm as GoalArm)) issues.push(`unknown arm ${JSON.stringify(envelope.arm)}`);
  if (!(G09_SATIETY_LEVELS as readonly number[]).includes(envelope.satiety as number)) {
    issues.push(`unknown satiety ${JSON.stringify(envelope.satiety)}`);
  }
  if (envelope.arm === 'self_only') {
    if (envelope.request !== null) issues.push('the self_only arm carries no request');
  } else if (envelope.arm === 'choice') {
    if (envelope.request === null || envelope.request === undefined) {
      issues.push('the choice arm must carry its request');
    } else {
      const validated = validateGoalRequestSnapshot(envelope.request);
      if (!validated.ok) issues.push(...validated.issues);
    }
  }
  if (envelope.binding !== null && envelope.binding !== undefined) {
    const binding = envelope.binding;
    const options = envelope.request?.options ?? ['feed_self'];
    if (binding.schema !== 'frostecho.g09.goal-binding/1') issues.push('bad binding schema');
    const parse = strictGoalChoice(binding.raw, options);
    if (!parse.ok || parse.goal !== binding.goal) issues.push('the binding raw does not parse to its goal');
  }
  const configIssues = effectiveConfigIssues(envelope.effectiveConfig);
  if (configIssues.length > 0) issues.push(...configIssues);
  if (envelope.game === null || typeof envelope.game !== 'object') issues.push('game must be an object');
  return issues;
}

export function loadG09Checkpoint(path: string): MessageResult<LoadedG09Checkpoint> {
  const absolute = resolvePath(path);
  // readSlot verifies the envelope schema and the sha256 before anything else
  // (tampered or truncated slots never reach the game).
  const read = readSlot<G09Checkpoint>(absolute, G09_CHECKPOINT_SCHEMA);
  if (!read.ok) return messageFail(read.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(read.issues ?? []));
  const issues = validateG09Checkpoint(read.value);
  if (issues.length > 0) return messageFail('SCHEMA_MISMATCH', ...issues);
  return messageOk({ path: absolute, envelope: read.value });
}

export interface G09RestoreRuntime extends Omit<G08CheckpointRuntime, 'actionSet' | 'messageMode'> {
  /** G09 arms are legacy-only in the frozen protocol. */
  actionSet?: 'legacy';
  /** The player the request is addressed to (default npc_b). */
  playerId?: string;
}

/**
 * Rebuild the game from the envelope. The session checkpoints inside are the
 * G09 format, so every restored session already carries its binding: no
 * provider call happens here and no goal is chosen again.
 */
export function restoreG09Game(
  loaded: LoadedG09Checkpoint,
  runtime: G09RestoreRuntime,
): MessageResult<{ game: ReactiveGame; binding: GoalBinding | null }> {
  const envelope = loaded.envelope;
  if (!effectiveConfigMatchesRecord(envelope.effectiveConfig, envelope.game)) {
    return messageFail('SCHEMA_MISMATCH',
      'the game record effective configuration disagrees with the envelope effectiveConfig');
  }
  const protocol = envelopeProtocol(envelope, runtime.playerId ?? 'npc_b');
  const restored = restoreNeedsGame(envelope.game, {
    ...runtime,
    actionSet: 'legacy',
    messageMode: 'off',
    goalProtocol: protocol,
  } as never);
  if (!restored.ok) {
    return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  }
  // The envelope binding and every session binding must agree with the
  // negotiation state — a slot may not claim a goal the session never chose.
  const sessions = collectSessions(restored.value);
  for (const session of sessions) {
    if (session.goalBinding === null && envelope.binding !== null) {
      return messageFail('SCHEMA_MISMATCH', 'the envelope claims a binding the session never made');
    }
    if (session.goalBinding !== null && envelope.binding !== null) {
      if (session.goalBinding.goal !== envelope.binding.goal
        || session.goalBinding.raw !== envelope.binding.raw
        || session.goalBinding.decidedRound !== envelope.binding.decidedRound) {
        return messageFail('SCHEMA_MISMATCH', 'the session binding disagrees with the envelope binding');
      }
    }
  }
  return messageOk({ game: restored.value as never, binding: envelope.binding });
}

/** Duck-typed access to the game's cycles (read-only). */
function collectSessions(game: unknown): AgentSession[] {
  const g = game as { sessionsOf?: () => { session: AgentSession }[] };
  if (typeof g.sessionsOf !== 'function') {
    throw new Error('the game does not expose sessionsOf(); G09 restore refuses to guess');
  }
  return g.sessionsOf().map(entry => entry.session);
}
