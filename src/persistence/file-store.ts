/**
 * G06 checkpoint files — thin adapter over the shared atomic-slot helper.
 *
 * The public G06 surface still accepts and produces ONLY the G06 schema and
 * the .g06.json suffix; G07 lives in its own module with .g07.json. Old bytes
 * are never overwritten and readers see a complete checksummed file or nothing.
 */
import {
  readSlot, slotPath, writeExclusiveSlot,
  type SlotErrorCode,
} from './atomic-slot';
import {
  CHECKPOINT_SLOT_PATTERN, G06_CHECKPOINT_SCHEMA,
  checkpointFail, checkpointOk,
  type GameCheckpoint, type Result,
} from './contracts';

const G06_SUFFIX = '.g06.json';

/** Helper error codes map onto the G06 vocabulary. */
function toCheckpointCode(code: SlotErrorCode): 'INVALID_CHECKPOINT' | 'SCHEMA_MISMATCH' | 'EXISTS' | 'IO_ERROR' | 'CHECKSUM_MISMATCH' {
  if (code === 'INVALID_SLOT' || code === 'INVALID_PAYLOAD') return 'INVALID_CHECKPOINT';
  return code;
}

export function checkpointPath(root: string, slot: string): string {
  return slotPath(root, slot, G06_SUFFIX);
}

export function saveCheckpoint(root: string, slot: string, checkpoint: GameCheckpoint): Result<{ path: string }> {
  if (!CHECKPOINT_SLOT_PATTERN.test(slot)) {
    return checkpointFail('INVALID_CHECKPOINT', `slot ${JSON.stringify(slot)} must match ${CHECKPOINT_SLOT_PATTERN}`);
  }
  if (checkpoint === null || typeof checkpoint !== 'object' || checkpoint.schema !== G06_CHECKPOINT_SCHEMA) {
    return checkpointFail('SCHEMA_MISMATCH', 'checkpoint payload must carry schema frostecho.g06.checkpoint/1');
  }
  const written = writeExclusiveSlot(root, slot, G06_SUFFIX, G06_CHECKPOINT_SCHEMA, checkpoint);
  if (!written.ok) return checkpointFail(toCheckpointCode(written.code), ...(written.issues ?? []));
  return checkpointOk({ path: written.value.path });
}

export function loadCheckpoint(path: string): Result<GameCheckpoint> {
  const read = readSlot<GameCheckpoint>(path, G06_CHECKPOINT_SCHEMA);
  if (!read.ok) return checkpointFail(toCheckpointCode(read.code), ...(read.issues ?? []));
  const payload = read.value;
  if (payload === null || typeof payload !== 'object' || payload.schema !== G06_CHECKPOINT_SCHEMA) {
    return checkpointFail('SCHEMA_MISMATCH', 'checkpoint payload schema mismatch (G03/G04 audit snapshots are not checkpoints)');
  }
  return checkpointOk(payload);
}
