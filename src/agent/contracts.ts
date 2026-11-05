import type { CommandResult, Location, WorldEvent, WorldState } from '../types';
import type { ActionSet, SessionWaitState, WaitAction } from '../temporal/contracts';
import {
  G09_SESSION_SCHEMA,
  type GoalArm, type GoalBinding, type GoalChoiceId, type GoalOutcome, type GoalRequestStatus,
} from '../negotiation/contracts';

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
  /**
   * G09 (opt-in): present on the goal-choice step. The renderer answers with
   * the frozen goal prompt instead of an action prompt.
   */
  goalChoice?: GoalChoiceContext;
  /**
   * G09 (opt-in): the frozen binding line rendered into the action prompt
   * once the goal phase has decided. Undefined keeps the prompt unchanged.
   */
  goalLine?: string;
  /**
   * G10 (opt-in): the STRUCTURED active goal of this action session, derived
   * from the authoritative goal decision and the request contract — never
   * from the goal-phase prompt text. When present it is the ONLY current
   * goal rendered into the action prompt (the historical `goal: hunger >= n`
   * line is replaced for yield_once and kept for feed_self).
   */
  activeGoal?: ActiveGoal;
}

/**
 * G10: the action phase's structured current goal.
 * - feed_self: the request was declined; the session keeps its hunger target.
 * - yield_once: the agreement is the goal; it is fulfilled only when the
 *   player actually eats before expiresAtSimTime.
 */
export type ActiveGoal =
  | { kind: 'feed_self'; hungerAtLeast: number }
  | { kind: 'yield_once'; requestId: string; expiresAtSimTime: number };

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
  /** G10: the raw wire finish_reason (stop|length|null|...), kept verbatim. */
  finishReason?: string | null;
  /**
   * G10: the response classification, when the body could be inspected:
   * OUTPUT_TRUNCATED (finish_reason=length — never executed even if the text
   * looks like JSON), EMPTY_FINAL_OUTPUT, MISSING_CONTENT,
   * INVALID_RESPONSE_JSON. Absent on transport failures (status is kept).
   */
  classification?: string | null;
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
  /** G09: authoritative command-ledger length (the acceptance seq boundary). */
  logLength?(): number;
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
   * G09 (opt-in): enables the two-phase protocol in this session. The FIRST
   * provider call renders the frozen goal-choice prompt instead of an action
   * prompt; the parsed goal becomes the binding and is carried into every
   * later action prompt. Both phases are charged to the same budget.
   */
  goalProtocol?: GoalProtocolOptions;
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
  /**
   * G09 (opt-in): the authoritative request-store bridge. At the receive point
   * the session re-reads the CURRENT world and the CURRENT request — never a
   * pre-await snapshot and never the attach-time seq. Without a host the
   * session falls back to the world's own clock (unit-test sessions).
   */
  goalHost?: GoalHostPort;
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
  /**
   * G09: present on the goal-choice step (the session's first provider call
   * when the protocol is enabled). goal is null when the raw answer failed
   * the strict parser — such a session is terminal invalid_run.
   */
  goal?: { requestId: string | null; goal: GoalChoiceId | null; decidedRound: number; decidedAtSimTime: number; parseOk: boolean };
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
  | 'invalid_run'
  /** G09: the protocol needs two calls but fewer remain — nothing was spent. */
  | 'insufficient_budget'
  /** G09: the request expired before the answer arrived; the answer was dropped. */
  | 'request_expired'
  /** G09: the selected yield goal ran its course (fulfilment is judged outside). */
  | 'selected_goal_yield'
  /** G09: a committed provider call failed after the item was recorded. */
  | 'failed';

/** Separate from the deterministic record. Not passed to the provider. */
export interface RunTiming {
  totalMs: number;
  calls: { round: number; ms: number }[];
}

