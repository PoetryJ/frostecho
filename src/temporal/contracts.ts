/**
 * G08 frozen shared contracts — the timed_wait capability.
 *
 * Frozen by the main agent before A/B/C/D start. One factor only: action
 * availability. The hunger goal, world rules, eat/stop semantics, budgets and
 * the model stay exactly as in G07. Default actionSet is 'legacy' and player
 * messages default off; the two are independent configuration axes.
 *
 * A implements the session-side members (src/agent/*), B the scheduler side
 * (src/reactive/*), C the checkpoint/CLI layer (src/temporal/checkpoint.ts,
 * src/reactive/checkpoint.ts, scripts/play-g08.ts), D consumes only. Data
 * only: no functions, providers, timers or credentials are ever serialized.
 */
import type { SessionStatus } from '../agent/contracts';
import type {
  GameCheckpoint, GameCycleCheckpoint, GameRestoreRuntime, SessionCheckpoint,
} from '../persistence/contracts';
import type {
  ReactiveActorState, ReactiveRecord, ReactiveStatus,
} from '../reactive/contracts';
import type { MailboxSnapshot, MessageMode } from '../communication/contracts';

/* ------------------------------------------------------------------ */
/* Capability switch                                                   */
/* ------------------------------------------------------------------ */

/** 'legacy' parses move/eat/stop only; 'timed_wait' additionally accepts {"type":"wait"}. */
export type ActionSet = 'legacy' | 'timed_wait';
export const ACTION_SETS: readonly ActionSet[] = ['legacy', 'timed_wait'];
export const DEFAULT_ACTION_SET: ActionSet = 'legacy';

/* ------------------------------------------------------------------ */
/* Frozen schema versions                                              */
/* ------------------------------------------------------------------ */

/** G08 AgentSession checkpoint (A exports/restores). */
export const G08_SESSION_SCHEMA = 'frostecho.g08.session/1' as const;
/** G08 game checkpoint (B exports, C dispatches). */
export const G08_GAME_SCHEMA = 'frostecho.g08.game/1' as const;
/** G08 playable envelope: game + mailbox + both configuration axes (C). */
export const G08_CHECKPOINT_SCHEMA = 'frostecho.g08.checkpoint/1' as const;
/** G08 eval episode/plan/summary records (D). */
export const G08_EPISODE_SCHEMA = 'frostecho.g08.eval.episode/1' as const;
export const G08_PLAN_SCHEMA = 'frostecho.g08.eval.plan/1' as const;
export const G08_SUMMARY_SCHEMA = 'frostecho.g08.eval.summary/1' as const;
/** Dedicated file suffix; never shared with .g06.json/.g07.json. */
export const G08_FILE_SUFFIX = '.g08.json';

/* ------------------------------------------------------------------ */
/* State fields                                                        */
/* ------------------------------------------------------------------ */

/**
 * Non-terminal AgentSession status: the session pauses its own scheduling
 * until simTime reaches wakeAtSimTime. Distinct from the empty-kitchen
 * 'waiting' actor state and from any terminal 'stopped'.
 */
export type WaitingTimeStatus = 'waiting_time';
export const WAITING_TIME_STATUS: WaitingTimeStatus = 'waiting_time';

/** ReactiveActorState value while the actor's session is waiting_time. */
export type TimedWaitActorState = 'timed_wait';
export const TIMED_WAIT_ACTOR_STATE: TimedWaitActorState = 'timed_wait';

/** One accepted wait pauses exactly one logical time step. */
export const WAIT_SIM_STEPS = 1;

/** The wait action. timed_wait parses exactly {"type":"wait"} and nothing else. */
export interface WaitAction {
  type: 'wait';
}

/* ------------------------------------------------------------------ */
/* A ↔ B: session wait projection and control                          */
/* ------------------------------------------------------------------ */

/**
 * Read-only wait projection. wakeAtSimTime is the SINGLE deadline source;
 * every other view (records, checkpoints, CLI) reads it and never keeps a
 * second counter.
 */
export interface SessionWaitState {
  actionSet: ActionSet;
  /** The G06 SessionStatus set plus 'waiting_time'. */
  status: SessionStatus | WaitingTimeStatus;
  /** simTime + 1 measured from the AUTHORITATIVE simTime at acceptance; null unless waiting_time. */
  wakeAtSimTime: number | null;
  providerCalls: number;
  /** True once resumeIfDue consumed this deadline (one resume per wait). */
  resumedOnce: boolean;
}

/**
 * Frozen control surface every G08 AgentSession exposes to the scheduler.
 * Legacy sessions implement the same members with actionSet='legacy' and
 * wakeAtSimTime=null so the scheduler never duck-types private fields.
 */
export interface WaitSessionControl {
  readonly actionSet: ActionSet;
  /** Single deadline source; null unless status === 'waiting_time'. */
  readonly wakeAtSimTime: number | null;
  /**
   * Resume-if-due: only when status is waiting_time and nowSimTime >=
   * wakeAtSimTime. Sets status back to ready, clears the deadline, performs
   * no provider call, opens no cycle, keeps round/feedback/budget/rotation.
   * Returns whether this call performed the resume. Idempotent: exactly one
   * resume per accepted wait, no matter how often time moves past it.
   */
  resumeIfDue(nowSimTime: number): boolean;
  /**
   * Budget termination for the outer episode limit (actor 10). Sets the
   * terminal budget_exhausted status and clears any wait deadline so no
   * paused session stays recoverable. Terminal sessions never revive.
   */
  exhaustBudget(detail: string): void;
  /** Deep-copied projection for records and checkpoints. */
  waitState(): SessionWaitState;
}

