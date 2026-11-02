/**
 * G06 frozen checkpoint contracts — written by the main agent before A/B/C/D
 * start. Everything here is data: no functions, promises, providers, abort
 * controllers, timers, URLs or credentials are ever serialized.
 *
 * A implements exportSessionCheckpoint/restoreAgentSession in
 * src/agent/checkpoint.ts; B implements exportGameCheckpoint/restoreNeedsGame
 * in src/reactive/checkpoint.ts (restoring the Engine itself and injecting the
 * restored engine into every session restore); C implements the file layer in
 * src/persistence/file-store.ts plus scripts/play-g06.ts; D consumes only.
 *
 * Restore semantics (all implementations): zero provider calls, zero world
 * commands, zero new cycles; budgets and rotation are taken from the data, never
 * from runtime arguments. Saving is only possible at a decision boundary with
 * no request in flight (SAVE_BUSY otherwise).
 */
import type {
  AgentSession, Observation, Provider, RunOutcome, SessionStatus, StepFeedback, StepRecord, WorldPort,
} from '../agent/contracts';
import type { SaveData } from '../engine';
import type {
  GameMode, NeedPolicy, ReactiveActorState, ReactiveDecidingInfo, ReactiveGame, ReactiveIdlePumps, ReactiveTransition,
  ReactiveTurnRecord, WakePolicy,
} from '../reactive/contracts';
import type { WorldState } from '../types';

export const G06_CHECKPOINT_SCHEMA = 'frostecho.g06.checkpoint/1' as const;
export const G06_SESSION_SCHEMA = 'frostecho.g06.session/1' as const;

/** CONTRACTS §API: Result<T> = ok value | error code with issues. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: CheckpointErrorCode; issues?: string[] };

export type CheckpointErrorCode =
  /** A decision is in flight; nothing was serialized, nothing changed. */
  | 'SAVE_BUSY'
  /** Unknown schema/version — including pre-G06 snapshot audit records. */
  | 'SCHEMA_MISMATCH'
  /** Structural or consistency validation failed; no half-restored object. */
  | 'INVALID_CHECKPOINT'
  /** The runtime's mode/config disagrees with the saved effective config. */
  | 'MODE_CONFLICT'
  /** The target slot already holds a file; old data is untouched. */
  | 'EXISTS'
  /** Filesystem failure (read or write). */
  | 'IO_ERROR'
  /** Stored SHA256 does not match the payload. */
  | 'CHECKSUM_MISMATCH';

export function checkpointOk<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function checkpointFail<T = never>(code: CheckpointErrorCode, ...issues: string[]): Result<T> {
  return { ok: false, code, ...(issues.length > 0 ? { issues } : {}) };
}

/* ------------------------------------------------------------------ */
/* A: AgentSession checkpoint                                          */
/* ------------------------------------------------------------------ */

/**
 * Which command-id formula the session used. G06 games always use
 * 'g06-episode-cycle': `${episodeId}:npc:${actorId}:${cycle}:${round}`.
 * 'run-round' is the G01 default `${runId}:${round}`. Any other custom
 * formula is rejected at export time, not silently re-derived.
 */
export type SessionCommandIdScheme = 'run-round' | 'g06-episode-cycle';

/** Serialized AgentSession (schema frostecho.g06.session/1). Deep-copied on export. */
export interface SessionCheckpoint {
  schema: typeof G06_SESSION_SCHEMA;
  runId: string;
  actorId: string;
  /** Decision round in flight or last started; 0 before the first step. */
  round: number;
  feedback: StepFeedback | null;
  /** 'deciding' at export time is SAVE_BUSY, so this is never serialized as deciding. */
  status: SessionStatus;
  providerCalls: number;
  steps: StepRecord[];
  /** Saved effective timeout — runtime arguments never override it. */
  timeoutMs: number;
  commandIdScheme: SessionCommandIdScheme;
  /** Wall-clock bookkeeping for result() only; excluded from equality diffs. */
  timing: { started: number; calls: { round: number; ms: number }[] };
  terminalOutcome: RunOutcome | null;
  explicitError?: string;
  /** result() bookkeeping captured at session creation. */
  initialState: WorldState;
  eventsBefore: number;
}

/** Runtime resources re-injected at restore; world must be B's restored Engine. */
export interface SessionRestoreRuntime {
  world: WorldPort;
  provider: Provider;
  /** Rebuilt by B from checkpoint context; the saved scheme must accept it. */
  commandIdFor(round: number): string;
  now?: () => number;
  scheduleTimeout?(fn: () => void, ms: number): { cancel(): void };
}

