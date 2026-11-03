/**
 * G04 workstream B — conditional continuation over the G03 substrate.
 *
 * One authoritative Engine holds the world; each NPC runs in cycles. A cycle is
 * one AgentSession with its own 5-call budget. The episode keeps a second,
 * per-actor budget of 10 calls that a new cycle never resets. All provider work
 * is serialised by a single in-flight guard, so "1 request in flight" is a
 * property of the object, not of its callers.
 *
 * Wake-ups are notification-driven: restock/player input calls reconcile(),
 * which re-reads each waiting actor's own observation. There is no polling.
 */
import { createAgentSession, stepAgent } from '../agent/runner';
import { GOAL_HUNGER_AT_LEAST, type AgentSession, type Observation, type SessionStatus, type StepAgentResult, type StepFeedback } from '../agent/contracts';
import { observe } from '../agent/observation';
import { Engine, replay } from '../engine';
import type { LogEntry } from '../engine';
import type { Location, WorldState } from '../types';
import { canonical } from '../util';
import { HTTP_SAMPLING } from '../agent/providers/http';
import {
  EPISODE_CALL_LIMIT, G04_SCHEMA, G05_SCHEMA, NEED_REACTIVATE_HUNGER,
  PLAYER_ACTOR_ID, WORLD_ACTOR_ID,
  type AdvanceTimeResult, type NeedPolicy,
  type ReactiveActorState, type ReactiveActorSummary, type ReactiveAdvanceOutcome, type ReactiveCycleRecord,
  type ReactiveGame, type ReactiveGameOptions, type ReactiveRecord, type ReactiveStopReason, type ReactiveTransition,
  type ReactiveTurnRecord, type RestockResult,
} from './contracts';
import { canWake, describeObservation, isTerminalStatus, isWaitingObservation } from './lifecycle';
import { exportSessionCheckpoint, restoreAgentSession } from '../agent/checkpoint';
import {
  G06_CHECKPOINT_SCHEMA,
  type GameCheckpoint, type GameCycleCheckpoint, type SessionCheckpoint,
} from '../persistence/contracts';
import { G08_GAME_SCHEMA, type ActionSet, type G08GameCheckpoint, type G08GameCycleCheckpoint } from '../temporal/contracts';

interface CycleState {
  cycle: number;
  /** G05: opening reason (autonomous wake vs need cycle). */
  reason: string;
  session: AgentSession;
  turns: ReactiveTurnRecord[];
  startLogCursor: number;
  endState: ReactiveActorState;
}

const TERMINAL_STATES: ReadonlySet<ReactiveActorState> = new Set<ReactiveActorState>(['satisfied', 'stopped', 'failed', 'budget_exhausted']);

export interface ParsedPlayerLine {
  kind: 'move' | 'eat' | 'blank' | 'invalid';
  to?: Location;
  error?: string;
}

/** Player grammar: 'player move dorm|kitchen' | 'player eat'. */
export function parsePlayerLine(line: string): ParsedPlayerLine {
  const text = line.trim();
  if (!text) return { kind: 'blank' };
  if (text === 'player eat') return { kind: 'eat' };
  if (text === 'player move dorm') return { kind: 'move', to: 'dorm' };
  if (text === 'player move kitchen') return { kind: 'move', to: 'kitchen' };
  return { kind: 'invalid', error: `unknown player command ${JSON.stringify(text)}` };
}

export class ReactiveGameImpl implements ReactiveGame {
  readonly episodeId: string;
  readonly world: Engine;
  readonly actorIds: readonly string[];
  readonly wakePolicy: ReactiveGameOptions['wakePolicy'];
  readonly mode: ReactiveGameOptions['mode'];
  readonly thinking: boolean;
  private needPolicy: NeedPolicy;
  private readonly recordSchema: typeof G04_SCHEMA | typeof G05_SCHEMA | typeof G08_GAME_SCHEMA;
  /** G08: capability axis; undefined keeps pre-G08 behaviour. */
  readonly actionSet: ActionSet | undefined;