/* ------------------------------------------------------------------ */
/* A → C: G08 session checkpoint data                                  */
/* ------------------------------------------------------------------ */

/** G06 SessionCheckpoint plus the capability axis and the wait deadline. */
export interface G08SessionCheckpoint extends Omit<SessionCheckpoint, 'schema' | 'status'> {
  schema: typeof G08_SESSION_SCHEMA;
  actionSet: ActionSet;
  status: SessionStatus | WaitingTimeStatus;
  /** Original deadline preserved verbatim; null unless status is waiting_time. */
  wakeAtSimTime: number | null;
}

/* ------------------------------------------------------------------ */
/* B → C: G08 game checkpoint data                                     */
/* ------------------------------------------------------------------ */

export interface G08GameCycleCheckpoint extends Omit<GameCycleCheckpoint, 'endState' | 'session'> {
  endState: ReactiveActorState | TimedWaitActorState;
  session: G08SessionCheckpoint;
}

/**
 * G06 GameCheckpoint plus actionSet, the timed_wait actor state and the
 * per-actor deadlines. G08 CLI/eval saves ALL groups (legacy included) in
 * this format; only the old G06/G07 entry points keep writing old formats.
 */
export interface G08GameCheckpoint extends Omit<GameCheckpoint, 'schema' | 'recordSchema' | 'states' | 'cycles'> {
  schema: typeof G08_GAME_SCHEMA;
  actionSet: ActionSet;
  recordSchema: typeof G08_GAME_SCHEMA;
  states: Record<string, ReactiveActorState | TimedWaitActorState>;
  /** Original deadlines at export time; null for actors without one. */
  wakeAtSimTime: Record<string, number | null>;
  cycles: Record<string, G08GameCycleCheckpoint[]>;
}

/* ------------------------------------------------------------------ */
/* C: playable envelope                                                */
/* ------------------------------------------------------------------ */

/** The .g08.json payload: capability + messages mode + full game + mailbox. */
export interface G08Checkpoint {
  schema: typeof G08_CHECKPOINT_SCHEMA;
  actionSet: ActionSet;
  messageMode: MessageMode;
  /** Complete G08 game state: world, sessions, budgets, rotation, deadlines, mailbox history stays in communication. */
  game: G08GameCheckpoint;
  /** G07 mailbox snapshot restored verbatim; restore never re-delivers bound messages. */
  communication: MailboxSnapshot;
}

/** Runtime resources for an envelope restore; config must match the save. */
export interface G08CheckpointRuntime extends GameRestoreRuntime {
  /** Must equal the saved actionSet; a mismatch refuses with MODE_CONFLICT. */
  actionSet: ActionSet;
  /** Must equal the saved messageMode; a mismatch refuses with MODE_CONFLICT. */
  messageMode: MessageMode;
}

/* ------------------------------------------------------------------ */
/* Record/status extensions used by B and D                            */
/* ------------------------------------------------------------------ */

/** ReactiveRecord with the G08 schema and the capability/deadline fields. */
export interface G08ReactiveRecord extends Omit<ReactiveRecord, 'schema'> {
  schema: typeof G08_GAME_SCHEMA;
  actionSet: ActionSet;
  /** Per-actor deadlines at snapshot time; null for actors without one. */
  wakeAtSimTime: Record<string, number | null>;
}

/** ReactiveStatus plus the capability axis and per-actor deadlines. */
export interface G08ReactiveStatus extends ReactiveStatus {
  actionSet: ActionSet;
  /** Current authoritative simulated time (same value the deadline compares against). */
  simTime: number;
  wakeAtSimTime: Record<string, number | null>;
}

/*
 * Prompt capability line (frozen here, implemented in renderDecidePrompt):
 * DecideInput gains `allowedActions?: ActionSet`. Undefined keeps every
 * pre-G08 prompt byte-identical. When present the G08 shared template is
 * used for BOTH arms; the only varying lines are the `allowedActions` data
 * line and (G07 axis) the `playerMessages` lines.
 *
 * Frozen G08 template lines (legacy shown; timed_wait appends the wait line
 * and extends the data line to ["move","eat","stop","wait"]):
 *   Reply with one JSON object and no other text.
 *   allowedActions: ["move","eat","stop"]
 *   Do not set actorId or commandId. World changes happen only through Engine.submit.
 *   hunger is satiety: higher means fuller.
 *   Eat only in the kitchen. Each eat consumes <EAT_FOOD_COST> food and restores <EAT_HUNGER_RESTORE> hunger, clamped to <HUNGER_MIN>..<HUNGER_MAX>.
 *   Observation includes only this actor, food at the current location, and reachable places. Distant food, other NPCs, and the global log are omitted.
 *   "stop" ends your current session; with food present it also ends your pursuit this cycle. In an empty kitchen stop still follows the outer restock-wait and new-cycle rules.
 *   ["wait" pauses your current session for one logical time step, then it resumes automatically. wait does not eat, move, or change the world.]
 *   [playerMessages lines, identical to G07 when the axis is present]
 *   goal: hunger >= <n>
 *   observation: <json>
 *   feedback: <json>
 */
