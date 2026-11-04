import type { CommandResult, Location, WorldEvent, WorldState } from '../types';
import type { ActionSet, SessionWaitState, WaitAction } from '../temporal/contracts';

/**
 * G01 closed loop. The model sees an Observation, the hunger goal, and the
 * previous step's feedback. World state changes only through WorldPort.submit
 * (Engine.submit in production). Debug traces and secrets stay out of DecideInput.
 *
 * hunger is satiety: a higher value means fuller. The goal is hunger >= 70.
 */

export const GOAL_HUNGER_AT_LEAST = 70;
export const MAX_PROVIDER_CALLS = 5;
/** Runner default when a caller does not pass timeoutMs. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Live and eval decision timeout. A thinking completion near 15s must not be aborted.
 * FROSTECHO_LIVE_TIMEOUT_MS overrides this. There is no implicit retry.
 */
export const LIVE_DECISION_TIMEOUT_MS = 30_000;

/** What one NPC can see. No other NPC, no other place's food, no global log. */
export interface Observation {
  /** This actor's own id. */
  id: string;
  location: Location;
  /** Satiety. Higher means fuller. */
  hunger: number;
  /** Food at the actor's current location only. */
  foodHere: number;
  /** Legal place names the actor may use in a move. */
  reachable: Location[];
}

export type FeedbackKind = 'accepted' | 'rejected' | 'invalid_output';

/** Previous step only. This is the sole memory passed back into the model. */
export interface StepFeedback {
  round: number;
  kind: FeedbackKind;
  detail: string;
  /** Engine rejection reason, when a command was submitted and not accepted. */
  reason?: string;
}

export interface DecideInput {
  observation: Observation;
  /** Satisfied only when the authoritative hunger is >= hungerAtLeast. */
  goal: { hungerAtLeast: number };
  /** Null on the first provider call. */
  feedback: StepFeedback | null;
  /**
   * G07 (opt-in): player requests visible to this actor, or [] when the
   * message arm is off. Undefined for every pre-G07 input, which keeps the
   * original prompt byte-identical. Data only — never rules or authority.
   */
  playerMessages?: readonly PlayerMessageInput[];
  /**
   * G08 (opt-in): the capability axis. 'legacy' renders the G08 shared
   * template with the legacy action set; 'timed_wait' additionally allows
   * {"type":"wait"} and its explanation line. Undefined keeps every pre-G08
   * prompt byte-identical and makes the parser reject wait.
   */
  allowedActions?: ActionSet;
}

/** Minimal message content exposed to the model: sender and text only. */
export interface PlayerMessageInput {
  sender: string;
  text: string;
}

/** Token counts copied from a chat-completions `usage` object, when the server sends one. */
export interface UsageStats {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}

/**
 * One HTTP exchange. The API key and request URL are never stored.
 * A late body after abort does not replace an error already recorded here.
 */
export interface TransportRecord {
  requestBody: Record<string, unknown>;
  responseContent: unknown;
  status: number | null;
  usage: UsageStats | null;
  latencyMs: number;
  error: string | null;
}

export interface Provider {
  /** Raw model text. Must stop when signal aborts; the runner ignores late results. */
  decide(input: DecideInput, signal: AbortSignal): Promise<string>;
  /**
   * HTTP adapter only. Returns the exchange for the decide() that just settled,
   * then clears it. Absent on the reference policy.
   */
  consumeTransport?(): TransportRecord | null;
}

/**
 * The actions the parser can accept. G08: with actionSet 'timed_wait' the
 * parser additionally accepts exactly {"type":"wait"}; the legacy action set
 * still accepts move/eat/stop only.
 */
export type AgentAction =
  | { type: 'move'; to: Location }
  | { type: 'eat' }
  | { type: 'stop' }
  | WaitAction;

export type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

/**
 * Test doubles implement this. getEvents returns the full history in order.
 * submit is the only mutating method.
 */
export interface WorldPort {
  getState(): WorldState;
  submit(command: unknown): CommandResult;
  getEvents(): WorldEvent[];
}

export type SubmittedCommand =
  | { commandId: string; actorId: string; type: 'move'; payload: { to: Location } }
  | { commandId: string; actorId: string; type: 'eat'; payload: Record<string, never> };

export interface RunOptions {
  world: WorldPort;
  provider: Provider;
  /** Fixed by the caller. The model cannot choose it. */
  actorId: string;
  /** Unique per run. Tests pin it. Command ids are `${runId}:${round}`. */
  runId: string;
  /** Aborts the provider call. Default 15000. */
  timeoutMs?: number;
  /**
   * G08 (opt-in): the capability axis for this session. 'timed_wait' makes the
   * parser accept {"type":"wait"} and the runner render the G08 prompt with
   * the wait action. Undefined keeps the pre-G08 behaviour and prompt.
   */
  actionSet?: ActionSet;
  /**
   * Clock for timing stats only. Decisions, command ids, and submits do not
   * read the returned values. Default Date.now.
   */
  now?: () => number;
  /**
   * Command id for a decision round. Default `${runId}:${round}` (G01).
   * G02 passes `${batchId}:npc:${round}` so player and NPC ids do not collide.
   */
  commandIdFor?(round: number): string;
  /**
   * G06: declares the command-id formula in use so the session can be
   * checkpointed. Required when a custom commandIdFor is passed; a custom
   * formula without a scheme refuses export instead of guessing.
   */
  commandIdScheme?: 'run-round' | 'g06-episode-cycle';
  /**
   * Test hook for the decision timeout. Default is setTimeout.
   * The returned cancel runs when the call settles. Ordering tests fire `fn`
   * themselves instead of sleeping.
   */
  scheduleTimeout?(fn: () => void, ms: number): { cancel(): void };
  /**
   * Called after this step's provider call has started and before that call's
   * text is consumed. The observation for this step is already fixed.
   * Player commands issued here still submit against the world after the call returns.
   */
  onDeciding?(info: { round: number; observation: Observation }): void | Promise<void>;
}

