/**
 * G07 worker C — G07 checkpoint envelope (.g07.json).
 *
 * The envelope holds the untouched G06 game checkpoint, the mailbox snapshot
 * and the message mode. Export happens only at a decision boundary with no
 * request in flight (the G06 export refuses SAVE_BUSY). Save/load go through
 * the shared atomic-slot helper with the G07 schema; the G06 public API still
 * accepts only G06 files, so a cross-format load is rejected explicitly rather
 * than coerced.
 *
 * Load validates game/mailbox/mode first and restores the mailbox without
 * binding or deciding anything: already-consumed messages are never
 * re-delivered; pending messages bind only at the next natural decision.
 */
import type { GameCheckpoint, GameRestoreRuntime } from '../persistence/contracts';
import { readSlot, slotPath, writeExclusiveSlot, type SlotErrorCode } from '../persistence/atomic-slot';
import { exportGameCheckpoint, restoreNeedsGame } from '../reactive/checkpoint';
import { restoreMailbox } from './mailbox';
import {
  G07_CHECKPOINT_SCHEMA, G07_MAILBOX_SCHEMA,
  messageFail, messageOk,
  type G07Envelope, type Mailbox, type MailboxSnapshot, type MessageMode, type MessageResult,
} from './contracts';
import type { ReactiveGame } from '../reactive/contracts';

const G07_SUFFIX = '.g07.json';

function toMessageCode(code: SlotErrorCode): 'INVALID_SNAPSHOT' | 'SCHEMA_MISMATCH' | 'EXISTS' | 'IO_ERROR' {
  if (code === 'INVALID_SLOT' || code === 'INVALID_PAYLOAD') return 'INVALID_SNAPSHOT';
  if (code === 'SCHEMA_MISMATCH' || code === 'EXISTS' || code === 'IO_ERROR') return code;
  return 'INVALID_SNAPSHOT';
}

export function g07CheckpointPath(root: string, slot: string): string {
  return slotPath(root, slot, G07_SUFFIX);
}

/**
 * Compose + persist the envelope. The game export enforces the decision
 * boundary; the mailbox and game halves are deep copies taken together.
 */
export function saveG07Checkpoint(
  root: string,
  slot: string,
  game: unknown,
  mailbox: Mailbox,
  messageMode: MessageMode,
): MessageResult<{ path: string }> {
  if (messageMode !== 'off' && messageMode !== 'on') return messageFail('INVALID_COMMAND', `unknown message mode ${JSON.stringify(messageMode)}`);
  const exported = exportGameCheckpoint(game);
  if (!exported.ok) {
    if (exported.code === 'SAVE_BUSY') return messageFail('QUEUE_FULL', 'a decision is in flight; save at a decision boundary only');
    return messageFail(exported.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(exported.issues ?? []));
  }
  const envelope: G07Envelope = {
    schema: G07_CHECKPOINT_SCHEMA,
    game: exported.value,
    communication: mailbox.export(),
    messageMode,
  };
  const written = writeExclusiveSlot(root, slot, G07_SUFFIX, G07_CHECKPOINT_SCHEMA, envelope);
  if (!written.ok) return messageFail(toMessageCode(written.code), ...(written.issues ?? []));
  return messageOk({ path: written.value.path });
}

export interface LoadedG07Checkpoint {
  envelope: G07Envelope;
  /** Validated mailbox, restored without binding or deciding. */
  mailbox: Mailbox;
}

/** Read + validate the envelope; the caller decides whether to restore the game. */
export function loadG07Checkpoint(path: string): MessageResult<LoadedG07Checkpoint> {
  const read = readSlot<G07Envelope>(path, G07_CHECKPOINT_SCHEMA);
  if (!read.ok) return messageFail(toMessageCode(read.code), ...(read.issues ?? []));
  const envelope = read.value;
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return messageFail('SCHEMA_MISMATCH', 'G07 envelope must be an object');
  }
  if (envelope.schema !== G07_CHECKPOINT_SCHEMA) return messageFail('SCHEMA_MISMATCH', `schema is not ${G07_CHECKPOINT_SCHEMA}`);
  if (envelope.messageMode !== 'off' && envelope.messageMode !== 'on') {
    return messageFail('INVALID_SNAPSHOT', `unknown message mode ${JSON.stringify(envelope.messageMode)}`);
  }
  const game = envelope.game as GameCheckpoint | undefined;
  if (game === undefined || game === null || typeof game !== 'object' || game.schema !== 'frostecho.g06.checkpoint/1') {
    return messageFail('SCHEMA_MISMATCH', 'G07 envelope must embed a frostecho.g06.checkpoint/1 game');
  }
  const communication = envelope.communication as MailboxSnapshot | undefined;
  if (communication === undefined || communication === null || communication.schema !== G07_MAILBOX_SCHEMA) {
    return messageFail('SCHEMA_MISMATCH', `G07 envelope must embed ${G07_MAILBOX_SCHEMA}`);
  }
  const mailbox = restoreMailbox(communication);
  if (!mailbox.ok) return messageFail('INVALID_SNAPSHOT', ...(mailbox.issues ?? []));
  return messageOk({ envelope, mailbox: mailbox.value });
}

/** Restore the game half of a loaded envelope with the caller's resources. */
export function restoreG07Game(loaded: LoadedG07Checkpoint, runtime: GameRestoreRuntime): MessageResult<ReactiveGame> {
  const restored = restoreNeedsGame(loaded.envelope.game, runtime);
  if (!restored.ok) {
    return messageFail(restored.code === 'SCHEMA_MISMATCH' ? 'SCHEMA_MISMATCH' : 'INVALID_SNAPSHOT', ...(restored.issues ?? []));
  }
  return messageOk(restored.value);
}

/** G06 and G07 files must never be mistaken for each other. */
export function rejectForeignFormat(path: string): MessageResult<never> {
  const lower = path.toLowerCase();
  if (lower.endsWith('.g06.json')) {
    return messageFail('SCHEMA_MISMATCH', `${path} is a G06 checkpoint; G07 uses .g07.json and its own envelope`);
  }
  return messageFail('SCHEMA_MISMATCH', `${path} is not a G07 checkpoint file`);
}