  private readonly states: Record<string, ReactiveActorState> = {};
  private readonly cycles: Record<string, CycleState[]> = {};
  private readonly transitions: ReactiveTransition[] = [];
  private readonly nowFn: () => number;
  private readonly startedAt: number;
  private readonly initialState: WorldState;
  private readonly timeoutMs: number;
  private globalTurn = 0;
  private cursor = 0;
  private playerSeq = 1;
  private worldSeq = 1;
  private busy = false;
  private closed = false;
  private interrupted = false;
  private lastInterruptedActor: string | null = null;
  private totalCalls = 0;
  private idlePumps: ReactiveRecord['idlePumps'] = {
    pumps: 0, callsBefore: 0, callsAfter: 0, cyclesBefore: 0, cyclesAfter: 0, actorStatesBefore: {}, actorStatesAfter: {},
  };

  constructor(private readonly options: ReactiveGameOptions) {
    this.episodeId = options.episodeId;
    this.actorIds = [...options.actorIds];
    this.wakePolicy = options.wakePolicy;
    this.mode = options.mode;
    this.thinking = options.thinking;
    this.needPolicy = options.needPolicy ?? 'one-shot';
    this.recordSchema = options.actionSet !== undefined ? G08_GAME_SCHEMA : (options.schemaVersion ?? G04_SCHEMA);
    this.actionSet = options.actionSet;
    this.nowFn = options.now ?? Date.now;
    this.startedAt = this.nowFn();
    this.initialState = structuredClone(options.initialState);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.world = new Engine(structuredClone(options.initialState));
    for (const actorId of this.actorIds) {
      this.cycles[actorId] = [];
    }
    // The first cycle starts before any world input, so every actor's cycle 1
    // begins at log cursor 0 with a fresh session.
    for (const actorId of this.actorIds) this.openCycle(actorId, 'initial cycle');
  }

  /* ---------------------------------------------------------------- */
  /* cycles and transitions                                            */
  /* ---------------------------------------------------------------- */

  private actorCycles(actorId: string): CycleState[] {
    return this.cycles[actorId] ?? [];
  }

  private activeCycle(actorId: string): CycleState | null {
    const list = this.actorCycles(actorId);
    return list.length > 0 ? list[list.length - 1] : null;
  }

  private callsOf(actorId: string): number {
    return this.actorCycles(actorId).reduce((sum, cycle) => sum + cycle.session.providerCalls, 0);
  }

  private observe(actorId: string): Observation {
    return observe(this.world.getState(), actorId);
  }

  private transition(actorId: string, to: ReactiveActorState, reason: string): void {
    const from = this.states[actorId] ?? null;
    const cycle = this.activeCycle(actorId);
    let observation: Observation | null = null;
    try {
      observation = this.observe(actorId);
    } catch {
      observation = null;
    }
    this.transitions.push({
      seq: this.transitions.length + 1,
      actorId,
      cycle: cycle?.cycle ?? 0,
      from,
      to,
      reason,
      observation,
      logCursor: this.world.getLog().length,
    });
    this.states[actorId] = to;
  }

  private openCycle(actorId: string, reason: string): CycleState {
    const previous = this.activeCycle(actorId);
    if (previous && !TERMINAL_STATES.has(previous.endState)) previous.endState = this.states[actorId] ?? 'stopped';
    const cycle = (previous?.cycle ?? 0) + 1;
    const session = createAgentSession({
      world: this.world,
      provider: this.options.providerFor(actorId),
      actorId,
      runId: `${this.episodeId}:${actorId}:c${cycle}`,
      timeoutMs: this.timeoutMs,
      now: this.options.now,
      scheduleTimeout: this.options.scheduleTimeout,
      commandIdFor: round => `${this.episodeId}:npc:${actorId}:${cycle}:${round}`,
      commandIdScheme: 'g06-episode-cycle',
      ...(this.actionSet !== undefined ? { actionSet: this.actionSet } : {}),
    });
    if (this.options.onDeciding) {
      const hook = this.options.onDeciding;
      session.onDeciding = phase => hook({ actorId, cycle, round: phase.round, observation: phase.observation });
    }
    const state: CycleState = {
      cycle,
      reason,
      session,
      turns: [],
      startLogCursor: this.world.getLog().length,
      endState: 'active',
    };
    this.actorCycles(actorId).push(state);
    this.transition(actorId, 'active', `${reason} (cycle ${cycle})`);
    return state;
  }

  /* ---------------------------------------------------------------- */
  /* stepping                                                          */
  /* ---------------------------------------------------------------- */

