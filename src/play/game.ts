import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentSession, GOAL_HUNGER_AT_LEAST, Provider, RunOptions, RunOutcome, StepAgentResult,
  StepFeedback, StepRecord, SubmittedCommand, createAgentSession, stepAgent,
} from '../agent';
import { Engine, initialWorld, replay } from '../engine';
import { CommandResult, WorldEvent, WorldState } from '../types';
import { canonical } from '../util';

export const NPC_ACTOR_ID = 'npc_a';
export const PLAYER_ACTOR_ID = 'npc_b';

export interface GameCommandRecord {
  role: 'player' | 'npc';
  command: SubmittedCommand;
  exec: CommandResult;
}

export interface DecisionTrace {
  round: number;
  /** Feedback that was handed to this step. Null on the first provider call. */
  inputFeedback: StepFeedback | null;
  step?: StepRecord;
  terminalStatus: StepAgentResult['status'];
  providerCalled: boolean;
}

export interface GameRecord {
  batchId: string;
  scenarioId: string | null;
  mode: 'reference' | 'live' | 'fixture';
  /** Null when no model request is sent. Live runs record the actual enable_thinking value. */
  thinking: boolean | null;
  /** Scenario predicate. Independent of goalReached. Null for a free-play session. */
  scenarioPass: boolean | null;
  /** Authoritative npc_a hunger >= 70. A stop is never enough. */
  goalReached: boolean;
  outcome: RunOutcome | 'incomplete';
  providerCalls: number;
  commands: GameCommandRecord[];
  events: WorldEvent[];
  steps: StepRecord[];
  decisions: DecisionTrace[];
  initialState: WorldState;
  finalState: WorldState;
  replayMatches: boolean;
  reasons: string[];
  error?: string;
  timing: { totalMs: number; calls: { round: number; ms: number }[] };
}

export type PlayerApplyResult =
  | { ok: true; command: SubmittedCommand; exec: CommandResult }
  | { ok: false; error: string; command?: SubmittedCommand; exec?: CommandResult };

export type ParsedPlayLine =
  | { kind: 'blank' }
  | { kind: 'move'; to: 'dorm' | 'kitchen' }
  | { kind: 'eat' }
  | { kind: 'npc-step' }
  | { kind: 'status' }
  | { kind: 'quit' }
  | { kind: 'invalid'; error: string };

export function parsePlayCommand(line: string): ParsedPlayLine {
  const text = line.trim();
  if (!text) return { kind: 'blank' };
  if (text === 'status') return { kind: 'status' };
  if (text === 'quit') return { kind: 'quit' };
  if (text === 'npc step') return { kind: 'npc-step' };
  if (text === 'player eat') return { kind: 'eat' };
  if (text === 'player move dorm') return { kind: 'move', to: 'dorm' };
  if (text === 'player move kitchen') return { kind: 'move', to: 'kitchen' };
  return { kind: 'invalid', error: `unknown command ${JSON.stringify(text)}` };
}

export function safeBatchId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('invalid batch id');
  return cleaned;
}

export interface PlayOptions {
  batchId: string;
  provider: Provider;
  mode?: 'reference' | 'live' | 'fixture';
  thinking?: boolean | null;
  world?: Engine;
  timeoutMs?: number;
  now?: () => number;
  scheduleTimeout?: RunOptions['scheduleTimeout'];
  scenarioId?: string | null;
}

export interface PlayGame {
  readonly batchId: string;
  readonly world: Engine;
  readonly session: AgentSession;
  readonly mode: 'reference' | 'live' | 'fixture';
  thinking: boolean | null;
  scenarioId: string | null;
  scenarioPass: boolean | null;
  reasons: string[];
  closed: boolean;
  readonly commands: GameCommandRecord[];
  readonly decisions: DecisionTrace[];
  playerLine(line: string): PlayerApplyResult;
  npcStep(): Promise<StepAgentResult>;
  statusText(): string;
  quit(): Promise<GameRecord>;
  snapshot(): GameRecord;
}

class PlayGameImpl implements PlayGame {
  readonly batchId: string;
  readonly world: Engine;
  readonly session: AgentSession;
  readonly mode: 'reference' | 'live' | 'fixture';
  thinking: boolean | null;
  scenarioId: string | null;
  scenarioPass: boolean | null = null;
  reasons: string[] = [];
  closed = false;
  readonly commands: GameCommandRecord[] = [];
  readonly decisions: DecisionTrace[] = [];
  private playerSeq = 1;
  private inflight: Promise<StepAgentResult> | null = null;
  private saved: GameRecord | null = null;

  constructor(options: PlayOptions) {
    this.batchId = options.batchId;
    this.world = options.world ?? new Engine(initialWorld());
    this.mode = options.mode ?? 'reference';
    this.thinking = options.thinking ?? null;
    this.scenarioId = options.scenarioId ?? null;
    this.session = createAgentSession({
      world: this.world,
      provider: options.provider,
      actorId: NPC_ACTOR_ID,
      runId: options.batchId,
      timeoutMs: options.timeoutMs,
      now: options.now,
      scheduleTimeout: options.scheduleTimeout,
      commandIdFor: round => `${options.batchId}:npc:${round}`,
    });
  }

