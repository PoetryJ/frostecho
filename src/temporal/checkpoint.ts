/**
 * G08 worker C — playable checkpoint envelope (.g08.json).
 *
 * The envelope holds the G08 game checkpoint (capability axis, timed_wait
 * states, per-actor deadlines), the G07 mailbox snapshot and BOTH
 * configuration axes (actionSet, messageMode). Save/load go through the
 * shared atomic-slot helper with the G08 schema; the G06/G07 public APIs
 * still accept only their own files, and foreign suffixes are rejected
 * explicitly rather than coerced.
 *
 * Load validates envelope/game/mailbox first, then restores the mailbox
 * without binding or deciding anything and the game without any provider
 * call, cycle, or command: a paused session keeps its ORIGINAL deadline
 * verbatim and stays recoverable. A runtime whose actionSet or messageMode
 * differs from the save is refused with MODE_CONFLICT before any restore.
 * Data only: no functions, providers, timers or credentials are serialized.
 */
import type { GameRestoreRuntime } from '../persistence/contracts';
import { readSlot, slotPath, writeExclusiveSlot, type SlotErrorCode } from '../persistence/atomic-slot';
import { exportGameCheckpoint, restoreNeedsGame } from '../reactive/checkpoint';
import { restoreMailbox } from '../communication/mailbox';
import {
  G07_MAILBOX_SCHEMA,
  messageFail, messageOk,
  type Mailbox, type MailboxSnapshot, type MessageMode, type MessageResult,
} from '../communication/contracts';
import type { ReactiveGame } from '../reactive/contracts';
import {
  ACTION_SETS, G08_CHECKPOINT_SCHEMA, G08_FILE_SUFFIX, G08_GAME_SCHEMA,
  type ActionSet, type G08Checkpoint, type G08CheckpointRuntime, type G08EffectiveConfig,
} from './contracts';

const SLOT_ERROR_CODES: readonly SlotErrorCode[] = ['INVALID_SLOT', 'INVALID_PAYLOAD', 'SCHEMA_MISMATCH', 'EXISTS', 'IO_ERROR'];

function toCheckpointIssue(code: SlotErrorCode): string {
  return `slot read failed: ${code}`;
}

export function g08CheckpointPath(root: string, slot: string): string {
  return slotPath(root, slot, G08_FILE_SUFFIX);
}

/** Compose + persist the envelope. The game export enforces the decision boundary (SAVE_BUSY otherwise). */
export function saveG08Checkpoint(
  root: string,
  slot: string,
  game: unknown,
  mailbox: Mailbox,
  actionSet: ActionSet,
  messageMode: MessageMode,
  effectiveConfig: G08EffectiveConfig,
): MessageResult<{ path: string }> {
  if (!ACTION_SETS.includes(actionSet)) {
    return messageFail('INVALID_COMMAND', `unknown action set ${JSON.stringify(actionSet)}`);
  }
  if (messageMode !== 'off' && messageMode !== 'on') {
    return messageFail('INVALID_COMMAND', `unknown message mode ${JSON.stringify(messageMode)}`);
  }
  const configIssues = effectiveConfigIssues(effectiveConfig);
  if (configIssues.length > 0) return messageFail('INVALID_COMMAND', ...configIssues);
  const exported = exportGameCheckpoint(game);
  if (!exported.ok) {
    if (exported.code === 'SAVE_BUSY') return messageFail('QUEUE_FULL', 'a decision is in flight; save at a decision boundary only');
    return messageFail(exported.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(exported.issues ?? []));
  }
  // G08-R1: one source — the game record and the envelope must describe the
  // same runtime, or the slot would lie about itself.
  if (!effectiveConfigMatchesRecord(effectiveConfig, exported.value)) {
    return messageFail('INVALID_COMMAND',
      'the effectiveConfig passed to save disagrees with the game record (mode/requestModel/timeoutMs/thinking); the game was built with a different runtime');
  }
  const envelope: G08Checkpoint = {
    schema: G08_CHECKPOINT_SCHEMA,
    actionSet,
    messageMode,
    effectiveConfig,
    game: exported.value as unknown as G08Checkpoint['game'],
    communication: mailbox.export(),
  };
  const written = writeExclusiveSlot(root, slot, G08_FILE_SUFFIX, G08_CHECKPOINT_SCHEMA, envelope);
  if (!written.ok) {
    const code = SLOT_ERROR_CODES.includes(written.code) ? written.code : 'INVALID_SNAPSHOT';
    return messageFail(code as 'SCHEMA_MISMATCH', ...(written.issues ?? []));
  }
  return messageOk({ path: written.value.path });
}

export interface LoadedG08Checkpoint {
  envelope: G08Checkpoint;
  mailbox: Mailbox;
}

