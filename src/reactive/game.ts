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
  EPISODE_CALL_LIMIT, G04_SCHEMA, PLAYER_ACTOR_ID, WORLD_ACTOR_ID,
  type ReactiveActorState, type ReactiveActorSummary, type ReactiveAdvanceOutcome, type ReactiveCycleRecord,
  type ReactiveGame, type ReactiveGameOptions, type ReactiveRecord, type ReactiveStopReason, type ReactiveTransition,
  type ReactiveTurnRecord, type RestockResult,
} from './contracts';
import { canWake, describeObservation, isTerminalStatus, isWaitingObservation } from './lifecycle';

interface CycleState {
  cycle: number;
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

class ReactiveGameImpl implements ReactiveGame {
  readonly episodeId: string;
  readonly world: Engine;
  readonly actorIds: readonly string[];
  readonly wakePolicy: ReactiveGameOptions['wakePolicy'];
  readonly mode: ReactiveGameOptions['mode'];
  readonly thinking: boolean;

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
    });
    if (this.options.onDeciding) {
      const hook = this.options.onDeciding;
      session.onDeciding = phase => hook({ actorId, cycle, round: phase.round, observation: phase.observation });
    }
    const state: CycleState = {
      cycle,
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
    if (result.status === 'timeout' || result.status === 'provider_error') {
      this.interrupted = true;
      this.lastInterruptedActor = actorId;
      cycle.endState = 'failed';
      this.transition(actorId, 'failed', `transport ${result.status}`);
      return;
    }
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

  /** Re-read every waiting actor's own observation; wake only on real food. No provider call here. */
  reconcile(): void {
    for (const actorId of this.actorIds) {
      if (this.states[actorId] !== 'waiting') continue;
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
    // Bounded wait for an in-flight step: the runner's own timeout bounds it.
    while (this.busy) await new Promise<void>(resolve => setTimeout(resolve, 5));
    this.closed = true;
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
      commands: this.world.getLog().length,
      events: this.world.getEvents().length,
    };
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
      schema: G04_SCHEMA,
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
        model: typeof firstBody?.model === 'string' ? firstBody.model : null,
        temperature: HTTP_SAMPLING.temperature,
        max_tokens: HTTP_SAMPLING.max_tokens,
        stream: HTTP_SAMPLING.stream,
        enableThinking: [this.thinking],
        timeoutMs: this.timeoutMs,
      },
      timing: { totalMs: Math.max(0, this.nowFn() - this.startedAt) },
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
}

export function createReactiveGame(options: ReactiveGameOptions): ReactiveGame & {
  reconcile(): void;
  pumpCounterSnapshot(): { calls: number; cycles: number; states: Record<string, ReactiveActorState> };
  setPumpCounters(pumps: number, before: { calls: number; cycles: number; states: Record<string, ReactiveActorState> }): void;
} {
  return new ReactiveGameImpl(options);
}