  playerLine(line: string): PlayerApplyResult {
    if (this.closed) return { ok: false, error: 'closed' };
    const parsed = parsePlayCommand(line);
    if (parsed.kind === 'move') return this.apply({ type: 'move', to: parsed.to });
    if (parsed.kind === 'eat') return this.apply({ type: 'eat' });
    return { ok: false, error: parsed.kind === 'invalid' ? parsed.error : 'not a player command' };
  }

  private apply(action: { type: 'move'; to: 'dorm' | 'kitchen' } | { type: 'eat' }): PlayerApplyResult {
    const commandId = `${this.batchId}:player:${this.playerSeq}`;
    this.playerSeq += 1;
    const command: SubmittedCommand = action.type === 'move'
      ? { commandId, actorId: PLAYER_ACTOR_ID, type: 'move', payload: { to: action.to } }
      : { commandId, actorId: PLAYER_ACTOR_ID, type: 'eat', payload: {} };
    const exec = this.world.submit(structuredClone(command));
    this.commands.push({ role: 'player', command, exec });
    if (exec.status === 'accepted') return { ok: true, command, exec };
    return { ok: false, error: exec.reason ?? exec.status, command, exec };
  }

  async npcStep(): Promise<StepAgentResult> {
    if (this.closed) return { status: 'invalid_run', terminal: true, providerCalled: false };
    if (this.session.status === 'deciding') return stepAgent(this.session);
    const inputFeedback = this.session.feedback ? { ...this.session.feedback } : null;
    const pending = stepAgent(this.session);
    this.inflight = pending;
    try {
      const result = await pending;
      if (result.step?.command && result.step.exec) {
        this.commands.push({ role: 'npc', command: result.step.command, exec: result.step.exec });
      }
      this.decisions.push({
        round: result.step?.round ?? this.session.round,
        inputFeedback,
        step: result.step,
        terminalStatus: result.status,
        providerCalled: result.providerCalled,
      });
      return result;
    } finally {
      if (this.inflight === pending) this.inflight = null;
    }
  }

  statusText(): string {
    const state = this.world.getState();
    const a = state.npcs[NPC_ACTOR_ID];
    const b = state.npcs[PLAYER_ACTOR_ID];
    const feedback = this.session.feedback
      ? `${this.session.feedback.kind}${this.session.feedback.reason ? ':' + this.session.feedback.reason : ''}`
      : 'none';
    const goal = !!a && a.hunger >= GOAL_HUNGER_AT_LEAST;
    return [
      `status round=${this.session.round}`,
      `feedback=${feedback}`,
      `session=${this.session.status}`,
      `npc_a=${a ? `${a.location}/${a.hunger}` : 'missing'}`,
      `npc_b=${b ? `${b.location}/${b.hunger}` : 'missing'}`,
      `food.kitchen=${state.food.kitchen}`,
      `food.dorm=${state.food.dorm}`,
      `calls=${this.session.providerCalls}`,
      `goalReached=${goal}`,
      `closed=${this.closed}`,
    ].join(' ');
  }

  async quit(): Promise<GameRecord> {
    this.closed = true;
    if (this.inflight) await this.inflight;
    if (!this.saved) this.saved = this.snapshot();
    return this.saved;
  }

  snapshot(): GameRecord {
    const run = this.session.result();
    const terminal = this.session.status !== 'ready' && this.session.status !== 'deciding';
    const hunger = run.finalState.npcs[NPC_ACTOR_ID]?.hunger;
    const goalReached = terminal ? run.goalReached : typeof hunger === 'number' && hunger >= GOAL_HUNGER_AT_LEAST;
    const record: GameRecord = {
      batchId: this.batchId,
      scenarioId: this.scenarioId,
      mode: this.mode,
      thinking: this.thinking,
      scenarioPass: this.scenarioPass,
      goalReached,
      outcome: terminal ? run.outcome : 'incomplete',
      providerCalls: run.providerCalls,
      commands: this.commands.map(entry => ({ role: entry.role, command: entry.command, exec: entry.exec })),
      events: run.events,
      steps: run.steps.slice(),
      decisions: this.decisions.slice(),
      initialState: run.initialState,
      finalState: run.finalState,
      replayMatches: canonical(replay(run.initialState, run.events)) === canonical(run.finalState),
      reasons: this.reasons.slice(),
      timing: run.timing,
    };
    if (run.error !== undefined && terminal) record.error = run.error;
    return record;
  }
}

export function createPlayGame(options: PlayOptions): PlayGame {
  return new PlayGameImpl(options);
}

/** Writes one game directory. Does not delete siblings or unrelated files. */
export function saveGameRecord(root: string, record: GameRecord): string {
  const dir = join(root, safeBatchId(record.batchId));
  mkdirSync(dir, { recursive: true });
  const dump = (name: string, value: unknown) => {
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n');
  };
  dump('game.json', record);
  dump('commands.json', record.commands);
  dump('events.json', record.events);
  dump('steps.json', record.steps);
  dump('initial-state.json', record.initialState);
  dump('final-state.json', record.finalState);
  dump('replay.json', { matches: record.replayMatches });
  dump('meta.json', {
    batchId: record.batchId,
    scenarioId: record.scenarioId,
    mode: record.mode,
    thinking: record.thinking,
    scenarioPass: record.scenarioPass,
    goalReached: record.goalReached,
    outcome: record.outcome,
    providerCalls: record.providerCalls,
    replayMatches: record.replayMatches,
    reasons: record.reasons,
    error: record.error ?? null,
    timing: record.timing,
  });
  return dir;
}
