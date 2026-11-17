/**
 * G07 worker C — the internal atomic-slot helper extracted from the G06 file
 * store. Both the G06 (.g06.json, frostecho.g06.checkpoint/1) and the G07
 * (.g07.json, frostecho.g07.checkpoint/1) layers use it; neither format's
 * public API accepts the other's payload.
 *
 * Publish: unique temp file in the same directory, fsync, hard-link to the
 * target. The link either creates the target or fails with EEXIST, so a slot
 * is created exactly once and no existing byte is overwritten. Read: JSON
 * parse, schema check, sha256 over canonical(payload).
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../util';

/** Slot names: ^[a-z0-9][a-z0-9-]{0,63}$ → <root>/<slot><suffix>. */
export const SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SlotResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SlotErrorCode; issues?: string[] };

export type SlotErrorCode = 'INVALID_SLOT' | 'SCHEMA_MISMATCH' | 'INVALID_PAYLOAD' | 'EXISTS' | 'IO_ERROR' | 'CHECKSUM_MISMATCH';

export function slotOk<T>(value: T): SlotResult<T> {
  return { ok: true, value };
}

export function slotFail<T = never>(code: SlotErrorCode, ...issues: string[]): SlotResult<T> {
  return { ok: false, code, ...(issues.length > 0 ? { issues } : {}) };
}

export interface SlotFile<T> {
  schema: string;
  createdAt: string;
  sha256: string;
  payload: T;
}

export const slotChecksum = (payload: unknown): string =>
  createHash('sha256').update(canonical(payload)).digest('hex');

export function slotPath(root: string, slot: string, suffix: string): string {
  return join(root, `${slot}${suffix}`);
}

/**
 * Serialize + checksum + fsync into a unique temp file, then link it to
 * <slot><suffix>. EEXIST → EXISTS with the old file untouched.
 */
export function writeExclusiveSlot<T>(root: string, slot: string, suffix: string, schema: string, payload: T): SlotResult<{ path: string }> {
  if (!SLOT_PATTERN.test(slot)) {
    return slotFail('INVALID_SLOT', `slot ${JSON.stringify(slot)} must match ${SLOT_PATTERN}`);
  }
  const target = slotPath(root, slot, suffix);
  const temp = join(root, `.${slot}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(root, { recursive: true });
    if (existsSync(target)) {
      return slotFail('EXISTS', `slot '${slot}' already exists; refusing to overwrite ${target}`);
    }
    const file: SlotFile<T> = { schema, createdAt: new Date().toISOString(), sha256: slotChecksum(payload), payload };
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
        return slotFail('EXISTS', `slot '${slot}' was created concurrently; refusing to overwrite ${target}`);
      }
      throw err;
    }
    return slotOk({ path: target });
  } catch (err) {
    return slotFail('IO_ERROR', err instanceof Error ? err.message : String(err));
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort: the target is never touched */
    }
  }
}

/** Read + schema + checksum. Empty/truncated/foreign/tampered files are rejected. */
export function readSlot<T>(path: string, schema: string): SlotResult<T> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return slotFail('IO_ERROR', err instanceof Error ? err.message : String(err));
  }
  if (raw.trim().length === 0) {
    return slotFail('INVALID_PAYLOAD', `slot file ${path} is empty (a half-written save is not resumable)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return slotFail('INVALID_PAYLOAD', `slot file ${path} is not complete JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return slotFail('SCHEMA_MISMATCH', 'slot file must contain a JSON object');
  }
  const file = parsed as Partial<SlotFile<T>>;
  if (file.schema !== schema) {
    return slotFail('SCHEMA_MISMATCH', `schema ${JSON.stringify(file.schema)} is not ${schema}`);
  }
  if (file.payload === undefined || file.payload === null) {
    return slotFail('SCHEMA_MISMATCH', 'slot file payload is missing');
  }
  if (typeof file.sha256 !== 'string') {
    return slotFail('INVALID_PAYLOAD', 'slot file has no sha256');
  }
  const actual = slotChecksum(file.payload);
  if (actual !== file.sha256) {
    return slotFail('CHECKSUM_MISMATCH', `slot file ${path} failed its sha256 check (expected ${file.sha256}, payload hashes to ${actual})`);
  }
  return slotOk(file.payload);
}
