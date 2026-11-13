/**
 * G04 shared contracts — frozen by the main agent before A/B/C/D start.
 *
 * Scope: conditional continuation. An autonomous NPC that stops because its
 * *current* observation offers no food waits; a world restock (an experimental
 * environment input, never an NPC ability) is a reason to re-check the
 * condition, not a reason to call the model again by itself.
 *
 * The world rule change is limited to one new command type (`restock`) that
 * only the `world` actor may submit, and one new event (`FoodRestocked`).
 * Existing move/eat semantics, the parser, the observation projection and the
 * AgentSession runner keep their G01..G03 behaviour.
 */
import type {
  AgentSession, GoalProtocolOptions, Observation, Provider, SessionStatus, StepFeedback, StepRecord,
} from '../agent/contracts';
import { G08_GAME_SCHEMA, type ActionSet } from '../temporal/contracts';
import type { Engine, LogEntry } from '../engine';
import type { EnqueueResult, GoalRequestStore } from '../negotiation/requests';
import type { GoalRequestSnapshot } from '../negotiation/contracts';
import type { Location, WorldEvent, WorldState } from '../types';

export const G04_SCHEMA = 'frostecho.g04.game/1' as const;
export const G04_BATCH_SCHEMA = 'frostecho.g04.batch/1' as const;
export const G04_SUMMARY_SCHEMA = 'frostecho.g04.summary/1' as const;
/** G05-R1: /2 marks the restored contract (steps decay, LOW/GOAL reactivation). */
export const G05_SCHEMA = 'frostecho.g05.game/2' as const;
export const G05_BATCH_SCHEMA = 'frostecho.g05.batch/2' as const;
export const G05_MATRIX_VERSION = 'g05-r1-t123' as const;

/** Internal command routing marker. Not a network identity and not an NPC. */
export const WORLD_ACTOR_ID = 'world';
export const REACTIVE_ACTOR_IDS = ['npc_a', 'npc_c'] as const;
export type ReactiveActorId = (typeof REACTIVE_ACTOR_IDS)[number];
export const PLAYER_ACTOR_ID = 'npc_b';

/** Per session. Mirrors MAX_PROVIDER_CALLS in the runner. */
export const SESSION_CALL_LIMIT = 5;
/** Per actor for the whole episode. Never reset by a new cycle. */
export const EPISODE_CALL_LIMIT = 10;
export const RESTOCK_MIN_AMOUNT = 1;
export const RESTOCK_MAX_AMOUNT = 10;

/* §1 World input */

export type GameMode = 'fixture' | 'live' | 'reference';

export interface RestockCommand {
  commandId: string;
  actorId: string;
  type: 'restock';
  payload: { location: Location; amount: number };
}

export interface RestockResult {
  ok: boolean;
  command: RestockCommand;
  exec: { status: string; reason?: string; eventIds: string[] };
  error?: string;
}

/* §2 Lifecycle */

export type WakePolicy = 'legacy' | 'event';

/** Outer actor state. Distinct from the inner AgentSession status. */
export type ReactiveActorState =
  | 'active' // a cycle is running and may take turns
  | 'waiting' // stopped for lack of observable food; the sole auto-wake candidate
  | 'hungry' // G05: a scheduled need is pending; the sole need-scheduling candidate
  | 'satisfied' // authoritative hunger >= goal
  | 'stopped' // stopped for any other reason (legacy policy or non-empty stop)
  | 'failed' // timeout / provider_error, latched for the episode
  | 'budget_exhausted'
  /** G08: the actor's session paused on logical time (waiting_time); non-terminal. */
  | 'timed_wait';

export type ReactiveStopReason = 'completed' | 'user_closed' | 'interrupted';

export interface ReactiveAdvanceOutcomeStepped {
  kind: 'stepped';
  actorId: string;
  cycle: number;
  result: { status: SessionStatus | 'busy'; terminal: boolean; providerCalled: boolean };
}
export type ReactiveAdvanceOutcome =
  | ReactiveAdvanceOutcomeStepped
  | { kind: 'busy' }
  | { kind: 'idle' }
  | { kind: 'closed' }
  | { kind: 'interrupted'; actorId: string };

/* §2b G05 needs — frozen interface (G05-R1 contract) */

/**
 * one-shot: the initial goal pursuit only — a satisfied actor never reactivates.
 * recurring: a satisfied actor whose own current hunger <= NEED_REACTIVATE_HUNGER
 * opens exactly one new cycle (checked on reconcile, i.e. after time/world input);
 * above the threshold it rests with no cycle and no provider call.
 * There is no third 'never' arm in G05-R1.
 */
export type NeedPolicy = 'one-shot' | 'recurring';
/** LOW threshold: re-pursue the goal only at or below this satiety. */
export const NEED_REACTIVATE_HUNGER = 40;
/** GOAL threshold lives in agent/contracts as GOAL_HUNGER_AT_LEAST (70). */