  private async stepActor(actorId: string): Promise<ReactiveAdvanceOutcome> {
    const cycle = this.activeCycle(actorId);
    if (cycle === null) return { kind: 'idle' };
    if (this.states[actorId] !== 'active') return { kind: 'idle' };
    // G05-R1: no exemptions — the per-actor episode budget binds every cycle.
    if (this.callsOf(actorId) >= EPISODE_CALL_LIMIT) {
      this.transition(actorId, 'budget_exhausted', `per-actor budget ${EPISODE_CALL_LIMIT} exhausted across cycles`);
      cycle.endState = 'budget_exhausted';
      return { kind: 'idle' };
    }
    if (isTerminalStatus(cycle.session.status)) return { kind: 'idle' };
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    const logBefore = this.world.getLog().length;
    const feedback: StepFeedback | null = cycle.session.feedback ? { ...cycle.session.feedback } : null;
    try {
      const result = await stepAgent(cycle.session);
      this.recordTurn(actorId, cycle, result, feedback, logBefore);
      this.afterStep(actorId, cycle, result);
      return {
        kind: 'stepped',
        actorId,
        cycle: cycle.cycle,
        result: { status: result.status, terminal: result.terminal, providerCalled: result.providerCalled },
      };
    } finally {
      this.busy = false;
    }
  }

  private recordTurn(actorId: string, cycle: CycleState, result: StepAgentResult, feedback: StepFeedback | null, logBefore: number): void {
    this.globalTurn += 1;
    cycle.turns.push({
      globalTurn: this.globalTurn,
      actorId,
      cycle: cycle.cycle,
      actorRound: result.step?.round ?? cycle.session.round,
      observation: (result.step?.observation ?? this.observe(actorId)) as Observation,
      inputFeedback: feedback,
      providerCalled: result.providerCalled,
      status: result.status,
      logCursorBefore: logBefore,
      logCursorAfter: this.world.getLog().length,
      step: result.step,
    });
    if (result.providerCalled) this.totalCalls += 1;
  }

  private afterStep(actorId: string, cycle: CycleState, result: StepAgentResult): void {
    if (result.status === 'waiting_time') {
      // G08: the session pauses on logical time. The cycle stays open (same
      // session resumes at the deadline), no terminal state is assigned, and
      // the round-robin simply skips this actor until the deadline passes.
      this.transition(actorId, 'timed_wait', `wait: session paused until simTime ${cycle.session.wakeAtSimTime ?? '?'}`);
      return;
    }
    if (result.status === 'timeout' || result.status === 'provider_error') {
      this.interrupted = true;
      this.lastInterruptedActor = actorId;
      cycle.endState = 'failed';
      this.transition(actorId, 'failed', `transport ${result.status}`);
      return;
    }
    // Success is judged on the authoritative post-exec hunger (>= GOAL), never
    // on a stale observation: an accepted eat that only reaches 60 keeps the
    // current session running until 70+.
    if (!result.terminal) return;
    if (result.status === 'goal_reached') {
      cycle.endState = 'satisfied';
      this.transition(actorId, 'satisfied', 'authoritative hunger reached the goal');
      return;
    }
    if (result.status === 'budget_exhausted') {
      cycle.endState = 'budget_exhausted';
      this.transition(actorId, 'budget_exhausted', 'session budget exhausted');
      return;
    }
    const observation = result.step?.observation ?? null;
    if (this.wakePolicy === 'event' && observation !== null && isWaitingObservation(observation)) {
      cycle.endState = 'waiting';
      this.transition(actorId, 'waiting', `stop with an empty kitchen while hungry (${describeObservation(observation)})`);
      return;
    }
    cycle.endState = this.wakePolicy === 'event' ? 'stopped' : 'stopped';
    this.transition(actorId, 'stopped', `stop (${observation === null ? 'no observation' : describeObservation(observation)})`);
  }

  /* ---------------------------------------------------------------- */
  /* wake-ups                                                          */
  /* ---------------------------------------------------------------- */

  /** An active actor that has spent its episode budget can never run again. */
  private settleBudgetStates(): void {
    for (const actorId of this.actorIds) {
      if (this.states[actorId] !== 'active') continue;
      if (this.callsOf(actorId) < EPISODE_CALL_LIMIT) continue;
      const cycle = this.activeCycle(actorId);
      if (cycle !== null) cycle.endState = 'budget_exhausted';
      this.transition(actorId, 'budget_exhausted', `per-actor budget ${EPISODE_CALL_LIMIT} exhausted`);
    }
  }

