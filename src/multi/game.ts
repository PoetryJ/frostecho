/**
 * G03 workstream B — two autonomous NPCs (npc_a, npc_c) plus the player (npc_b)
 * in one authoritative Engine. Each NPC gets its own Provider instance and
 * AgentSession; all provider calls are serialized by the scheduler. The player
 * submits through the same Engine.submit, synchronously, so a player line can
 * land while an NPC is still waiting for its model text.
 */
import {
  createAgentSession, stepAgent,
} from '../agent/runner';
import type { AgentSession, Provider, SessionStatus, StepAgentResult, StepFeedback } from '../agent/contracts';
import { Engine, replay } from '../engine';
import type { LogEntry } from '../engine';
import type { WorldState } from '../types';
import { canonical } from '../util';
import {
  AdvanceOutcome, MultiActorSummary, MultiDecidingInfo, MultiGame, MultiGameOptions, MultiRecord,
  MultiStopReason, MultiTurnRecord, PLAYER_ACTOR_ID, RunOutcomeKind, G03_SCHEMA, isTerminalStatus, validateActorIds,
} from './contracts';
import { createScheduler } from './scheduler';

export interface ParsedG03PlayerLine {
  kind: 'move' | 'eat' | 'blank' | 'invalid';
  to?: 'dorm' | 'kitchen';
  error?: string;
}

/** Player grammar: 'player move dorm|kitchen' | 'player eat'. */
export function parseG03PlayerLine(line: string): ParsedG03PlayerLine {
  const text = line.trim();
  if (!text) return { kind: 'blank' };
  if (text === 'player eat') return { kind: 'eat' };
  if (text === 'player move dorm') return { kind: 'move', to: 'dorm' };
  if (text === 'player move kitchen') return { kind: 'move', to: 'kitchen' };
  return { kind: 'invalid', error: `unknown player command ${JSON.stringify(text)}` };
}

class MultiGameImpl implements MultiGame {
  readonly episodeId: string;
  readonly world: Engine;
  readonly actorIds: readonly string[];
  readonly mode: 'reference' | 'live' | 'fixture';
  readonly thinking: boolean | null;
  readonly sessions: Readonly<Record<string, AgentSession>>;

  private readonly scheduler: ReturnType<typeof createScheduler>;
  private readonly turns: MultiTurnRecord[] = [];
  private readonly providers: Record<string, Provider> = {};
  private readonly startedAt: number;
  private readonly nowFn: () => number;
  private readonly initialState: WorldState;
  private playerSeq = 1;
  private userClosed = false;
  private interrupted = false;

  constructor(private readonly options: MultiGameOptions) {
    this.episodeId = options.episodeId;
    const actorIds = [...options.actorIds];
    validateActorIds(actorIds);
    this.actorIds = actorIds;
    this.world = new Engine(options.initialState);
    this.mode = options.mode;
    this.thinking = options.thinking;
    this.nowFn = options.now ?? Date.now;
    this.startedAt = this.nowFn();
    this.initialState = structuredClone(options.initialState);

    const sessions: Record<string, AgentSession> = {};
    for (const actorId of actorIds) {
      const provider = options.providerFor(actorId);
      this.providers[actorId] = provider;
      const session = createAgentSession({
        world: this.world,
        provider,
        actorId,
        runId: `${options.episodeId}:${actorId}`,
        timeoutMs: options.timeoutMs,
        now: options.now,
        scheduleTimeout: options.scheduleTimeout,
        commandIdFor: round => `${options.episodeId}:npc:${actorId}:${round}`,
      });
      if (options.onDeciding) {
        const hook = options.onDeciding;
        session.onDeciding = phase => hook({ actorId, round: phase.round, observation: phase.observation });
      }
      sessions[actorId] = session;
    }
    this.sessions = sessions;

    this.scheduler = createScheduler({
      actorIds,
      getStatus: actorId => sessions[actorId].status,
      step: actorId => this.stepAndRecord(actorId),
    });
  }