/* ------------------------------------------------------------------ */
/* B: ReactiveGame checkpoint                                          */
/* ------------------------------------------------------------------ */

/** One cycle: scheduler metadata plus its full AgentSession checkpoint. */
export interface GameCycleCheckpoint {
  cycle: number;
  reason: string;
  startLogCursor: number;
  endState: ReactiveActorState;
  turns: ReactiveTurnRecord[];
  session: SessionCheckpoint;
}

/** Serialized ReactiveGame (schema frostecho.g06.checkpoint/1). */
export interface GameCheckpoint {
  schema: typeof G06_CHECKPOINT_SCHEMA;
  episodeId: string;
  actorIds: string[];
  wakePolicy: WakePolicy;
  mode: GameMode;
  thinking: boolean;
  needPolicy: NeedPolicy;
  recordSchema: 'frostecho.g04.game/1' | 'frostecho.g05.game/2';
  requestModel: string | null;
  timeoutMs: number;
  /** Engine.save() verbatim: initial/state, events, log, seq, eventCounter, processed. */
  engine: SaveData;
  /** The game's own construction initial state (episode-level audit field). */
  initialState: WorldState;
  /** Wall clock at game creation; excluded from equality diffs. */
  startedAt: number;
  states: Record<string, ReactiveActorState>;
  transitions: ReactiveTransition[];
  /** Rotation cursor — the next actor is actorIds[cursor] when active. */
  cursor: number;
  globalTurn: number;
  playerSeq: number;
  worldSeq: number;
  /** False at export (busy export is SAVE_BUSY); restored verbatim, so a saved-closed game restores closed. */
  busy: boolean;
  closed: boolean;
  interrupted: boolean;
  lastInterruptedActor: string | null;
  totalCalls: number;
  idlePumps: ReactiveIdlePumps;
  cycles: Record<string, GameCycleCheckpoint[]>;
}

export interface GameRestoreRuntime {
  /** Fresh adapters are fine; restore itself never calls decide. */
  providerFor(actorId: string): Provider;
  now?: () => number;
  scheduleTimeout?(fn: () => void, ms: number): { cancel(): void };
  onDeciding?(info: ReactiveDecidingInfo): void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/* C: file layer                                                       */
/* ------------------------------------------------------------------ */

/** Slot file names: ^[a-z0-9][a-z0-9-]{0,63}$ → <root>/<slot>.g06.json. */
export const CHECKPOINT_SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What actually lands on disk; sha256 covers canonical(payload). */
export interface CheckpointFile {
  schema: typeof G06_CHECKPOINT_SCHEMA;
  createdAt: string;
  sha256: string;
  payload: GameCheckpoint;
}

/** Save: unique temp file + fsync + hard link to the target (EEXIST ⇒ EXISTS, no overwrite). */
export type SaveCheckpoint = (root: string, slot: string, checkpoint: GameCheckpoint) => Result<{ path: string }>;
/** Load: read, checksum, schema/version and structural validation; no partial objects. */
export type LoadCheckpoint = (path: string) => Result<GameCheckpoint>;

/* ------------------------------------------------------------------ */
/* Frozen module signatures (implemented by A/B/C in their own files)   */
/* ------------------------------------------------------------------ */

/** A: src/agent/checkpoint.ts */
export interface SessionCheckpointApi {
  exportSessionCheckpoint(session: AgentSession): Result<SessionCheckpoint>;
  restoreAgentSession(data: unknown, runtime: SessionRestoreRuntime): Result<AgentSession>;
}

/** B: src/reactive/checkpoint.ts */
export interface GameCheckpointApi {
  exportGameCheckpoint(game: unknown): Result<GameCheckpoint>;
  restoreNeedsGame(data: unknown, runtime: GameRestoreRuntime): Result<ReactiveGame>;
}

/** Reference summary of what a save must print for CLI parity (C). */
export interface SaveSummaryView {
  path: string;
  simTime: number;
  actors: Record<string, { state: ReactiveActorState; cycle: number; calls: number; hunger: number | null; location: string | null }>;
  closed: boolean;
  interrupted: boolean;
}

export type { AgentSession, Observation, SessionStatus, StepFeedback, StepRecord, WorldPort };
