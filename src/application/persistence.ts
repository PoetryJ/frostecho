/**
 * G10-R1 worker A — durable save results and the authoritative run record.
 *
 * A user-actionable refusal (slot exists, bad slot, decision in flight) is not
 * a failure. A real IO failure keeps its original code/cause and must latch.
 * The run record is built from the existing authoritative snapshot/checkpoint
 * of the game, never from the display projection.
 */
import type { DetailedSaveResult } from '../negotiation/checkpoint';
import { exportGameCheckpoint } from '../reactive/checkpoint';
import { readSlot, writeExclusiveSlot } from '../persistence/atomic-slot';
import { EPISODE_CALL_LIMIT, SESSION_CALL_LIMIT } from '../reactive/contracts';
import type { G08EffectiveConfig } from '../temporal/contracts';
import type { NeedsGame } from '../needs/game';
import type { GoalRequestStore } from '../negotiation/requests';
import {
  G10_RUN_SCHEMA_V2,
  type AppMeta, type AppView, type CampaignBinding, type FailureEvidence, type RunRecordLineage,
  type RunRecordPayloadV2, type RunRecordWriteResult, type SaveCode, type SaveOutcome, type WireRecordEntry,
} from './contracts';

function issueText(issues: string[] | undefined): string {
  return (issues ?? []).join('; ');
}

/** Map the detailed save result without losing the original code or cause. */
export function saveOutcomeFromMessage(result: DetailedSaveResult): SaveOutcome {
  if (result.ok) {
    return { ok: true, path: result.path, code: 'OK', fatal: false, issues: [], cause: null };
  }
  const message = issueText(result.issues);
  const code: SaveCode = result.code === 'QUEUE_FULL'
    ? 'SAVE_BUSY'
    : result.code === 'EXISTS' || result.code === 'INVALID_SLOT' || result.code === 'SCHEMA_MISMATCH'
      || result.code === 'INVALID_SNAPSHOT' || result.code === 'IO_ERROR'
      ? result.code
      : 'INTERNAL';
  const fatal = code === 'IO_ERROR' || code === 'INTERNAL';
  return { ok: false, path: null, code, fatal, issues: result.issues, cause: message.length > 0 ? message : result.code };
}

export interface RunRecordInput {
  root: string;
  slot: string;
  game: NeedsGame;
  store: GoalRequestStore;
  meta: AppMeta;
  config: G08EffectiveConfig;
  /** The projection the user last saw; stored separately from the authority. */
  beforeCloseView: AppView;
  wire: WireRecordEntry[];
  lineage: RunRecordLineage;
  campaign: { binding: CampaignBinding | null; limit: number; spent: number; known: number | null } | null;
  /** Failures latched during THIS run; omitted from the payload when empty. */
  failures?: FailureEvidence[];
  now: () => number;
}

/** Build the authoritative payload from the game itself (post-close). */
export function buildRunRecordPayload(input: RunRecordInput): RunRecordPayloadV2 {
  const snapshot = input.game.snapshot() as unknown as {
    commands?: unknown[];
    events?: unknown[];
  };
  const exported = exportGameCheckpoint(input.game);
  const state = input.game.world.getState();
  const requests = input.store;
  const sessions = input.game.sessionsOf();
  const providerCalls = sessions.reduce((sum, entry) => sum + entry.session.providerCalls, 0);
  const episodeCalls = (input.game.snapshot() as unknown as { actors?: Record<string, { providerCalls?: number }> })
    .actors?.['npc_a']?.providerCalls ?? providerCalls;
  return {
    schema: G10_RUN_SCHEMA_V2,
    at: new Date(input.now()).toISOString(),
    lineage: input.lineage,
    meta: input.meta,
    config: input.config,
    beforeCloseView: input.beforeCloseView,
    authoritative: {
      snapshot,
      checkpoint: exported.ok ? exported.value : { error: issueText(exported.issues) },
      engine: { state, log: input.game.world.getLog() as unknown[] },
      commands: snapshot.commands ?? [],
      events: snapshot.events ?? [],
      processed: [...requests.processed],
      requests: JSON.parse(JSON.stringify(requests.requests)) as unknown,
      budget: {
        sessionLimit: SESSION_CALL_LIMIT,
        episodeLimit: EPISODE_CALL_LIMIT,
        providerCalls,
        episodeCalls,
      },
    },
    wire: input.wire,
    campaign: input.campaign,
    // run/2 compatible addition: the field exists ONLY when a failure was
    // latched, so every no-failure record stays byte-identical to /2.
    ...(input.failures !== undefined && input.failures.length > 0 ? { failures: input.failures } : {}),
  };
}

/**
 * Write ONE new run record. A save slot is never touched; an existing run
 * record is never overwritten (the next ordinal is tried). A durable write
 * failure is reported with its original cause, never swallowed.
 */
export function writeAuthoritativeRunRecord(input: RunRecordInput): RunRecordWriteResult {
  let payload: RunRecordPayloadV2;
  try {
    payload = buildRunRecordPayload(input);
  } catch (error) {
    return {
      ok: false, path: null, code: 'INTERNAL',
      cause: error instanceof Error ? error.message : String(error),
      issues: ['the authoritative snapshot could not be built'],
    };
  }
  let lastCause = '';
  for (let index = 1; index < 100; index += 1) {
    const slot = index === 1 ? `${input.slot}-run` : `${input.slot}-run-${index}`;
    const written = writeExclusiveSlot(input.root, slot, '.run.json', G10_RUN_SCHEMA_V2, payload);
    if (written.ok) {
      return { ok: true, path: written.value.path, code: 'OK', cause: null, issues: [] };
    }
    const message = issueText(written.issues);
    if (written.code !== 'EXISTS') {
      lastCause = message.length > 0 ? message : written.code;
      return { ok: false, path: null, code: written.code === 'IO_ERROR' ? 'IO_ERROR' : 'INTERNAL', cause: lastCause, issues: written.issues ?? [] };
    }
    lastCause = message;
  }
  return { ok: false, path: null, code: 'INTERNAL', cause: `no free run-record slot: ${lastCause}`, issues: [] };
}

export type ReadRunRecordResult =
  | { ok: true; payload: RunRecordPayloadV2 }
  | { ok: false; issues: string[] };

/** Read a run record for re-execution/audit (read-only). */
export function readRunRecord(path: string): ReadRunRecordResult {
  const read = readSlot<RunRecordPayloadV2>(path, G10_RUN_SCHEMA_V2);
  if (!read.ok) return { ok: false, issues: read.issues ?? [String(read.code)] };
  return { ok: true, payload: read.value };
}