  /** Wrap stepAgent so every autonomous turn lands in the global turn ledger. */
  private async stepAndRecord(actorId: string): Promise<StepAgentResult> {
    const session = this.sessions[actorId];
    const inputFeedback: StepFeedback | null = session.feedback ? { ...session.feedback } : null;
    const result = await stepAgent(session);
    if (result.status === 'timeout' || result.status === 'provider_error') this.interrupted = true;
    this.turns.push({
      globalTurn: this.turns.length + 1,
      actorId,
      actorRound: result.step?.round ?? session.round,
      inputFeedback,
      providerCalled: result.providerCalled,
      status: result.status,
      step: result.step,
    });
    return result;
  }

  advance(): Promise<AdvanceOutcome> {
    return this.scheduler.advance();
  }

  run(): Promise<RunOutcomeKind> {
    return this.scheduler.run();
  }

  async close(): Promise<void> {
    this.userClosed = true;
    await this.scheduler.close();
  }

  /** Synchronous: submits through the shared Engine even while an NPC decides. */
  playerLine(line: string): ReturnType<MultiGame['playerLine']> {
    const parsed = parseG03PlayerLine(line);
    if (parsed.kind === 'blank') return { ok: false, error: 'blank' };
    if (parsed.kind === 'invalid') return { ok: false, error: parsed.error ?? 'invalid' };
    const commandId = `${this.episodeId}:player:${PLAYER_ACTOR_ID}:${this.playerSeq}`;
    this.playerSeq += 1;
    const command = parsed.kind === 'move'
      ? { commandId, actorId: PLAYER_ACTOR_ID, type: 'move' as const, payload: { to: parsed.to } }
      : { commandId, actorId: PLAYER_ACTOR_ID, type: 'eat' as const, payload: {} };
    const exec = this.world.submit(structuredClone(command));
    if (exec.status === 'accepted') return { ok: true, command, exec };
    return { ok: false, error: exec.reason ?? exec.status, command, exec };
  }

  actorStatus(actorId: string): SessionStatus | 'unknown' {
    return this.sessions[actorId]?.status ?? 'unknown';
  }

  statusText(): string {
    const state = this.world.getState();
    const parts = this.actorIds.map(actorId => {
      const s = state.npcs[actorId];
      const session = this.sessions[actorId];
      const feedback = session?.feedback
        ? `${session.feedback.kind}${session.feedback.reason ? ':' + session.feedback.reason : ''}`
        : 'none';
      return `${actorId}=${s ? `${s.location}/${s.hunger}` : 'missing'}/status=${session?.status ?? 'unknown'}/fb=${feedback}/calls=${session?.providerCalls ?? 0}`;
    });
    const b = state.npcs[PLAYER_ACTOR_ID];
    parts.push(`player=${b ? `${b.location}/${b.hunger}` : 'missing'}`);
    parts.push(`food.kitchen=${state.food.kitchen}`, `food.dorm=${state.food.dorm}`);
    parts.push(`closed=${this.userClosed}`);
    return parts.join(' ');
  }

  snapshot(): MultiRecord {
    const finalState = this.world.getState();
    const commands: LogEntry[] = this.world.getLog();
    const events = this.world.getEvents();
    const actors: Record<string, MultiActorSummary> = {};
    let allTerminal = true;
    for (const actorId of this.actorIds) {
      const session = this.sessions[actorId];
      const terminal = isTerminalStatus(session.status);
      if (!terminal) allTerminal = false;
      const hunger = finalState.npcs[actorId]?.hunger;
      actors[actorId] = {
        status: session.status,
        providerCalls: session.providerCalls,
        goalReached: typeof hunger === 'number' && hunger >= 70,
      };
    }
    const stopReason: MultiStopReason = this.interrupted
      ? 'interrupted'
      : allTerminal ? 'completed' : 'user_closed';
    return structuredClone({
      schema: G03_SCHEMA,
      episodeId: this.episodeId,
      scenarioId: null,
      mode: this.mode,
      thinking: this.thinking,
      actorOrder: [...this.actorIds],
      initialState: this.initialState,
      finalState,
      commands,
      events,
      turns: this.turns,
      actors,
      stopReason,
      scenarioPass: null,
      replayMatches: canonical(replay(this.initialState, events)) === canonical(finalState),
      timing: { totalMs: Math.max(0, this.nowFn() - this.startedAt) },
    } satisfies MultiRecord);
  }
}

export function createMultiGame(options: MultiGameOptions): MultiGame {
  return new MultiGameImpl(options);
}