export interface AdvanceTimeCommand {
  commandId: string;
  actorId: string;
  type: 'advance_time';
  payload: { steps: number };
}

export type AdvanceTimeResult =
  | {
      ok: true;
      command: AdvanceTimeCommand;
      /** Sim time before the command. */
      before: number;
      /** Sim time after the command. */
      after: number;
    }
  | {
      ok: false;
      command: AdvanceTimeCommand;
      error: string;
    };

/* §3 Frozen interfaces */

export interface ReactiveDecidingInfo {
  actorId: string;
  cycle: number;
  round: number;
  observation: Observation;
}

export interface ReactiveGameOptions {
  episodeId: string;
  initialState: WorldState;
  /** Autonomous rotation order; a permutation of npc_a/npc_c. */
  actorIds: readonly string[];
  providerFor(actorId: string): Provider;
  mode: GameMode;
  /** Recorded configuration; live G04 runs fixed true. */
  thinking: boolean;
  /** Opt-in action-phase override; absent inherits `thinking` (old bytes). */
  actionThinking?: boolean;
  wakePolicy: WakePolicy;
  /** G05: need reactivation policy; default 'one-shot' (G04 semantics). */
  needPolicy?: NeedPolicy;
  /** G05: record schema version; default G04. */
  schemaVersion?: typeof G04_SCHEMA | typeof G05_SCHEMA;
  /**
   * G08 (opt-in): the capability axis. Present (legacy or timed_wait) the
   * game runs G08 semantics: every session gets the axis, records and
   * checkpoints carry it, and the record schema is the G08 schema.
   * Undefined keeps pre-G08 behaviour byte-identical.
   */
  actionSet?: ActionSet;
  /** G09 (opt-in): 'negotiated' consumes game-level requests; default legacy. */
  goalMode?: 'legacy' | 'negotiated';
  /** G09: which candidate goal set the model sees (the only arm variable). */
  candidateSet?: 'self_only' | 'choice';
  /** G09: the passive player the structured request comes from. */
  playerId?: string;
  /**
   * G09 (opt-in): every session of this game runs the frozen two-phase goal
   * protocol (goal choice on the first provider call, then actions), and
   * checkpoints export the G09 session format. Undefined keeps G08 exactly.
   */
  goalProtocol?: GoalProtocolOptions;
  /**
   * G11: extra budget gate consulted BEFORE the automatic continuation cycle
   * is opened (e.g. a campaign ledger with no chats left). Default: unlimited.
   * It is never consulted for anything else and never creates a ledger.
   */
  externalBudget?(actorId: string): boolean;
  /** Live model name for requestConfig even on zero-request trajectories. */
  requestModel?: string;
  timeoutMs?: number;
  now?: () => number;
  scheduleTimeout?(fn: () => void, ms: number): { cancel(): void };
  onDeciding?(info: ReactiveDecidingInfo): void | Promise<void>;
}

export interface ReactiveTurnRecord {
  globalTurn: number;
  actorId: string;
  cycle: number;
  actorRound: number;
  /** The observation this decision was made from. */
  observation: Observation;
  inputFeedback: StepFeedback | null;
  providerCalled: boolean;
  status: SessionStatus | 'busy';
  logCursorBefore: number;
  logCursorAfter: number;
  step?: StepRecord;
}

export interface ReactiveCycleRecord {
  cycle: number;
  /** G05: why this cycle opened (autonomous wake vs need cycle). */
  reason?: string;
  startLogCursor: number;
  endState: ReactiveActorState;
  turns: ReactiveTurnRecord[];
  providerCalls: number;
}

export interface ReactiveTransition {
  seq: number;
  actorId: string;
  cycle: number;
  from: ReactiveActorState | null;
  to: ReactiveActorState;
  reason: string;
  observation: Observation | null;
  logCursor: number;
}

export interface ReactiveActorSummary {
  state: ReactiveActorState;
  cycles: number;
  providerCalls: number;
  goalReached: boolean;
}

export interface ReactiveIdlePumps {
  pumps: number;
  callsBefore: number;
  callsAfter: number;
  cyclesBefore: number;
  cyclesAfter: number;
  actorStatesBefore: Record<string, ReactiveActorState>;
  actorStatesAfter: Record<string, ReactiveActorState>;
}

export interface ReactiveRequestConfig {
  model: string | null;
  temperature: number;
  max_tokens: number;
  stream: boolean;
  enableThinking: boolean[];
  timeoutMs: number;
}

