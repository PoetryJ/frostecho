/**
 * G10 application contracts — frozen by the main agent before A/B/C/D start.
 *
 * The application core (parser + controller) never imports readline, fs or
 * fetch: the terminal (B) and the adapters (C) connect through these ports.
 * Every world change still goes through the existing game entrypoints; the
 * controller keeps no second copy of hunger, food or request truth.
 */
import type { RunOutcome, SessionStatus } from '../agent/contracts';
import type { GoalChoiceId, GoalArm, SatietyLevel } from '../negotiation/contracts';
import type { GoalBinding } from '../negotiation/contracts';
import type { GoalRequestStore } from '../negotiation/requests';
import type { G08EffectiveConfig } from '../temporal/contracts';
import type { Location } from '../types';
import type { NeedsGame } from '../needs/game';

export const G10_APP_SCHEMA = 'frostecho.g10.app/1' as const;
export const G10_RUN_SCHEMA = 'frostecho.g10.run/1' as const;
export const G10_FAILURE_SCHEMA = 'frostecho.g10.failure/1' as const;

export const RUN_MIN = 1;
export const RUN_MAX = 20;
export const TIME_MIN = 1;
export const TIME_MAX = 10;
export const RESTOCK_MIN = 1;
export const RESTOCK_MAX = 10;

export type FixtureId = 'cooperate' | 'decline' | 'violate';
export type ProviderKind = 'reference' | 'fixture' | 'live';
export type GoalMode = 'legacy' | 'negotiated';

/**
 * Application metadata saved WITH the authoritative game/request envelope.
 * It never replaces the domain state; `scripted` says whether the provider was
 * a deterministic demo script or the real model path.
 */
export interface AppMeta {
  schema: typeof G10_APP_SCHEMA;
  episodeId: string;
  providerKind: ProviderKind;
  fixtureId: FixtureId | null;
  goalMode: GoalMode;
  candidateSet: GoalArm;
  satiety: SatietyLevel;
  scripted: boolean;
}

export type AppCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'request'; actorId: string; goal: GoalChoiceId }
  | { kind: 'step' }
  | { kind: 'run'; steps: number }
  | { kind: 'player_move'; to: Location }
  | { kind: 'player_eat' }
  | { kind: 'world_time'; steps: number }
  | { kind: 'world_restock'; location: Location; amount: number }
  | { kind: 'save'; slot: string }
  | { kind: 'quit' };

export type ParseIssue = 'EMPTY' | 'UNKNOWN' | 'ARITY' | 'VALUE' | 'LIMIT';

export type ParseResult =
  | { ok: true; command: AppCommand }
  | { ok: false; issue: ParseIssue; message: string };

export type AppCode =
  | 'OK'
  | 'BAD_INPUT'
  | 'BUSY'
  | 'CLOSED'
  | 'LIMIT'
  | 'IDLE'
  | 'NO_REQUEST'
  | 'REQUEST_REJECTED'
  | 'WORLD_REJECTED'
  | 'SAVE_BUSY'
  | 'SAVE_FAILED'
  | 'PROVIDER_ERROR'
  | 'PERSISTENCE_FAILED';

export interface ExecuteResult {
  ok: boolean;
  code: AppCode;
  detail?: string;
  /** For run/step/world commands: how many advances actually happened. */
  advanced?: number;
}

export interface AppRequestView {
  requestId: string;
  text: string;
  status: string;
  outcome: string;
  outcomeReason: string | null;
  expiresAtSimTime: number;
  acceptedAfterSeq: number | null;
  lastProcessedSeq: number | null;
  decidedGoal: GoalChoiceId | null;
}

export interface AppNpcView {
  actorId: string;
  cycle: number;
  phase: 'goal_choice' | 'action';
  status: SessionStatus | 'none';
  providerCalls: number;
  selectedGoal: GoalChoiceId | null;
  /** The selected goal's own result: yield by the request, feed_self by hunger. */
  selectedGoalAchieved: boolean;
  selectedGoalReached: boolean;
  hungerNeedSatisfied: boolean;
  sessionOutcome: RunOutcome | null;
  wakeAtSimTime: number | null;
  request: AppRequestView | null;
}

