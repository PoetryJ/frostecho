import type { CommandResult, Location, WorldEvent, WorldState } from '../types';

/**
 * G01 closed loop. The model sees an Observation, the hunger goal, and the
 * previous step's feedback. World state changes only through WorldPort.submit
 * (Engine.submit in production). Debug traces and secrets stay out of DecideInput.
 *
 * hunger is satiety: a higher value means fuller. The goal is hunger >= 70.
 */

export const GOAL_HUNGER_AT_LEAST = 70;
export const MAX_PROVIDER_CALLS = 5;
export const DEFAULT_TIMEOUT_MS = 15_000;

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
}

export interface Provider {
  /** Raw model text. Must stop when signal aborts; the runner ignores late results. */
  decide(input: DecideInput, signal: AbortSignal): Promise<string>;
}

/** The only three actions the parser can accept. */
export type AgentAction =
  | { type: 'move'; to: Location }
  | { type: 'eat' }
  | { type: 'stop' };

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
   * Clock for timing stats only. Decisions, command ids, and submits do not
   * read the returned values. Default Date.now.
   */
  now?: () => number;
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
  /** Parse error, engine rejection, timeout, or transport error. */
  error?: string;
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