export interface StepRecord {
  round: number;
  observation: Observation;
  /** Empty when the provider produced no accepted output (timeout or transport). */
  raw: string;
  parse: ParseResult;
  /** Present only when a world command was submitted. Stop never sets this. */
  command?: SubmittedCommand;
  exec?: CommandResult;
  /**
   * G08: present on a wait step. wakeAtSimTime is the accepted deadline, or
   * null when the budget took precedence (no recoverable deadline).
   */
  wait?: { wakeAtSimTime: number | null };
  /** Parse error, engine rejection, timeout, or transport error. */
  error?: string;
  /** Present only for an HTTP provider call. Omitted by the reference policy. */
  transport?: TransportRecord;
}

export type RunOutcome =
  | 'goal_reached'
  | 'stopped'
  | 'budget_exhausted'
  | 'timeout'
  | 'provider_error'
  | 'invalid_run';

/** Separate from the deterministic record. Not passed to the provider. */
export interface RunTiming {
  totalMs: number;
  calls: { round: number; ms: number }[];
}

export interface RunResult {
  runId: string;
  actorId: string;
  outcome: RunOutcome;
  /** True only when the authoritative final hunger is >= 70. A model stop is not enough. */
  goalReached: boolean;
  providerCalls: number;
  steps: StepRecord[];
  initialState: WorldState;
  events: WorldEvent[];
  finalState: WorldState;
  timing: RunTiming;
  error?: string;
}

export type SessionStatus =
  | 'ready'
  | 'deciding'
  | 'goal_reached'
  | 'stopped'
  | 'budget_exhausted'
  | 'timeout'
  | 'provider_error'
  | 'invalid_run'
  /** G08: non-terminal. The session pauses until simTime reaches wakeAtSimTime. */
  | 'waiting_time';

/**
 * G06: which command-id formula this session uses. 'g06-episode-cycle' is
 * `${episodeId}:npc:${actorId}:${cycle}:${round}`; 'run-round' is the G01
 * default `${runId}:${round}`. 'unknown' marks a custom commandIdFor without
 * a declared scheme — such a session refuses to be checkpointed.
 */
export type CommandIdScheme = 'run-round' | 'g06-episode-cycle' | 'unknown';

export interface DecidingPhase {
  round: number;
  observation: Observation;
}

export interface StepAgentResult {
  /** `busy` means a step is already in flight. No new provider call was made. */
  status: SessionStatus | 'busy';
  terminal: boolean;
  providerCalled: boolean;
  step?: StepRecord;
}

/**
 * One NPC loop that can be stepped. `runAgent` is this session driven to a terminal status.
 * `round` is the decision round in flight, or the last started round. It is 0 before the first step.
 */
export interface AgentSession {
  readonly runId: string;
  readonly actorId: string;
  round: number;
  feedback: StepFeedback | null;
  status: SessionStatus;
  providerCalls: number;
  readonly steps: readonly StepRecord[];
  /** G06: the declared command-id formula ('unknown' = custom, not checkpointable). */
  readonly commandIdScheme: CommandIdScheme;
  /** Replaces RunOptions.onDeciding. Scenarios set this before the step that must be interleaved. */
  onDeciding?: (info: DecidingPhase) => void | Promise<void>;
  /** Resolves immediately when a step is already inside decide. */
  whenDeciding(): Promise<DecidingPhase>;
  /** Terminal run record. Call it after status has left `ready` and `deciding`. */
  result(): RunResult;
  /**
   * G08 capability axis of this session. 'legacy' unless RunOptions opted in;
   * every session exposes the same members so the scheduler never duck-types.
   */
  readonly actionSet: ActionSet;
  /** Single wait deadline source; null unless status is 'waiting_time'. */
  readonly wakeAtSimTime: number | null;
  /**
   * Resume only when waiting_time and nowSimTime >= wakeAtSimTime: back to
   * ready, no provider call, no new cycle, round/feedback/budget kept.
   * Exactly one resume per accepted wait.
   */
  resumeIfDue(nowSimTime: number): boolean;
  /**
   * Terminal budget_exhausted and deadline clear (the episode-level limit
   * reached while paused). Terminal sessions never revive.
   */
  exhaustBudget(detail: string): void;
  /** Deep-copied wait projection for records and checkpoints. */
  waitState(): SessionWaitState;
}