/** The display projection: read-only, all values come from the game. */
export interface AppView {
  episodeId: string;
  mode: 'fixture' | 'live' | 'reference';
  providerKind: ProviderKind;
  fixtureId: FixtureId | null;
  goalMode: GoalMode;
  candidateSet: GoalArm;
  scripted: boolean;
  simTime: number;
  tick: number;
  player: { actorId: string; location: string; hunger: number };
  food: { kitchen: number; dorm: number };
  npcs: AppNpcView[];
  budget: { sessionCalls: number; sessionLimit: number; episodeCalls: number; episodeLimit: number };
  campaign: { limit: number; spent: number } | null;
  savedPath: string | null;
  closed: boolean;
  busy: boolean;
}

export interface SaveOutcome {
  ok: boolean;
  path: string | null;
  code: 'OK' | 'SAVE_BUSY' | 'SAVE_FAILED';
  issues: string[];
}

/**
 * Injected adapters (C). The core never touches fs/network directly.
 * `save`/`failure`/`budget` are bound to the live game by the runtime.
 */
export interface ApplicationPorts {
  /** Exclusive new slot holding the complete authoritative state. */
  save(slot: string): SaveOutcome;
  /** Persist a provider/persistence failure with its real evidence. */
  failure(error: unknown): string | null;
  /** The authorized campaign budget, or null when the run is offline. */
  budget(): { limit: number; spent: number } | null;
  now(): number;
}

export interface ControllerDeps {
  game: NeedsGame;
  config: G08EffectiveConfig;
  root: string;
  slot: string;
  meta: AppMeta;
  ports: ApplicationPorts;
}

export interface ControllerCloseResult {
  ok: boolean;
  /** True when a provider/persistence failure was recorded during the run. */
  failed: boolean;
}

export interface ApplicationController {
  execute(command: AppCommand): Promise<ExecuteResult>;
  view(): AppView;
  close(): Promise<ControllerCloseResult>;
  isClosed(): boolean;
  isBusy(): boolean;
  hasFailed(): boolean;
  /** The absolute path of the last exclusive save, if any. */
  lastSavedPath(): string | null;
}

/** The one place the help text lives (B renders it, tests assert it). */
export const G10_HELP: readonly { usage: string; meaning: string }[] = [
  { usage: 'help', meaning: '显示这份操作说明' },
  { usage: 'status', meaning: '显示权威状态；0 次模型调用' },
  { usage: 'request npc_a yield_once', meaning: '以玩家身份提出 S1 让食请求；只入箱，不调用模型，不改世界' },
  { usage: 'step', meaning: '推进一次决策（最多 1 次模型调用）；两阶段需要两次 step' },
  { usage: `run N`, meaning: `最多推进 N 次（${RUN_MIN}..${RUN_MAX}）；遇 idle/关闭/失败/预算停止，不自动推进时间` },
  { usage: 'player move dorm|kitchen', meaning: '移动玩家（npc_b）' },
  { usage: 'player eat', meaning: '玩家进食；由世界规则判定的拒绝是正常结果' },
  { usage: 'world time N', meaning: `世界调试输入：推进逻辑时间 ${TIME_MIN}..${TIME_MAX} 步；0 次模型调用` },
  { usage: 'world restock kitchen N', meaning: `世界调试输入：补货 ${RESTOCK_MIN}..${RESTOCK_MAX}；0 次模型调用` },
  { usage: 'save SLOT', meaning: '独占写入新存档槽；决策在途时返回 SAVE_BUSY' },
  { usage: 'quit', meaning: '关闭本次运行（存档请先 save）；EOF/SIGINT 同样收束一次' },
];

/** Re-exported for workers; keeps the shared type surface in one file. */
export type { GoalBinding, GoalRequestStore, NeedsGame, GoalArm, SatietyLevel, GoalChoiceId };