export interface RunResult {
  runId: string;
  actorId: string;
  outcome: RunOutcome;
  /**
   * The SELECTED goal's authoritative result: for a bound yield_once promise
   * that is the request outcome (fulfilled), never the NPC's own hunger; for
   * every other session it stays the original hunger rule (>= 70).
   */
  goalReached: boolean;
  /** True only when the authoritative final hunger is >= 70 (independent axis). */
  hungerNeedSatisfied: boolean;
  /** True only when the bound yield request's outcome is fulfilled. */
  selectedGoalReached: boolean;
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
  /** G09: a committed call produced a state the protocol cannot accept. */
  | 'failed'
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
  /**
   * G09: the frozen goal protocol this session runs, or null for a plain
   * action session. Set at creation and restored verbatim from a checkpoint.
   */
  readonly goalProtocol: GoalProtocolOptions | null;
  /** G09: attach the protocol before the first call (false when already used). */
  attachGoalProtocol?(protocol: GoalProtocolOptions): boolean;
  /**
   * G09: the binding this session's goal phase produced, or null while the
   * protocol has not been decided. A restored session carries its binding —
   * it never chooses again.
   */
  readonly goalBinding: GoalBinding | null;
  /** G09: which phase the next step belongs to. */
  readonly phase: 'goal_choice' | 'action';
  /**
   * G09: the goal decision this session made (feed_self or yield_once). A
   * feed_self decision is a legal choice, not a failure: it still closes the
   * goal phase so the same session never asks again.
   */
  readonly goalDecision: GoalDecisionRecord | null;
  /**
   * G11: read-only classification of the bound yield promise against the
   * AUTHORITATIVE request (never the local hunger). Zero provider calls.
   */
  goalSettlement(): GoalSettlementState;
  /**
   * G11: settle an ENDED yield promise with zero provider calls — clears the
   * wait deadline, ends this session as stopped and never re-asks the old
   * goal. Returns false while the promise is still pending (or for a plain
   * session), true when the session is settled (idempotent).
   */
  settleEndedGoal(): boolean;
}

/**
 * G11: what the authoritative request says about a bound yield promise.
 * 'pending' means the promise is still live and the ordinary wait/decision
 * rules apply; the other three are terminal and must never be re-asked.
 */
export type GoalSettlementState = 'not_applicable' | 'pending' | 'fulfilled' | 'expired' | 'violated';

/** G09: the frozen per-session goal protocol configuration. */
export interface GoalProtocolOptions {
  arm: GoalArm;
  /** The structured request this session answers (host-only). */
  requestId: string;
  text: string;
  options: readonly GoalChoiceId[];
  /** Engine logical time at which the request expires (createdAt + 1). */
  expiresAtSimTime: number;
  playerId: string;
  /** The command seq already applied when the request was accepted. */
  acceptedAfterSeq?: number;
}

/**
 * G09: what the renderer needs beyond the plain observation. DecidedInput
 * carries this on the goal step; the frozen prompt builder does the rest.
 */
export interface GoalChoiceContext extends GoalProtocolOptions {
  simTime: number;
}

/** G09: the recorded goal decision (both goals, host side only). */
export interface GoalDecisionRecord {
  requestId: string;
  goal: GoalChoiceId;
  decidedRound: number;
  decidedAtSimTime: number;
  raw: string;
}

/** G09 session checkpoint: the G08 fields plus the protocol and the binding. */
export interface G09SessionCheckpoint {
  schema: typeof G09_SESSION_SCHEMA;
  goalProtocol: GoalProtocolOptions;
  goalBinding: GoalBinding | null;
  goalDecision: GoalDecisionRecord | null;
}

/** G09: the authoritative request as the session must see it at a receive point. */
export interface GoalRequestView {
  requestId: string;
  status: GoalRequestStatus;
  outcome: GoalOutcome;
  expiresAtSimTime: number;
  acceptedAfterSeq: number | null;
}

/**
 * G09: the host's request-store bridge. Every method reads the CURRENT
 * authoritative state; nothing is cached from attach time. The game folds its
 * command ledger into the store before answering.
 */
export interface GoalHostPort {
  /**
   * Fold the authoritative ledger tail into the request store, expire what is
   * due at the current simTime, then return the request as of NOW.
   */
  refresh(requestId: string): GoalRequestView | null;
  /** Fold the ledger tail only (no expiry sweep), after an ordinary command. */
  fold(): void;
  /**
   * Record the session's answer at the receive point: the acceptance seq is
   * the caller's currentSeq (the world's log length at response arrival), not
   * the attach-time seq. Returns the binding when the store accepted it.
   */
  accept(decision: GoalDecisionRecord, currentSeq: number, simTime: number): GoalBinding | null;
  /** The selected goal's current request view (result()), or null when unknown. */
  outcome(requestId: string): GoalRequestView | null;
}