  /**
   * Re-read every actor's own authoritative state. Waiting actors wake only on
   * real local food (restock/player input). Under the recurring need policy a
   * satisfied actor whose own current hunger is at/below NEED_REACTIVATE_HUNGER
   * opens exactly one new cycle; above it, it rests. Ordinary stops, failures
   * and budget exhaustion never resurrect. No provider call happens here.
   */
  reconcile(): void {
    for (const actorId of this.actorIds) {
      const lifecycle = this.states[actorId];
      if (lifecycle === 'timed_wait') {
        // G08: the episode budget binds even a paused session — reaching the
        // actor limit while waiting ends the session with no recoverable
        // deadline. Otherwise the actor resumes exactly once when the
        // authoritative simTime reaches the deadline; the SAME cycle and
        // session continue, no new cycle opens, no provider call is made.
        const cycle = this.activeCycle(actorId);
        if (cycle === null) continue;
        if (this.callsOf(actorId) >= EPISODE_CALL_LIMIT) {
          cycle.session.exhaustBudget(`per-actor budget ${EPISODE_CALL_LIMIT} exhausted while waiting for time`);
          cycle.endState = 'budget_exhausted';
          this.transition(actorId, 'budget_exhausted', `per-actor budget exhausted while waiting for time`);
          continue;
        }
        const now = this.world.getState().simTime ?? 0;
        if (cycle.session.resumeIfDue(now)) {
          this.transition(actorId, 'active', `wait over: simTime ${now} reached the deadline`);
        }
        continue;
      }
      if (lifecycle === 'satisfied') {
        if (this.needPolicy !== 'recurring') continue;
        if (this.callsOf(actorId) >= EPISODE_CALL_LIMIT) continue;
        const hunger = this.world.getState().npcs[actorId]?.hunger;
        if (typeof hunger !== 'number' || hunger > NEED_REACTIVATE_HUNGER) continue;
        this.openCycle(actorId, `need reactivation: hunger ${hunger} <= ${NEED_REACTIVATE_HUNGER} after a satisfied cycle`);
        continue;
      }
      if (lifecycle !== 'waiting') continue;
      if (this.callsOf(actorId) >= EPISODE_CALL_LIMIT) {
        const cycle = this.activeCycle(actorId);
        if (cycle) cycle.endState = 'budget_exhausted';
        this.transition(actorId, 'budget_exhausted', `per-actor budget exhausted while waiting`);
        continue;
      }
      let observation: Observation;
      try {
        observation = this.observe(actorId);
      } catch {
        continue;
      }
      if (!canWake(observation)) continue;
      this.openCycle(actorId, `wake: own observation has food (${describeObservation(observation)})`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */

  private pickReady(): string | null {
    if (this.actorIds.length === 0) return null;
    for (let offset = 0; offset < this.actorIds.length; offset++) {
      const index = (this.cursor + offset) % this.actorIds.length;
      const actorId = this.actorIds[index];
      if (this.states[actorId] !== 'active') continue;
      const cycle = this.activeCycle(actorId);
      if (cycle === null) continue;
      // Goal pre-check on the authoritative state: a cycle whose actor is
      // already at/above GOAL completes with zero provider calls (e.g. the
      // initial all-70 world). goalReached is never confused with "the
      // previous cycle completed".
      const hunger = this.world.getState().npcs[actorId]?.hunger;
      if (typeof hunger === 'number' && hunger >= GOAL_HUNGER_AT_LEAST) {
        cycle.endState = 'satisfied';
        this.transition(actorId, 'satisfied', `authoritative hunger ${hunger} >= ${GOAL_HUNGER_AT_LEAST} at cycle start; no provider call`);
        continue;
      }
      if (this.callsOf(actorId) >= EPISODE_CALL_LIMIT) continue;
      if (cycle.session.status !== 'ready') continue;
      this.cursor = (index + 1) % this.actorIds.length;
      return actorId;
    }
    return null;
  }

  async advance(): Promise<ReactiveAdvanceOutcome> {
    if (this.closed) return { kind: 'closed' };
    if (this.interrupted) return { kind: 'interrupted', actorId: this.lastInterruptedActor ?? '' };
    if (this.busy) return { kind: 'busy' };
    this.reconcile();
    const actorId = this.pickReady();
    if (actorId === null) {
      this.settleBudgetStates();
      return { kind: 'idle' };
    }
    return this.stepActor(actorId);
  }

  async runUntilIdle(): Promise<ReactiveAdvanceOutcome> {
    for (;;) {
      const outcome = await this.advance();
      if (outcome.kind === 'stepped') continue;
      return outcome;
    }
  }

  async close(): Promise<void> {
    // G04-R1-CLOSE: latch the closed flag synchronously so every entrypoint
    // (advance/player/world) rejects from this tick on, then wait only for the
    // in-flight step to finish its own bookkeeping (the runner's own timeout
    // bounds it). Idempotent: a repeated close adds no request and no wait.
    this.closed = true;
    while (this.busy) await new Promise<void>(resolve => setTimeout(resolve, 5));
  }

  playerLine(line: string): { ok: boolean; detail: string } {
    if (this.closed) return { ok: false, detail: 'game is closed' };
    const parsed = parsePlayerLine(line);
    if (parsed.kind === 'blank') return { ok: false, detail: 'blank' };
    if (parsed.kind === 'invalid') return { ok: false, detail: parsed.error ?? 'invalid' };
    const commandId = `${this.episodeId}:player:${PLAYER_ACTOR_ID}:${this.playerSeq}`;
    this.playerSeq += 1;
    const command = parsed.kind === 'move'
      ? { commandId, actorId: PLAYER_ACTOR_ID, type: 'move' as const, payload: { to: parsed.to as Location } }
      : { commandId, actorId: PLAYER_ACTOR_ID, type: 'eat' as const, payload: {} };
    const exec = this.world.submit(structuredClone(command));
    this.reconcile();
    return exec.status === 'accepted' ? { ok: true, detail: commandId } : { ok: false, detail: exec.reason ?? exec.status };
  }

  worldRestock(location: Location, amount: number, commandId?: string): RestockResult {
    const id = commandId ?? `${this.episodeId}:${WORLD_ACTOR_ID}:${this.worldSeq}`;
    if (commandId === undefined) this.worldSeq += 1;
    const command = { commandId: id, actorId: WORLD_ACTOR_ID, type: 'restock' as const, payload: { location, amount } };
    if (this.closed) return { ok: false, command, exec: { status: 'rejected', reason: 'closed', eventIds: [] }, error: 'game is closed' };
    const exec = this.world.submit(structuredClone(command));
    this.reconcile();
    return exec.status === 'accepted'
      ? { ok: true, command, exec: { status: exec.status, eventIds: [...exec.eventIds] } }
      : { ok: false, command, exec: { status: exec.status, reason: exec.reason, eventIds: [...exec.eventIds] }, error: exec.reason ?? exec.status };
  }

  /**
   * G05-R1: advance simulated time by steps. World input is accepted even while
   * a provider call is in flight (the in-flight step still executes against the
   * authoritative world afterwards); only submission + reconcile happen here,
   * never a provider call. The world command id sequence is shared with restock.
   */
  worldAdvanceTime(steps: number): AdvanceTimeResult {
    const command = {
      commandId: `${this.episodeId}:${WORLD_ACTOR_ID}:advance:${this.worldSeq}`,
      actorId: WORLD_ACTOR_ID,
      type: 'advance_time' as const,
      payload: { steps },
    };
    if (this.closed) return { ok: false, command, error: 'game is closed' };
    if (this.interrupted) return { ok: false, command, error: 'game is interrupted' };
    this.worldSeq += 1;
    const before = this.world.getState().simTime ?? 0;
    const exec = this.world.submit(structuredClone(command));
    if (exec.status !== 'accepted') {
      return { ok: false, command, error: `${exec.reason ?? exec.status}${exec.detail ? `: ${exec.detail}` : ''}` };
    }
    const after = this.world.getState().simTime ?? 0;
    this.reconcile();
    return { ok: true, command, before, after };
  }

  notifyWorldChange(): void {
    this.reconcile();
  }

  actorStateOf(actorId: string): ReactiveActorState {
    return this.states[actorId] ?? 'stopped';
  }

  cyclesOf(actorId: string): number {
    return this.actorCycles(actorId).length;
  }

  isClosed(): boolean {
    return this.closed;
  }

  isInterrupted(): boolean {
    return this.interrupted;
  }

  getNeedPolicy(): NeedPolicy {
    return this.needPolicy;
  }

  /** G05: interactive switch of the need scheduling policy (CLI `need` command). */
  setNeedPolicy(policy: NeedPolicy): void {
    this.needPolicy = policy;
  }

  setPumpCounters(pumps: number, before: { calls: number; cycles: number; states: Record<string, ReactiveActorState> }): void {
    const statesAfter: Record<string, ReactiveActorState> = {};
    for (const actorId of this.actorIds) statesAfter[actorId] = this.states[actorId];
    this.idlePumps = {
      pumps,
      callsBefore: before.calls,
      callsAfter: this.totalCalls,
      cyclesBefore: before.cycles,
      cyclesAfter: this.actorIds.reduce((sum, id) => sum + this.actorCycles(id).length, 0),
      actorStatesBefore: before.states,
      actorStatesAfter: statesAfter,
    };
  }

  pumpCounterSnapshot(): { calls: number; cycles: number; states: Record<string, ReactiveActorState> } {
    const states: Record<string, ReactiveActorState> = {};
    for (const actorId of this.actorIds) states[actorId] = this.states[actorId];
    return {
      calls: this.totalCalls,
      cycles: this.actorIds.reduce((sum, id) => sum + this.actorCycles(id).length, 0),
      states,
    };
  }

  status(): ReturnType<ReactiveGame['status']> {
    const state = this.world.getState();
    const actors: Record<string, { state: ReactiveActorState; cycle: number; providerCalls: number; hunger: number | null; location: Location | null }> = {};
    for (const actorId of this.actorIds) {
      const npc = state.npcs[actorId] ?? null;
      actors[actorId] = {
        state: this.states[actorId],
        cycle: this.activeCycle(actorId)?.cycle ?? 0,
        providerCalls: this.callsOf(actorId),
        hunger: npc?.hunger ?? null,
        location: npc?.location ?? null,
      };
    }
    const player = state.npcs[PLAYER_ACTOR_ID] ?? null;
    return {
      closed: this.closed,
      interrupted: this.interrupted,
      episodeId: this.episodeId,
      wakePolicy: this.wakePolicy,
      mode: this.mode,
      thinking: this.thinking,
      actors,
      player: { location: player?.location ?? null, hunger: player?.hunger ?? null },
      food: { ...state.food },
      simTime: state.simTime ?? 0,
      commands: this.world.getLog().length,
      events: this.world.getEvents().length,
      ...(this.actionSet !== undefined ? { actionSet: this.actionSet, wakeAtSimTime: this.wakeDeadlines() } : {}),
    };
  }

  /** G08: per-actor wait deadlines; null for actors without one. */
  private wakeDeadlines(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const actorId of this.actorIds) {
      const cycle = this.activeCycle(actorId);
      out[actorId] = cycle && cycle.session.status === 'waiting_time' ? cycle.session.wakeAtSimTime : null;
    }
    return out;
  }

  snapshot(): ReactiveRecord {
    const finalState = this.world.getState();
    const commands: LogEntry[] = this.world.getLog();
    const events = this.world.getEvents();
    const cyclesOut: Record<string, ReactiveCycleRecord[]> = {};
    const actors: Record<string, ReactiveActorSummary> = {};
    let allTerminal = true;
    for (const actorId of this.actorIds) {
      const list = this.actorCycles(actorId);
      cyclesOut[actorId] = list.map(cycle => ({
        cycle: cycle.cycle,
        reason: cycle.reason,
        startLogCursor: cycle.startLogCursor,
        endState: cycle.endState,
        turns: cycle.turns.map(turn => structuredClone(turn)),
        providerCalls: cycle.session.providerCalls,
      }));
      const live = this.activeCycle(actorId);
      if (live && !TERMINAL_STATES.has(live.endState)) live.endState = this.states[actorId];
      const hunger = finalState.npcs[actorId]?.hunger;
      actors[actorId] = {
        state: this.states[actorId],
        cycles: list.length,
        providerCalls: this.callsOf(actorId),
        goalReached: typeof hunger === 'number' && hunger >= GOAL_HUNGER_AT_LEAST,
      };
      if (!TERMINAL_STATES.has(this.states[actorId])) allTerminal = false;
    }
    const stopReason: ReactiveStopReason = this.interrupted ? 'interrupted' : allTerminal ? 'completed' : 'user_closed';
    const firstBody = this.firstRequestBody();
    return structuredClone({
      schema: this.recordSchema,
      episodeId: this.episodeId,
      scenarioId: null,
      wakePolicy: this.wakePolicy,
      mode: this.mode,
      thinking: this.thinking,
      actorOrder: [...this.actorIds],
      initialState: this.initialState,
      finalState,
      commands,
      events,
      cycles: cyclesOut,
      actors,
      transitions: this.transitions,
      stopReason,
      scenarioPass: null,
      replayMatches: canonical(replay(this.initialState, events)) === canonical(finalState),
      idlePumps: this.idlePumps,
      requestConfig: {
        model: typeof firstBody?.model === 'string' ? firstBody.model : this.options.requestModel ?? null,
        temperature: HTTP_SAMPLING.temperature,
        max_tokens: HTTP_SAMPLING.max_tokens,
        stream: HTTP_SAMPLING.stream,
        enableThinking: [this.thinking],
        timeoutMs: this.timeoutMs,
      },
      timing: { totalMs: Math.max(0, this.nowFn() - this.startedAt) },
      needPolicy: this.needPolicy,
      ...(this.actionSet !== undefined ? { actionSet: this.actionSet, wakeAtSimTime: this.wakeDeadlines() } : {}),
    } satisfies ReactiveRecord);
  }

  private firstRequestBody(): Record<string, unknown> | null {
    for (const actorId of this.actorIds) {
      for (const cycle of this.actorCycles(actorId)) {
        for (const turn of cycle.turns) {
          const body = turn.step?.transport?.requestBody;
          if (body !== undefined && body !== null) return body;
        }
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* G06 worker B: checkpoint material + restore path                  */
  /* ---------------------------------------------------------------- */

  /**
   * Raw checkpoint data. Export-layer checks (busy/SAVE_BUSY) live in
   * reactive/checkpoint.ts; this method only reads and deep-copies. The
   * in-flight flag is included so a caller can never mistake a busy game for
   * a saveable one.
   */
  checkpointData(): GameCheckpoint | G08GameCheckpoint {
    const g08 = this.actionSet !== undefined;
    const cycles: Record<string, GameCycleCheckpoint[]> = {};
    const cyclesG08: Record<string, G08GameCycleCheckpoint[]> = {};
    for (const actorId of this.actorIds) {
      cyclesG08[actorId] = this.actorCycles(actorId).map(cycle => {
        const exported = exportSessionCheckpoint(cycle.session, g08 ? 'g08' : 'g06');
        if (!exported.ok) {
          throw new CheckpointExportError(exported.code, exported.issues ?? []);
        }
        const entry = {
          cycle: cycle.cycle,
          reason: cycle.reason,
          startLogCursor: cycle.startLogCursor,
          endState: cycle.endState,
          turns: structuredClone(cycle.turns),
          session: exported.value,
        };
        cycles[actorId] = (cycles[actorId] ?? []).concat(entry as unknown as GameCycleCheckpoint);
        return entry as unknown as G08GameCycleCheckpoint;
      });
    }
    const base = {
      episodeId: this.episodeId,
      actorIds: [...this.actorIds],
      wakePolicy: this.wakePolicy,
      mode: this.mode,
      thinking: this.thinking,
      needPolicy: this.needPolicy,
      requestModel: this.options.requestModel ?? null,
      timeoutMs: this.timeoutMs,
      engine: this.world.save(),
      initialState: structuredClone(this.initialState),
      startedAt: this.startedAt,
      states: structuredClone(this.states),
      transitions: structuredClone(this.transitions),
      cursor: this.cursor,
      globalTurn: this.globalTurn,
      playerSeq: this.playerSeq,
      worldSeq: this.worldSeq,
      busy: this.busy,
      closed: this.closed,
      interrupted: this.interrupted,
      lastInterruptedActor: this.lastInterruptedActor,
      totalCalls: this.totalCalls,
      idlePumps: structuredClone(this.idlePumps),
      cycles,
    };
    if (g08) {
      // G08: every group (legacy included) saves the capability axis, the
      // timed_wait actor state and the per-actor deadlines.
      return {
        ...base,
        cycles: cyclesG08,
        schema: G08_GAME_SCHEMA,
        actionSet: this.actionSet,
        recordSchema: G08_GAME_SCHEMA,
        states: base.states as Record<string, ReactiveActorState | 'timed_wait'>,
        wakeAtSimTime: this.wakeDeadlines(),
      };
    }
    return {
      ...base,
      schema: G06_CHECKPOINT_SCHEMA,
      recordSchema: this.recordSchema as typeof G04_SCHEMA | typeof G05_SCHEMA,
    };
  }

  /**
   * Restore from validated checkpoint data. This is NOT the normal constructor
   * path: no openCycle, no provider call, no command submission. The Engine is
   * rebuilt from the saved ledger; every session is restored with that same
   * engine and the episode-cycle command-id formula. Options supply only
   * resources (providers, clock, timer, hooks); all causal state comes from
   * the data.
   */
  static restoreFromCheckpoint(data: GameCheckpoint | G08GameCheckpoint, options: ReactiveGameOptions): ReactiveGameImpl {
    const g08 = (data as G08GameCheckpoint).schema === G08_GAME_SCHEMA;
    const impl = Object.create(ReactiveGameImpl.prototype) as Record<string, unknown>;
    impl.options = options;
    impl.episodeId = data.episodeId;
    impl.actorIds = [...data.actorIds];
    impl.wakePolicy = data.wakePolicy;
    impl.mode = data.mode;
    impl.thinking = data.thinking;
    impl.needPolicy = data.needPolicy;
    impl.recordSchema = data.recordSchema;
    impl.actionSet = g08 ? (data as G08GameCheckpoint).actionSet : undefined;
    impl.nowFn = options.now ?? Date.now;
    impl.startedAt = data.startedAt;
    impl.initialState = structuredClone(data.initialState);
    impl.timeoutMs = data.timeoutMs;
    impl.world = Engine.restore(data.engine);
    impl.states = structuredClone(data.states);
    impl.transitions = structuredClone(data.transitions);
    impl.globalTurn = data.globalTurn;
    impl.cursor = data.cursor;
    impl.playerSeq = data.playerSeq;
    impl.worldSeq = data.worldSeq;
    impl.busy = false;
    impl.closed = data.closed;
    impl.interrupted = data.interrupted;
    impl.lastInterruptedActor = data.lastInterruptedActor;
    impl.totalCalls = data.totalCalls;
    impl.idlePumps = structuredClone(data.idlePumps);
    const cycles: Record<string, CycleState[]> = {};
    for (const actorId of data.actorIds) cycles[actorId] = [];
    for (const actorId of data.actorIds) {
      for (const saved of data.cycles[actorId] ?? []) {
        const restored = restoreAgentSession(saved.session, {
          world: impl.world as Engine,
          provider: options.providerFor(actorId),
          commandIdFor: round => `${data.episodeId}:npc:${actorId}:${saved.cycle}:${round}`,
          now: options.now,
          scheduleTimeout: options.scheduleTimeout,
        });
        if (!restored.ok) {
          throw new CheckpointExportError(restored.code, restored.issues ?? [`session ${saved.session.runId}`]);
        }
        const session = restored.value;
        if (options.onDeciding) {
          const hook = options.onDeciding;
          session.onDeciding = phase => hook({ actorId, cycle: saved.cycle, round: phase.round, observation: phase.observation });
        }
        cycles[actorId].push({
          cycle: saved.cycle,
          reason: saved.reason,
          session,
          turns: structuredClone(saved.turns),
          startLogCursor: saved.startLogCursor,
          endState: saved.endState,
        });
      }
    }
    impl.cycles = cycles;
    return impl as unknown as ReactiveGameImpl;
  }
}

/** Internal carrier so the export layer can surface Result codes. */
export class CheckpointExportError extends Error {
  constructor(readonly code: string, readonly issues: string[]) {
    super(`${code}: ${issues.join('; ')}`);
    this.name = 'CheckpointExportError';
  }
}

export function createReactiveGame(options: ReactiveGameOptions): ReactiveGame & {
  reconcile(): void;
  pumpCounterSnapshot(): { calls: number; cycles: number; states: Record<string, ReactiveActorState> };
  setPumpCounters(pumps: number, before: { calls: number; cycles: number; states: Record<string, ReactiveActorState> }): void;
} {
  return new ReactiveGameImpl(options);
}
