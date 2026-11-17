/**
 * G03 shared contracts — frozen by the main agent before A/B/C/D start.
 * Types only re-export what already exists: Engine (src/engine), AgentSession
 * (src/agent), LogEntry. No new world rules, no new actions.
 *
 * Autonomous actors are npc_a and npc_c; the player stays npc_b. The world
 * gains npc_c only through scenario initial states; RULES and Engine are
 * untouched. Each NPC targets hunger >= GOAL_HUNGER_AT_LEAST.
 */
import type {
  AgentSession, Observation, Provider, SessionStatus, StepAgentResult, StepFeedback, StepRecord,
} from '../agent/contracts';
import type { Engine, LogEntry } from '../engine';
import type { WorldEvent, WorldState } from '../types';

export const G03_SCHEMA = 'frostecho.g03.game/1' as const;
export const G03_BATCH_SCHEMA = 'frostecho.g03.batch/1' as const;
export const G03_ACTOR_IDS = ['npc_a', 'npc_c'] as const;
export type G03ActorId = (typeof G03_ACTOR_IDS)[number];
export const PLAYER_ACTOR_ID = 'npc_b';

/** Terminal for the scheduler: a session that will not step again. */
export function isTerminalStatus(status: SessionStatus): boolean {
  return status !== 'ready' && status !== 'deciding';
}

/** Scheduler input validation shared by A and B. Throws on contract violations. */
export function validateActorIds(actorIds: readonly string[]): void {
  if (actorIds.length === 0) throw new Error('actorIds must not be empty');
  const seen = new Set<string>();
  for (const id of actorIds) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('actorId must be a non-empty string');
    if (!(G03_ACTOR_IDS as readonly string[]).includes(id)) throw new Error(`unknown G03 actor ${id}`);
    if (seen.has(id)) throw new Error(`duplicate actorId ${id}`);
    seen.add(id);
  }
}

/* ------------------------------------------------------------------ */
/* Workstream A — scheduler (src/multi/scheduler.ts)                    */
/* ------------------------------------------------------------------ */

export type AdvanceOutcome =
  | { kind: 'stepped'; actorId: string; result: StepAgentResult }
  | { kind: 'busy' }
  | { kind: 'done' }
  | { kind: 'closed' }
  | { kind: 'interrupted'; actorId: string; result: StepAgentResult };

export type RunOutcomeKind = 'done' | 'busy' | 'closed' | 'interrupted';

export interface SchedulerOptions {
  /** Fixed rotation order, e.g. ['npc_a','npc_c'] or ['npc_c','npc_a']. */
  actorIds: readonly string[];
  getStatus(actorId: string): SessionStatus;
  step(actorId: string): Promise<StepAgentResult>;
}

export interface Scheduler {
  readonly actorIds: readonly string[];
  /**
   * Round-robin from the cursor: inspect at most n actors, pick the first
   * ready one, step it once. Terminal actors are skipped; an actor that stays
   * ready keeps getting later turns. Overlapping calls return busy and add no
   * provider request.
   */
  advance(): Promise<AdvanceOutcome>;
  /**
   * Drive until all actors are terminal, close() was called, or an
   * infrastructure failure (timeout/provider_error) interrupts the episode.
   * Re-entrant run, or advance during run, returns busy.
   */
  run(): Promise<RunOutcomeKind>;
  /** No new steps; the in-flight step keeps its original timeout. Resolves after it settles. */
  close(): Promise<void>;
  isClosed(): boolean;
}

/* ------------------------------------------------------------------ */
/* Workstream B — multi game (src/multi/game.ts)                        */
/* ------------------------------------------------------------------ */

export interface MultiDecidingInfo {
  actorId: string;
  round: number;
  observation: Observation;
}

export interface MultiGameOptions {
  episodeId: string;
  initialState: WorldState;
  /** Autonomous rotation order; must be a permutation of npc_a/npc_c. */
  actorIds: readonly string[];
  /** One independent Provider per actor (no shared mutable transport). */
  providerFor(actorId: string): Provider;
  mode: 'reference' | 'live' | 'fixture';
  thinking: boolean | null;
  timeoutMs?: number;
  now?: () => number;
  scheduleTimeout?(fn: () => void, ms: number): { cancel(): void };
  /** Player hook: fires after the actor's request started, before its text is used. */
  onDeciding?(info: MultiDecidingInfo): void | Promise<void>;
}

export type PlayerApplyResult =
  | { ok: true; command: { commandId: string; actorId: string; type: 'move' | 'eat'; payload: unknown }; exec: { status: string; reason?: string } }
  | { ok: false; error: string; command?: unknown; exec?: unknown };

export interface MultiGame {
  readonly episodeId: string;
  readonly world: Engine;
  readonly actorIds: readonly string[];
  readonly mode: 'reference' | 'live' | 'fixture';
  readonly thinking: boolean | null;
  /** The bound sessions, keyed by actor id. */
  readonly sessions: Readonly<Record<string, AgentSession>>;
  /** Scheduler facade. advance/run/close behave like the underlying scheduler. */
  advance(): Promise<AdvanceOutcome>;
  run(): Promise<RunOutcomeKind>;
  close(): Promise<void>;
  /** Player line: 'player move dorm|kitchen' | 'player eat'. Submits synchronously via Engine.submit. */
  playerLine(line: string): PlayerApplyResult;
  actorStatus(actorId: string): SessionStatus | 'unknown';
  statusText(): string;
  snapshot(): MultiRecord;
}

/* ------------------------------------------------------------------ */
/* Minimal MultiRecord (B fills, C persists and verifies)               */
/* ------------------------------------------------------------------ */

export type MultiStopReason =
  | 'completed'          // every autonomous actor reached a terminal status
  | 'user_closed'        // quit/close before all terminal
  | 'interrupted';       // timeout or provider_error (episode-level, stops the batch)

export interface MultiTurnRecord {
  /** 1-based index in the global NPC turn order. */
  globalTurn: number;
  actorId: string;
  /** This actor's decision round (1-based). */
  actorRound: number;
  inputFeedback: StepFeedback | null;
  providerCalled: boolean;
  status: StepAgentResult['status'];
  step?: StepRecord;
}

export interface MultiActorSummary {
  status: SessionStatus;
  providerCalls: number;
  /** Authoritative: this actor's final hunger >= 70. Never a model claim. */
  goalReached: boolean;
}

export interface MultiRecord {
  schema: typeof G03_SCHEMA;
  episodeId: string;
  scenarioId: string | null;
  mode: 'reference' | 'live' | 'fixture';
  thinking: boolean | null;
  actorOrder: string[];
  initialState: WorldState;
  finalState: WorldState;
  /** The single ordered world ledger from Engine.getLog(). */
  commands: LogEntry[];
  /** The world's committed events, stored once (never summed per session). */
  events: WorldEvent[];
  turns: MultiTurnRecord[];
  actors: Record<string, MultiActorSummary>;
  stopReason: MultiStopReason;
  scenarioPass: boolean | null;
  replayMatches: boolean;
  timing: { totalMs: number };
}

export function isMultiRecord(value: unknown): value is MultiRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Partial<MultiRecord>;
  return rec.schema === G03_SCHEMA
    && typeof rec.episodeId === 'string'
    && Array.isArray(rec.actorOrder)
    && Array.isArray(rec.turns)
    && !!rec.actors && typeof rec.actors === 'object';
}