/** Read + validate an envelope and restore the mailbox half (no binding, no deciding). */
export function loadG08Checkpoint(path: string): MessageResult<LoadedG08Checkpoint> {
  if (/\.(g06|g07)\.json$/i.test(path)) {
    return messageFail('SCHEMA_MISMATCH', 'G06/G07 files must go through their own entry points');
  }
  const read = readSlot<G08Checkpoint>(path, G08_CHECKPOINT_SCHEMA);
  if (!read.ok) {
    const code = SLOT_ERROR_CODES.includes(read.code) ? read.code : 'INVALID_SNAPSHOT';
    return messageFail(code as 'SCHEMA_MISMATCH', ...(read.issues ?? [toCheckpointIssue(read.code)]));
  }
  const envelope = read.value;
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return messageFail('SCHEMA_MISMATCH', 'G08 envelope must be an object');
  }
  if (envelope.schema !== G08_CHECKPOINT_SCHEMA) {
    return messageFail('SCHEMA_MISMATCH', `envelope schema must be ${G08_CHECKPOINT_SCHEMA}, got ${JSON.stringify(envelope.schema)}`);
  }
  if (!ACTION_SETS.includes(envelope.actionSet)) {
    return messageFail('SCHEMA_MISMATCH', `envelope actionSet must be one of ${ACTION_SETS.join('|')}`);
  }
  if (envelope.messageMode !== 'off' && envelope.messageMode !== 'on') {
    return messageFail('SCHEMA_MISMATCH', `envelope messageMode must be off|on, got ${JSON.stringify(envelope.messageMode)}`);
  }
  // G08-R1: an envelope without its effective config cannot be proven to
  // reconstruct the same runtime — refuse rather than silently migrate.
  const configIssues = effectiveConfigIssues(envelope.effectiveConfig);
  if (configIssues.length > 0) {
    return messageFail('SCHEMA_MISMATCH',
      `effectiveConfig is missing or invalid (${configIssues.join('; ')}); the slot predates G08-R1 and must be recreated`);
  }
  const game = envelope.game as { schema?: unknown; actionSet?: unknown } | undefined;
  if (game === undefined || game === null || typeof game !== 'object' || game.schema !== G08_GAME_SCHEMA) {
    return messageFail('SCHEMA_MISMATCH', `G08 envelope must embed a ${G08_GAME_SCHEMA} game`);
  }
  if (game.actionSet !== envelope.actionSet) {
    return messageFail('SCHEMA_MISMATCH',
      `envelope actionSet ${JSON.stringify(envelope.actionSet)} contradicts the embedded game actionSet ${JSON.stringify(game.actionSet)}`);
  }
  const communication = envelope.communication as MailboxSnapshot | undefined;
  if (communication === undefined || communication === null || communication.schema !== G07_MAILBOX_SCHEMA) {
    return messageFail('SCHEMA_MISMATCH', `G08 envelope must embed ${G07_MAILBOX_SCHEMA}`);
  }
  const mailbox = restoreMailbox(communication);
  if (!mailbox.ok) return messageFail('INVALID_SNAPSHOT', ...(mailbox.issues ?? []));
  return messageOk({ envelope, mailbox: mailbox.value });
}

/**
 * Restore the game half with the caller's resources. Both configuration
 * axes must match the save exactly; a contradiction is refused with
 * MODE_CONFLICT before anything is rebuilt.
 */
export function restoreG08Game(
  loaded: LoadedG08Checkpoint,
  runtime: G08CheckpointRuntime,
): MessageResult<ReactiveGame> {
  if (runtime.actionSet !== loaded.envelope.actionSet) {
    return messageFail('CONFLICT',
      `actionSet mismatch: save ${JSON.stringify(loaded.envelope.actionSet)}, runtime ${JSON.stringify(runtime.actionSet)}`);
  }
  if (runtime.messageMode !== loaded.envelope.messageMode) {
    return messageFail('CONFLICT',
      `messageMode mismatch: save ${JSON.stringify(loaded.envelope.messageMode)}, runtime ${JSON.stringify(runtime.messageMode)}`);
  }
  // G08-R1: the game record and the envelope must describe the SAME runtime.
  if (!effectiveConfigMatchesRecord(loaded.envelope.effectiveConfig, loaded.envelope.game)) {
    return messageFail('SCHEMA_MISMATCH',
      'the game record effective configuration disagrees with the envelope effectiveConfig; the slot was written by inconsistent code and must be recreated');
  }
  const restored = restoreNeedsGame(loaded.envelope.game, runtime as GameRestoreRuntime);
  if (!restored.ok) {
    return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  }
  return messageOk(restored.value);
}

/**
 * G08-R1: shape validation for the single effectiveConfig, shared by save
 * and load and exported for the CLI. Data only — it never reads the env.
 */
export function effectiveConfigIssues(config: unknown): string[] {
  const issues: string[] = [];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return ['effectiveConfig must be an object'];
  }
  const c = config as Record<string, unknown>;
  if (c.mode !== 'reference' && c.mode !== 'live') {
    issues.push(`effectiveConfig.mode must be 'reference' or 'live', got ${JSON.stringify(c.mode ?? null)}`);
  }
  if (c.mode === 'live' && (typeof c.requestModel !== 'string' || c.requestModel.length === 0)) {
    issues.push('a live effectiveConfig must name its requestModel');
  }
  if (c.mode === 'reference' && c.requestModel !== null && c.requestModel !== undefined) {
    issues.push('a reference effectiveConfig carries no requestModel');
  }
  if (typeof c.thinking !== 'boolean') {
    issues.push(`effectiveConfig.thinking must be a boolean, got ${JSON.stringify(c.thinking ?? null)}`);
  }
  if (typeof c.timeoutMs !== 'number' || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs <= 0) {
    issues.push(`effectiveConfig.timeoutMs must be a positive integer, got ${JSON.stringify(c.timeoutMs ?? null)}`);
  }
  return issues;
}

/**
 * G08-R1: does the game record describe the same runtime as this config?
 * The record is authoritative — the envelope config is a claim that must
 * match it, and the CLI builds its provider from the same values.
 */
export function effectiveConfigMatchesRecord(config: G08EffectiveConfig, record: unknown): boolean {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Record<string, unknown>;
  return r.mode === config.mode
    && r.thinking === config.thinking
    && (r.requestModel ?? null) === config.requestModel
    && r.timeoutMs === config.timeoutMs;
}