export interface ReactiveRecord {
  schema: typeof G04_SCHEMA | typeof G05_SCHEMA | typeof G08_GAME_SCHEMA;
  episodeId: string;
  scenarioId: string | null;
  wakePolicy: WakePolicy;
  mode: GameMode;
  thinking: boolean;
  /** Opt-in action-phase override; serialized only when explicitly set. */
  actionThinking?: boolean;
  actorOrder: string[];
  initialState: WorldState;
  finalState: WorldState;
  /** The single ordered world ledger (NPC, player and world commands together). */
  commands: LogEntry[];
  /** Committed events, stored once. */
  events: WorldEvent[];
  cycles: Record<string, ReactiveCycleRecord[]>;
  actors: Record<string, ReactiveActorSummary>;
  transitions: ReactiveTransition[];
  stopReason: ReactiveStopReason;
  scenarioPass: boolean | null;
  replayMatches: boolean;
  idlePumps: ReactiveIdlePumps;
  requestConfig: ReactiveRequestConfig;
  timing: { totalMs: number };
  /** G05: need policy in force ('one-shot' on pre-G05 semantics). */
  needPolicy?: NeedPolicy;
  /** G08: capability axis; present exactly when the game opted in. */
  actionSet?: ActionSet;
  /** G08: per-actor wait deadlines at snapshot time; null for actors without one. */
  wakeAtSimTime?: Record<string, number | null>;
}

export interface ReactiveStatus {
  closed: boolean;
  interrupted: boolean;
  episodeId: string;
  wakePolicy: WakePolicy;
  mode: GameMode;
  thinking: boolean;
  actors: Record<string, { state: ReactiveActorState; cycle: number; providerCalls: number; hunger: number | null; location: Location | null }>;
  player: { location: Location | null; hunger: number | null };
  food: Record<string, number>;
  /** G05: simulated minutes (0 before the first advance_time). */
  simTime: number;
  commands: number;
  events: number;
  /** G08: capability axis; present exactly when the game opted in. */
  actionSet?: ActionSet;
  /** G08: per-actor wait deadlines; null for actors without one. */
  wakeAtSimTime?: Record<string, number | null>;
}

export interface ReactiveGame {
  readonly episodeId: string;
  readonly world: Engine;
  readonly actorIds: readonly string[];
  readonly wakePolicy: WakePolicy;
  readonly mode: GameMode;
  readonly thinking: boolean;
  advance(): Promise<ReactiveAdvanceOutcome>;
  runUntilIdle(): Promise<ReactiveAdvanceOutcome>;
  close(): Promise<void>;
  playerLine(line: string): { ok: boolean; detail: string };
  worldRestock(location: Location, amount: number, commandId?: string): RestockResult;
  /** G05: advance simulated time by steps; world-only; accepted even while a provider call is in flight. */
  worldAdvanceTime(steps: number): AdvanceTimeResult;
  /** Reconcile (and maybe wake) after an external notification; never calls a provider. */
  notifyWorldChange(): void;
  actorStateOf(actorId: string): ReactiveActorState;
  cyclesOf(actorId: string): number;
  /**
   * G09: read-only view of the sessions this game holds (one per cycle).
   * Used by the negotiation save to prove the slot and the sessions agree —
   * never to drive a decision.
   */
  sessionsOf(): { actorId: string; cycle: number; session: AgentSession }[];
  status(): ReactiveStatus;
  snapshot(): ReactiveRecord;
  isClosed(): boolean;
  isInterrupted(): boolean;
  /** G05: current need scheduling policy. */
  getNeedPolicy(): NeedPolicy;
  /** G05: interactive switch (one-shot/recurring); affects future reconciles only. */
  setNeedPolicy(policy: NeedPolicy): void;
  /** G09/G10: enqueue one host-generated request (never an NPC decision). */
  submitGoalRequest(request: GoalRequestSnapshot): EnqueueResult;
  /** G09/G10: the single authoritative request store (read-only view). */
  goalRequests(): GoalRequestStore;
}

export interface SessionArgs {
  episodeId: string;
  actorId: string;
  cycle: number;
  initialState: WorldState;
  provider: Provider;
  thinking: boolean;
  timeoutMs?: number;
  now?: () => number;
  scheduleTimeout?(fn: () => void, ms: number): { cancel(): void };
  onDeciding?(info: { actorId: string; round: number; observation: Observation }): void | Promise<void>;
}

export type SessionFactory = (args: SessionArgs) => AgentSession;

/* §4 Scenarios */

export type ScenarioId = 'n1' | 'n2' | 'n3';
export const SCENARIO_IDS: readonly ScenarioId[] = ['n1', 'n2', 'n3'];
export const SCENARIO_TITLES: Record<ScenarioId, string> = {
  n1: 'stop then restock the same kitchen',
  n2: 'restock a location nobody can see',
  n3: 'restock lands while the empty-kitchen stop is in flight',
};
export const WAKE_POLICIES: readonly WakePolicy[] = ['legacy', 'event'];
export const G04_THINKING = true;
