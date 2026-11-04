/**
 * G09-R1 worker D — the task-scoped chat campaign ledger.
 *
 * The budget belongs to the AUTHORIZED TASK, not to a batch: a new batch name,
 * a restart or a new process never refreshes it. Every POST is preceded by an
 * atomic reserve that is never refunded; a reserved attempt that never finishes
 * stays spent with unknown usage.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { G09_CAMPAIGN_SCHEMA } from '../src/negotiation/contracts';

export interface CampaignAttempt {
  attemptId: string;
  seq: number;
  batch: string;
  episodeId: string;
  phase: 'goal' | 'action' | 'unknown';
  at: string;
  state: 'reserved' | 'finished';
  outcome: string | null;
  totalTokens: number | null;
}

export interface CampaignState {
  schema: typeof G09_CAMPAIGN_SCHEMA;
  campaignId: string;
  limit: number;
  spent: number;
  attempts: CampaignAttempt[];
  updatedAt: string;
}

export type ReserveResult =
  | { ok: true; attemptId: string; state: CampaignState }
  | { ok: false; reason: string; state: CampaignState };

const FILE = 'campaign.json';
const LOCK = 'campaign.lock';

function campaignPath(dir: string): string {
  return join(resolve(dir), FILE);
}

/** Create the campaign on first use; an existing one is preserved verbatim. */
export function openCampaign(dir: string, limit: number, campaignId = 'g09-task'): CampaignState {
  mkdirSync(resolve(dir), { recursive: true });
  const path = campaignPath(dir);
  if (existsSync(path)) return loadCampaign(dir);
  const state: CampaignState = {
    schema: G09_CAMPAIGN_SCHEMA, campaignId, limit, spent: 0, attempts: [], updatedAt: new Date().toISOString(),
  };
  writeAtomic(path, state);
  return state;
}

export function loadCampaign(dir: string): CampaignState {
  const path = campaignPath(dir);
  if (!existsSync(path)) throw new Error(`campaign ledger missing at ${path}`);
  const state = JSON.parse(readFileSync(path, 'utf8')) as CampaignState;
  if (state.schema !== G09_CAMPAIGN_SCHEMA) throw new Error(`campaign ledger schema ${String(state.schema)} is not ${G09_CAMPAIGN_SCHEMA}`);
  if (!Number.isInteger(state.limit) || !Number.isInteger(state.spent)) throw new Error('campaign ledger counters are not integers');
  if (state.spent > state.limit) {
    // The historical overrun is preserved, never repaired silently.
  }
  return state;
}

function lockPath(dir: string): string {
  return join(resolve(dir), LOCK);
}

function withLock<T>(dir: string, fn: () => T): T {
  const lock = lockPath(dir);
  let fd: number | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch {
      const wait = 5 + Math.floor(Math.random() * 10);
      const end = Date.now() + wait;
      while (Date.now() < end) { /* brief spin: the critical section is tiny */ }
    }
  }
  if (fd === null) throw new Error('campaign ledger is locked by another process');
  try {
    return fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

function writeAtomic(path: string, state: CampaignState): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * Reserve ONE chat call before the POST. No refunds: a call that fails, times
 * out or never finishes stays spent. At the limit nothing is reserved and no
 * HTTP may happen.
 */
export function reserveCampaignChat(
  dir: string,
  input: { batch: string; episodeId: string; phase: 'goal' | 'action' | 'unknown' },
): ReserveResult {
  return withLock(dir, () => {
    const state = loadCampaign(dir);
    if (state.spent >= state.limit) {
      return { ok: false as const, reason: `campaign limit ${state.limit} reached (spent ${state.spent})`, state };
    }
    const seq = state.attempts.length + 1;
    const attemptId = `att-${String(seq).padStart(4, '0')}`;
    state.spent += 1;
    state.attempts.push({
      attemptId, seq, batch: input.batch, episodeId: input.episodeId, phase: input.phase,
      at: new Date().toISOString(), state: 'reserved', outcome: null, totalTokens: null,
    });
    state.updatedAt = new Date().toISOString();
    writeAtomic(campaignPath(dir), state);
    return { ok: true as const, attemptId, state };
  });
}

export function finishCampaignChat(
  dir: string,
  attemptId: string,
  input: { outcome: string; totalTokens: number | null },
): CampaignState {
  return withLock(dir, () => {
    const state = loadCampaign(dir);
    const attempt = state.attempts.find(candidate => candidate.attemptId === attemptId);
    if (attempt === undefined) throw new Error(`campaign has no attempt ${attemptId}`);
    if (attempt.state === 'finished') return state; // idempotent
    attempt.state = 'finished';
    attempt.outcome = input.outcome;
    attempt.totalTokens = input.totalTokens;
    state.updatedAt = new Date().toISOString();
    writeAtomic(campaignPath(dir), state);
    return state;
  });
}

export function campaignCounts(state: CampaignState): { limit: number; spent: number; known: number | null } {
  const unknown = state.attempts.some(attempt => attempt.state !== 'finished' || attempt.totalTokens === null);
  const known = unknown ? null : state.attempts.reduce<number>((sum, attempt) => sum + (attempt.totalTokens ?? 0), 0);
  return { limit: state.limit, spent: state.spent, known };
}
