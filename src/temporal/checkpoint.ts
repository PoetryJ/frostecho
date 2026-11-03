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
  type ActionSet, type G08Checkpoint, type G08CheckpointRuntime,
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
): MessageResult<{ path: string }> {
  if (!ACTION_SETS.includes(actionSet)) {
    return messageFail('INVALID_COMMAND', `unknown action set ${JSON.stringify(actionSet)}`);
  }
  if (messageMode !== 'off' && messageMode !== 'on') {
    return messageFail('INVALID_COMMAND', `unknown message mode ${JSON.stringify(messageMode)}`);
  }
  const exported = exportGameCheckpoint(game);
  if (!exported.ok) {
    if (exported.code === 'SAVE_BUSY') return messageFail('QUEUE_FULL', 'a decision is in flight; save at a decision boundary only');
    return messageFail(exported.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(exported.issues ?? []));
  }
  const envelope: G08Checkpoint = {
    schema: G08_CHECKPOINT_SCHEMA,
    actionSet,
    messageMode,
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
  const restored = restoreNeedsGame(loaded.envelope.game, runtime as GameRestoreRuntime);
  if (!restored.ok) {
    return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  }
  return messageOk(restored.value);
}
