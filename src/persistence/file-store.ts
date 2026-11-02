/**
 * G06 worker C — atomic, exclusive checkpoint files.
 *
 * Publish protocol: serialize + checksum into a unique temp file in the same
 * directory, fsync it, then hard-link it to the target name. The link either
 * creates the target or fails with EEXIST, so a slot is created exactly once
 * and no existing byte is ever overwritten (including two racing saves).
 * Readers see either a complete checksummed file or nothing; a truncated,
 * empty, foreign-schema or tampered file is rejected with issues, never
 * half-loaded.
 */
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, openSync, fsyncSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical } from '../util';
import {
  CHECKPOINT_SLOT_PATTERN, G06_CHECKPOINT_SCHEMA,
  checkpointFail, checkpointOk,
  type CheckpointFile, type GameCheckpoint, type Result,
} from './contracts';

const checksumOf = (payload: GameCheckpoint): string =>
  createHash('sha256').update(canonical(payload)).digest('hex');

export function checkpointPath(root: string, slot: string): string {
  return join(root, `${slot}.g06.json`);
}

export function saveCheckpoint(root: string, slot: string, checkpoint: GameCheckpoint): Result<{ path: string }> {
  if (!CHECKPOINT_SLOT_PATTERN.test(slot)) {
    return checkpointFail('INVALID_CHECKPOINT', `slot ${JSON.stringify(slot)} must match ${CHECKPOINT_SLOT_PATTERN}`);
  }
  if (checkpoint === null || typeof checkpoint !== 'object' || checkpoint.schema !== G06_CHECKPOINT_SCHEMA) {
    return checkpointFail('SCHEMA_MISMATCH', 'checkpoint payload must carry schema frostecho.g06.checkpoint/1');
  }
  const target = checkpointPath(root, slot);
  const file: CheckpointFile = {
    schema: G06_CHECKPOINT_SCHEMA,
    createdAt: new Date().toISOString(),
    sha256: checksumOf(checkpoint),
    payload: checkpoint,
  };
  const temp = join(root, `.${slot}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(root, { recursive: true });
    if (existsSync(target)) {
      return checkpointFail('EXISTS', `checkpoint slot '${slot}' already exists; refusing to overwrite ${target}`);
    }
    const fd = openSync(temp, 'wx');
    try {
      writeFileSync(fd, JSON.stringify(file, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return checkpointFail('EXISTS', `checkpoint slot '${slot}' was created concurrently; refusing to overwrite ${target}`);
      }
      throw err;
    }
    return checkpointOk({ path: target });
  } catch (err) {
    return checkpointFail('IO_ERROR', err instanceof Error ? err.message : String(err));
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* the temp file is unlinked best-effort; the target is never touched */
    }
  }
}

export function loadCheckpoint(path: string): Result<GameCheckpoint> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return checkpointFail('IO_ERROR', err instanceof Error ? err.message : String(err));
  }
  if (raw.trim().length === 0) {
    return checkpointFail('INVALID_CHECKPOINT', `checkpoint file ${path} is empty (a half-written save is not resumable)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return checkpointFail('INVALID_CHECKPOINT', `checkpoint file ${path} is not complete JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return checkpointFail('SCHEMA_MISMATCH', 'checkpoint file must contain a JSON object');
  }
  const file = parsed as Partial<CheckpointFile>;
  if (file.schema !== G06_CHECKPOINT_SCHEMA) {
    return checkpointFail('SCHEMA_MISMATCH', `schema ${JSON.stringify(file.schema)} is not ${G06_CHECKPOINT_SCHEMA} (G03/G04 audit snapshots are not checkpoints)`);
  }
  const payload = file.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || payload.schema !== G06_CHECKPOINT_SCHEMA) {
    return checkpointFail('SCHEMA_MISMATCH', 'checkpoint payload schema mismatch');
  }
  if (typeof file.sha256 !== 'string') {
    return checkpointFail('INVALID_CHECKPOINT', 'checkpoint file has no sha256');
  }
  const actual = checksumOf(payload);
  if (actual !== file.sha256) {
    return checkpointFail('CHECKSUM_MISMATCH', `checkpoint file ${path} failed its sha256 check (expected ${file.sha256}, payload hashes to ${actual})`);
  }
  return checkpointOk(payload);
}
