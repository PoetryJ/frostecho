/**
 * THE four-day driver. One loop, one authority, one clock.
 *
 * Before R11 there were two drivers with two different worlds:
 *   - `scripts/r8/playthrough.ts` (the canonical runner) — 4/8 survivors on the
 *     frozen reference arm;
 *   - `scripts/r10/d-fourday.ts` (D's driver) — 8/8 on the same seed, because it
 *     contained three *undisclosed* behaviour changes: it walked home anybody
 *     standing in the open village at night, it never sent a resident outdoors
 *     on the lethal day, and it withdrew outdoor tasks when day 4 started.
 * The difference between 8/8 and 4/8 was therefore not a rule difference and
 * not "more food": it was a policy difference hidden inside a second driver.
 *
 * R11 fixes the diagnosis, not the scoreboard:
 *   - every behaviour that is a *policy* is a named, switchable strategy below,
 *     and the strategy ids travel in every artefact;
 *   - `scripts/r8/playthrough.ts` and `scripts/r10/d-fourday.ts` are now thin
 *     entries over THIS loop, so CLI, web, evaluation and the second driver
 *     cannot diverge again;
 *   - the world is always the same `R8Runtime`, and when `originalMap` is on it
 *     is the original 50x40 village plus the seven original interiors, walked
 *     through the original doors and grid cells via `R8Runtime.walkLegacy`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GameplayLoop } from '../../gameplay-v2/loop';
import type { Candidate, ChoiceRequest, ChoiceResult } from '../../decision/contracts';
import type { ScorePort } from '../contracts';
import { GOSPEL_PROFILE, REFERENCE_PROFILE, type TimeProfile } from '../contracts';
import { referenceAgencyScorer } from '../agency/reference';
import { applicableNotes, type ExperienceNote,
  type MemoryPolicyId } from '../agency/options';
import { planAssignments, councilShouldOpen, type AssignmentView } from '../domains/council/index';
import { TASK_CATALOG, type TaskTypeId } from '../domains/tasks/index';
import { heatingOf, OUTDOOR_LIMIT_MINUTES } from '../domains/survival/index';
import { MACHINES } from '../domains/production/index';
import { mapIdOfSite, placeSatisfied, positionSites, siteIdOf } from '../../spatial-v2/site';
import { createCommitmentBridge } from './commitment-bridge';
import { R8Runtime } from './runtime';
import { auditSettlement, loadFourDaySidecars, saveFourDaySidecars,
  type SettlementAudit } from './sidecar';
import { runStep } from './step';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export type FourDayMode = 'reference' | 'jev-experimental' | 'jev-admitted';
export type MemorySelection = 'raw-last12' | 'obligation-first';

/* ------------------------------------------------------------------ *
 * Strategies: every policy that is NOT an original rule lives here.
 * ------------------------------------------------------------------ */

/**
 * A strategy id is evidence. It is written into every summary and every
 * comparison row, so nobody can claim an arm is "the reference" while running
 * something else.
 */
export interface FourDayStrategies {
  /**
   * `walk-home/1` — at night every living resident whose home dorm differs from
   * its location really walks there (original route, real minutes, charged
   * cold). Off: the resident stays where it is, which is what killed the four
   * promisors at D2 01:00 in R10.
   */
  nightShelter: boolean;
  /**
   * `reference-survival/1` — never pick a choice that walks into a lethal
   * outdoor band (`outdoorTemperature(4) = -60 C`, ~3 health/minute). Off: the
   * reference scorer is free to choose `gather` / `move to village` on day 4.
   */
  weatherVeto: boolean;
  /**
   * `lethal-day-withdrawal/1` — when the lethal day starts, every accepted or
   * proposed outdoor task is cancelled with one recorded intent per task. Off:
   * a day-3 board still walks its assignee to the lumber camp at -60 C.
   */
  outdoorWithdrawal: boolean;
  /**
   * `walk-escort/1` — a hypothermic crisis is answered by walking to the same
   * room (`reach`) and then walking both bodies to `medical` (`escort`), on the
   * original map, instead of the legacy teleport rescue.
   */
  routedRescue: boolean;
  /**
   * `recorded/1` — a dangerously weak promisor explicitly withdraws its
   * promise and the withdrawal is recorded. Off: it dies holding the promise.
   */
  survivalExit: boolean;
  /**
   * `supply-then-restart/1` — a machine that stopped on an empty input tank is
   * restarted once the tank is refilled above the original `minRun`, and the
   * refill is assigned to the board. Off: the machine stays stopped.
   */
  machineRecovery: boolean;
  /**
   * `outdoor-limit/120min/1` — the original two-hour outdoor limit
   * (`weather-system.js:29-40`, enforced only inside the survival domain in
   * R10). Once a resident has spent the limit outside, it really walks to the
   * nearest indoor site and the board stops offering it outdoor work. Off: a
   * resident that went out at -30 C never comes back and freezes.
   */
  outdoorLimit: boolean;
}

export const STRATEGY_IDS = {
  nightShelter: 'npc-schedule/home-at-night/1',
  weatherVeto: 'reference-survival/1',
  outdoorWithdrawal: 'lethal-day-withdrawal/1',
  routedRescue: 'walk-escort/1',
  survivalExit: 'recorded-survival-exit/1',
  machineRecovery: 'supply-then-restart/1',
  outdoorLimit: 'outdoor-limit/120min/1',
} as const;

export type StrategyKey = keyof FourDayStrategies;

export const STRATEGY_KEYS: readonly StrategyKey[] = ['nightShelter', 'outdoorLimit',
  'weatherVeto', 'outdoorWithdrawal', 'routedRescue', 'survivalExit', 'machineRecovery'];

const ALL_OFF: FourDayStrategies = { nightShelter: false, weatherVeto: false,
  outdoorWithdrawal: false, routedRescue: false, survivalExit: false,
  machineRecovery: false, outdoorLimit: false };

/**
 * The presets this round reports. Each entry turns ON exactly what its name
 * claims, so a same-seed row can be attributed to the switch it adds.
 *
 *  - `reference-rule/1`     : no driver policy at all. This reproduces R10's
 *                             canonical runner, including its night defect; it
 *                             is NOT the original game.
 *  - `reference-schedule/1` : + the original NPC schedule, i.e. everybody whose
 *                             home dorm differs really walks there at night
 *                             (`data/npc-schedules.js`, `npc-movement.js`).
 *                             This is original behaviour, not a concession.
 *  - `reference-driver/1`   : + machine restart after a refill.
 *  - `reference-survival/1` : + weather veto, lethal-day task withdrawal,
 *                             routed rescue and the recorded survival exit —
 *                             the arm that produced 8/8 in R10.
 */
export const STRATEGY_PRESETS: Record<string, FourDayStrategies> = {
  'reference-rule/1': { ...ALL_OFF },
  'reference-schedule/1': { ...ALL_OFF, nightShelter: true, outdoorLimit: true },
  'reference-driver/1': { ...ALL_OFF, nightShelter: true, outdoorLimit: true,
    machineRecovery: true },
  'reference-survival/1': { ...ALL_OFF, nightShelter: true, outdoorLimit: true,
    machineRecovery: true, weatherVeto: true, outdoorWithdrawal: true,
    routedRescue: true, survivalExit: true },
};

export const DEFAULT_PRESET = 'reference-rule/1';

/**
 * How long before the original two-hour outdoor budget is spent the return walk
 * starts. At -30 C (chill -39) the outdoor band costs ~0.65 stamina/minute, so a
 * resident that waits for the exact limit can no longer walk back.
 */
export const OUTDOOR_RETURN_MARGIN = 30;

/** Names the ON strategies, in a stable order: this string is the arm's label. */
export function strategyLabel(strategies: FourDayStrategies): string {
  const on = STRATEGY_KEYS.filter(key => strategies[key]).map(key => STRATEGY_IDS[key]);
  return on.length === 0 ? 'reference-rule/1' : on.join('+');
}

export function presetOf(name: string): FourDayStrategies {
  const preset = STRATEGY_PRESETS[name];
  if (!preset) throw new Error(`unknown strategy preset ${name}; `
    + `known: ${Object.keys(STRATEGY_PRESETS).join(',')}`);
  return { ...preset };
}

/** Parses `--strategies weather-veto,night-shelter` into a full set. */
export function strategiesFromList(list: string): FourDayStrategies {
  const aliases: Record<string, StrategyKey> = {
    'night-shelter': 'nightShelter', 'walk-home': 'nightShelter',
    'weather-veto': 'weatherVeto', 'reference-survival': 'weatherVeto',
    'outdoor-withdrawal': 'outdoorWithdrawal', 'lethal-day-withdrawal': 'outdoorWithdrawal',
    'routed-rescue': 'routedRescue', 'walk-escort': 'routedRescue',
    'survival-exit': 'survivalExit',
    'machine-recovery': 'machineRecovery', 'supply-then-restart': 'machineRecovery',
    'outdoor-limit': 'outdoorLimit', 'outdoor-limit-120': 'outdoorLimit',
  };
  const next: FourDayStrategies = { ...ALL_OFF };
  if (list.trim() === '' || list.trim() === 'none') return next;
  for (const raw of list.split(',').map(part => part.trim()).filter(Boolean)) {
    if (raw === 'all') { for (const key of STRATEGY_KEYS) next[key] = true; continue; }
    const key = aliases[raw.replace(/_/g, '-')];
    if (!key) throw new Error(`unknown strategy ${raw}; known: ${Object.keys(aliases).join(',')}`);
    next[key] = true;
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Evidence shapes
 * ------------------------------------------------------------------ */

export interface DecisionRow {
  at: number; elapsed: number; day: number; minuteOfDay: number; actorId: string;
  requestId: string; candidateSetHash: string; inputSha256: string | null;
  rules: string[]; selectedId: string | null; selectedKind: string | null;
  selectedParameters: Record<string, unknown> | null; observations: number;
  executionStatus: string; reason: string; actorLocation: string;
  actorSites: string[]; worldVersion: number; lifeNumber: number;
  taskCompleted: string | null;
}

export interface ClockRow {
  at: number; day: number; minuteOfDay: number; firewood: number; power: number;
  food: number; medicine: number; furnaceFuel: number; furnaceLit: boolean;
  heatingStrength: number; heatingBand: string; alive: number; dead: string[];
  locations: Record<string, string>; machines: Record<string, string>;
  /** The original `_outdoorTimer`: accumulated outdoor minutes per actor. */
  outdoorMinutes: Record<string, number>;
}

export interface CouncilRow {
  at: number; day: number; meetingId: string; actorId: string; type: TaskTypeId;
  verdict: 'accept' | 'decline' | 'counter' | 'reassigned'; taskId: string | null;
  reassignedTo: string | null; reason: string;
}

export interface WalkRow {
  at: number; actorId: string; site: string; minutes: number; tiles: number;
  receipt: string | null; reason: string;
}

export interface Beat {
  kind: 'clock' | 'decision' | 'council' | 'rescue' | 'withdrawal' | 'machine' | 'ending';
  at: number; day: number; minuteOfDay: number; detail: Record<string, unknown>;
}

export interface FourDayOptions {
  seed: string;
  npcCount?: number;
  food?: number;
  /** >1 runs the original reincarnation cycle on the same seed. */
  lives?: number;
  profile?: TimeProfile;
  mode?: FourDayMode;
  memoryPolicy?: MemoryPolicyId;
  memorySelection?: MemorySelection;
  memoryTokenBudget?: number;
  /** Explicit. There is no implicit default arm. */
  strategies: FourDayStrategies;
  /** Original 50x40 village + seven interiors, walked on real cells/doors. */
  originalMap?: boolean;
  commitments?: boolean;
  /** The D2 private-cancel + change-proposal story. */
  interference?: boolean;
  scorer?: ScorePort | null;
  outDir?: string | null;
  statePath?: string | null;
  restoreFrom?: string | null;
  stopAfterDays?: number | null;
  pledgeAfterDay?: number | null;
  maxIterations?: number;
  /** E/H live hook: one call per beat, never a second world. */
  onBeat?: (beat: Beat) => void;
  now?: () => string;
  sourceHEAD?: string | null;
}

export interface FourDayEnding {
  lifeNumber: number; ending: string; survivors: number; elapsed: number; at: number;
}

export interface FourDaySummary {
  schema: 'frostecho.r11.fourday/1';
  seed: string; profile: string; mode: FourDayMode; lives: number;
  strategyLabel: string; strategies: FourDayStrategies;
  strategiesOn: string[];
  originalMap: boolean; mapProfile: string | null;
  mapIds: string[];
  memoryPolicy: MemoryPolicyId; memorySelection: MemorySelection;
  sourceHEAD: string | null; node: string; startedAt: string;
  endings: FourDayEnding[];
  survivors: number; dead: string[]; ending: FourDayEnding | null;
  endedAt: number; elapsed: number;
  resources: Record<string, number>;
  furnace: Record<string, unknown>;
  heating: Record<string, unknown>;
  decisions: number; decisionStates: Record<string, number>;
  council: CouncilRow[];
  intents: number;
  terminal: { applied: number; rejected: number; cancelled: number; unresolved: number };
  rejectedAtSettlement: { actorId: string; intentId: string; action: string;
    reason: string | null }[];
  rescues: { at: number; victimId: string; rescuerId: string; notes: string[] }[];
  nightWalks: WalkRow[];
  outdoorReturns: WalkRow[];
  strandedAtNight: { at: number; actorId: string; location: string }[];
  weatherVetoes: { at: number; actorId: string; candidate: string; reason: string }[];
  outdoorWithdrawals: { at: number; taskId: string; type: string; assigneeId: string }[];
  machineEvents: { at: number; machine: string; kind: string; detail: string }[];
  survivalExits: { commitmentId: string; actorId: string; at: number; status: string }[];
  clock: ClockRow[];
  clockSha256: string;
  trajectorySha256: string;
  settlement?: SettlementAudit;
  files: Record<string, string>;
}

export interface FourDayResult {
  runtime: R8Runtime;
  play: GameplayLoop;
  decisions: DecisionRow[];
  summary: FourDaySummary;
}

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

type ScorePortLike = ScorePort;

const OUT_OF_PLACE = new Set(['village', 'warehouse', 'kitchen', 'workshop', 'medical',
  'dorm-a', 'dorm-b', 'command']);

/** Notes this actor holds. Built from its own records, never from world truth. */
export function notesFor(runtime: R8Runtime, actorId: string, policy: MemoryPolicyId):
  ExperienceNote[] {
  const store = runtime.session.memories.get(actorId);
  if (!store) return [];
  const records = store.toJSON().records.filter(record => record.observerId === actorId);
  const notes: ExperienceNote[] = [];
  const shortage = [...records].reverse().find(record => record.kind === 'out_of_stock');
  if (shortage) {
    notes.push({ noteId: `note-shortage-${actorId}`, sourceEventIds: [...shortage.sourceEventIds],
      conditions: { place: 'warehouse' }, lesson: 'delay-should-be-reported', version: 1 });
  }
  const restock = [...records].reverse().find(record => record.kind === 'stock_restocked');
  if (restock && shortage && restock.observedAt > shortage.observedAt) {
    notes.push({ noteId: `note-restock-${actorId}`, sourceEventIds: [...restock.sourceEventIds],
      conditions: { place: 'warehouse', stock: 'restocked' },
      lesson: 'shortage-condition-lifted', version: 1 });
  }
  const refusal = [...records].reverse().find(record => record.kind === 'task_declined');
  if (refusal) {
    notes.push({ noteId: `note-refusal-${actorId}`, sourceEventIds: [...refusal.sourceEventIds],
      conditions: { taskState: 'declined' }, lesson: 'conflict', version: 1 });
  }
  return applicableNotes(notes, policy, { place: 'warehouse', taskState: 'declined' });
}

/** Runner bookkeeping that must survive a process exit; never a world fact. */
export interface FourDayRunnerState {
  schema: 'frostecho.r11.fourday-state/1';
  seed: string; mode: FourDayMode; lives: number; profile: string;
  strategies: FourDayStrategies; originalMap: boolean;
  interfered: boolean; pledged: boolean; pledgeAfterDay: number | null;
  requestedCommitmentIds: string[];
  stopAfterDays: number | null;
  savedAt: string | null; restoredFrom: string | null;
}

function runnerStatePath(base: string): string { return `${base}.runner.json`; }

export function readFourDayRunnerState(base: string): FourDayRunnerState {
  const path = runnerStatePath(base);
  if (!existsSync(path)) throw new Error(`missing_four_day_runner_state:${path}`);
  const document = JSON.parse(readFileSync(path, 'utf8')) as FourDayRunnerState;
  if (document.schema !== 'frostecho.r11.fourday-state/1'
    && document.schema !== 'frostecho.r10.playthrough-state/1') {
    throw new Error(`unsupported runner state ${document.schema}`);
  }
  return document as FourDayRunnerState;
}

export function writeFourDayRunnerState(base: string, document: FourDayRunnerState): string {
  const path = runnerStatePath(base);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

/** Where a board decision is written down. Optional so a CLI may call it bare. */
export interface CouncilSink {
  council?: CouncilRow[];
  emit?: (kind: Beat['kind'], detail: Record<string, unknown>) => void;
}

/**
 * The morning meeting + the original assignment policy (`task-generator.js`).
 * Module level: the shared runner, `play-sprint` and any other entry reach the
 * SAME board instead of each re-implementing a proposal list.
 */
export function holdCouncil(runtime: R8Runtime, sink: CouncilSink = {}): void {
  const snapshot = runtime.snapshot();
  const seenMorning = runtime.states.council.meetings.some(meeting =>
    meeting.reason === 'morning'
    && Math.floor((meeting.openedAtMinute + runtime.profile.startMinuteOfDay)
      / runtime.profile.minutesPerDay) + runtime.profile.startDay === snapshot.day);
  const isMorning = snapshot.minuteOfDay >= 8 * 60 && snapshot.minuteOfDay < 10 * 60
    && !seenMorning;
  const reason = isMorning ? 'morning'
    : councilShouldOpen(snapshot.resources, Number(snapshot.facts.tension ?? 0),
      snapshot.elapsed, (runtime.states.council as { cooldownUntil: number }).cooldownUntil);
  if (!reason) return;
  const opened = runtime.dispatch('council', 'open', 'old_qian',
    { tension: 0, force: isMorning });
  const meetingId = (runtime.states.council as { meetings: { meetingId: string }[] })
    .meetings.at(-1)?.meetingId;
  if (!meetingId || opened.rejected.length > 0) return;
  const view: AssignmentView = {
    day: snapshot.day, resources: snapshot.resources, furnace: snapshot.furnace,
    machines: snapshot.machines as Record<string, string>,
    npcs: Object.fromEntries(Object.entries(snapshot.npcs).map(([id, npc]) => [id, {
      id, alive: npc.alive, stamina: npc.stamina, health: npc.health,
      hunger: npc.hunger, san: npc.san, location: npc.location }])) };
  const plan = planAssignments(view, 4);
  if (plan.length === 0) return;
  runtime.dispatch('council', 'propose', 'old_qian', { meetingId,
    assignments: plan.map(entry => ({ actorId: entry.actorId, type: entry.type })),
    rationale: plan.map(entry => `${entry.actorId}:${entry.type} (${entry.reason})`).join('; ') });
  const proposalId = (runtime.states.council as
    { meetings: { proposals: { proposalId: string }[] }[] })
    .meetings.at(-1)!.proposals[0].proposalId;
  for (const actorId of runtime.context().actorIds) {
    runtime.dispatch('council', 'vote', actorId, { meetingId, proposalId });
  }
  runtime.dispatch('council', 'resolve', 'old_qian', { meetingId });
  for (const assignment of plan) {
    assignOnBoard(runtime, assignment.actorId, assignment.type, meetingId, sink);
  }
  sink.emit?.('council', { meetingId, count: plan.length, reason });
}

/**
 * One assignment: propose -> respond (accept / decline / counter) -> reassign.
 * Every branch is recorded, so "accept 5 / decline 1 / reassigned 1" in the
 * evidence is the real ledger and not a claim.
 */
export function assignOnBoard(runtime: R8Runtime, actorId: string, type: TaskTypeId,
  meetingId: string, sink: CouncilSink = {}): void {
  const proposed = runtime.dispatch('tasks', 'propose', 'old_qian',
    { type, assigneeId: actorId });
  const taskId = (runtime.states.tasks as { tasks: { taskId: string }[] })
    .tasks.at(-1)?.taskId ?? null;
  if (!taskId || proposed.rejected.length > 0) return;
  const npc = runtime.snapshot().npcs[actorId];
  const verdict: 'accept' | 'decline' | 'counter' = !npc?.alive ? 'decline'
    : npc.stamina < 20 && type !== 'REST_RECOVER' ? 'counter'
      : npc.health < 40 && type !== 'PREPARE_MEDICAL' ? 'decline' : 'accept';
  const reason = verdict === 'accept' ? '可以接下' : `自身状态不适合 ${type}`;
  runtime.dispatch('tasks', 'respond', actorId, { taskId, verdict, reason,
    counterType: 'REST_RECOVER' });
  let reassignedTo: string | null = null;
  if (verdict !== 'accept') {
    const spare = runtime.context().actorIds.find(id => id !== actorId
      && runtime.snapshot().npcs[id]?.alive
      && runtime.snapshot().npcs[id].stamina >= 30);
    if (spare) {
      runtime.dispatch('tasks', 'reassign', 'old_qian', { taskId, assigneeId: spare });
      reassignedTo = spare;
    }
  }
  const snapshot = runtime.snapshot();
  sink.council?.push({ at: runtime.world.simTime, day: snapshot.day, meetingId,
    actorId, type, verdict: reassignedTo ? 'reassigned' : verdict, taskId,
    reassignedTo, reason });
  sink.emit?.('council', { actorId, type, verdict, taskId, reassignedTo });
}

export class FourDayRunner {
  readonly strategies: FourDayStrategies;
  readonly strategyLabel: string;
  runtime: R8Runtime;
  play: GameplayLoop;
  decisions: DecisionRow[] = [];
  clock: ClockRow[] = [];
  council: CouncilRow[] = [];
  rescues: FourDaySummary['rescues'] = [];
  nightWalks: WalkRow[] = [];
  outdoorReturns: WalkRow[] = [];
  stranded: FourDaySummary['strandedAtNight'] = [];
  vetoes: FourDaySummary['weatherVetoes'] = [];
  withdrawals: FourDaySummary['outdoorWithdrawals'] = [];
  machineEvents: FourDaySummary['machineEvents'] = [];
  survivalExits: FourDaySummary['survivalExits'] = [];
  endings: FourDayEnding[] = [];
  readonly runner: FourDayRunnerState;
  private readonly options: FourDayOptions;
  private readonly scorer: ScorePortLike;
  private bridge: ReturnType<typeof createCommitmentBridge>;
  private interfered: boolean;

  constructor(options: FourDayOptions) {
    this.options = options;
    this.strategies = { ...options.strategies };
    this.strategyLabel = strategyLabel(this.strategies);
    const restored = options.restoreFrom ? loadFourDaySidecars(options.restoreFrom) : null;
    if (restored && options.restoreFrom) {
      const saved = readFourDayRunnerState(options.restoreFrom);
      if (saved.seed !== options.seed) throw new Error(`restore seed ${saved.seed} != ${options.seed}`);
      if (saved.mode !== (options.mode ?? 'reference')) {
        throw new Error(`restore mode ${saved.mode} != ${options.mode}`);
      }
      if (saved.lives !== (options.lives ?? 1)) {
        throw new Error(`restore lives ${saved.lives} != ${options.lives}`);
      }
      if (JSON.stringify(saved.strategies) !== JSON.stringify(this.strategies)) {
        throw new Error('restore strategies do not match the save');
      }
      if (saved.originalMap !== (options.originalMap ?? false)) {
        throw new Error('restore original-map flag does not match the save');
      }
      this.runtime = restored.runtime;
      this.play = restored.play;
      this.runner = { ...saved, restoredFrom: options.restoreFrom,
        stopAfterDays: options.stopAfterDays ?? null };
    } else {
      this.runtime = R8Runtime.create({ seed: options.seed,
        npcCount: options.npcCount ?? 8, resources: { food: options.food ?? 130 },
        profile: options.profile });
      if (options.originalMap ?? false) this.runtime.enableLegacySpatial();
      this.play = new GameplayLoop(this.runtime.session);
      this.runner = {
        schema: 'frostecho.r11.fourday-state/1', seed: options.seed,
        mode: options.mode ?? 'reference', lives: options.lives ?? 1,
        profile: (options.profile ?? GOSPEL_PROFILE).id, strategies: { ...this.strategies },
        originalMap: options.originalMap ?? false,
        interfered: false, pledged: false,
        pledgeAfterDay: options.pledgeAfterDay ?? null,
        requestedCommitmentIds: [],
        stopAfterDays: options.stopAfterDays ?? null,
        savedAt: null, restoredFrom: null,
      };
    }
    this.interfered = this.runner.interfered;
    this.bridge = createCommitmentBridge(this.runtime, this.play);
    this.scorer = this.withStrategies((options.scorer ?? referenceAgencyScorer()) as ScorePortLike);
  }

  /* ---------------- world views ---------------- */

  private emit(kind: Beat['kind'], detail: Record<string, unknown>): void {
    const snapshot = this.runtime.snapshot();
    this.options.onBeat?.({ kind, at: this.runtime.world.simTime, day: snapshot.day,
      minuteOfDay: snapshot.minuteOfDay, detail });
  }

  /** Sites this actor stands at, including the room a village door belongs to. */
  sitesOf(actorId: string): string[] {
    const position = this.runtime.legacyPosition(actorId);
    if (position) return positionSites(position);
    return [this.runtime.world.npcs[actorId]?.location ?? 'village'];
  }

  atSite(actorId: string, site: string): boolean {
    const npc = this.runtime.world.npcs[actorId];
    if (!npc) return false;
    return placeSatisfied(site, npc.location, this.sitesOf(actorId));
  }

  /**
   * Walk an actor to a site on the original map. Never teleports: the returned
   * minutes are the minutes the authority really charged.
   */
  walkTo(actorId: string, site: string, tag: string): WalkRow {
    const at = this.runtime.world.simTime;
    const npc = this.runtime.world.npcs[actorId];
    if (!npc?.alive) return { at, actorId, site, minutes: 0, tiles: 0,
      receipt: null, reason: 'not_alive' };
    if (this.atSite(actorId, site)) return { at, actorId, site, minutes: 0, tiles: 0,
      receipt: null, reason: 'already_at_site' };
    const commandId = `r11-walk-${tag}-${actorId}-${at}`;
    if (!this.runtime.legacyPosition(actorId)) {
      // No original map on this arm: the frozen 3-map `move` primitive, queued.
      const candidate: Candidate = { id: `r11-move-${sha256(commandId).slice(0, 8)}`,
        kind: 'move', description: `前往${site}`,
        parameters: { action: 'move', to: site, purpose: tag },
        preconditions: ['alive'], expectedEffects: { travelMinutes: 15 }, utilityComponents: {} };
      const begun = this.runtime.beginIntent({ intentId: commandId, commandId, actorId,
        candidate, minutes: 15 });
      if ('rejected' in begun) {
        return { at, actorId, site, minutes: 0, tiles: 0, receipt: null,
          reason: begun.rejected };
      }
      this.runtime.advanceWorld(begun.intent.dueAt);
      return { at, actorId, site, minutes: this.runtime.world.simTime - at, tiles: 0,
        receipt: null, reason: 'queued_move' };
    }
    const result = this.runtime.travelLegacyTo(actorId, site, commandId);
    const minutes = this.runtime.world.simTime - at;
    if (result.status === 'rejected') {
      return { at, actorId, site, minutes, tiles: 0, receipt: null, reason: result.reason };
    }
    const moved = this.runtime.journal.filter(event => event.at >= at
      && (event.type === 'legacy_cell_moved' || event.type === 'legacy_door_crossed')
      && event.actorId === actorId);
    return { at, actorId, site, minutes, tiles: moved.length,
      receipt: result.eventIds.at(-1) ?? null, reason: result.reason };
  }

  /* ---------------- scorer wrapper: the named veto ---------------- */

  private withStrategies(base: ScorePortLike): ScorePortLike {
    if (!this.strategies.weatherVeto) return base;
    const runner = this;
    return {
      identity: { ...base.identity,
        scorerId: `${base.identity.scorerId}+${STRATEGY_IDS.weatherVeto}` },
      score(request: ChoiceRequest): Promise<ChoiceResult> | ChoiceResult {
        const result = base.score(request);
        if (result && typeof (result as Promise<ChoiceResult>).then === 'function') {
          return (result as unknown as Promise<ChoiceResult>)
            .then(value => runner.veto(request, value));
        }
        return runner.veto(request, result as ChoiceResult);
      },
    };
  }

  private veto(request: ChoiceRequest, result: ChoiceResult): ChoiceResult {
    const day = Number((request.observation as { day?: number })?.day ?? 1);
    if (day < 4) return result;
    const chosen = request.candidates.find(entry => entry.id === result.selectedId);
    const action = String(chosen?.parameters.action ?? '');
    const to = String(chosen?.parameters.to ?? '');
    const outdoor = action === 'gather' || (action === 'move' && to === 'village');
    if (!outdoor) return result;
    const dayMinute = Number((request.observation as { minuteOfDay?: number })?.minuteOfDay ?? 0);
    this.vetoes.push({ at: dayMinute, actorId: request.actorId,
      candidate: String(result.selectedId),
      reason: `day-${day} outdoor is lethal (-60 C); choice refused` });
    const safe = request.candidates.filter(entry => {
      const act = String(entry.parameters.action ?? '');
      const dest = String(entry.parameters.to ?? '');
      return act !== 'gather' && !(act === 'move' && dest === 'village');
    });
    const fallback = safe.find(entry => entry.parameters.action !== 'wait') ?? safe[0];
    this.emit('decision', { veto: String(result.selectedId), fallback: fallback?.id ?? null });
    if (!fallback) return result;
    return { ...result, selectedId: fallback.id,
      reason: `${result.reason}; ${STRATEGY_IDS.weatherVeto} -> ${String(fallback.parameters.action)}` };
  }

  /* ---------------- board: council + assignment ---------------- */

  private councilIfDue(): void {
    holdCouncil(this.runtime, { council: this.council,
      emit: (kind, detail) => this.emit(kind, detail) });
  }

  private assign(actorId: string, type: TaskTypeId, meetingId: string): void {
    assignOnBoard(this.runtime, actorId, type, meetingId,
      { council: this.council, emit: (kind, detail) => this.emit(kind, detail) });
  }

  /* ---------------- the two named outdoor strategies ---------------- */

  private withdrawOutdoorTasks(): void {
    if (!this.strategies.outdoorWithdrawal) return;
    if (this.runtime.snapshot().day < 4) return;
    const outdoor = new Set(['COLLECT_WOOD', 'COLLECT_FOOD', 'COLLECT_MATERIAL', 'SCOUT_RUINS']);
    for (const task of (this.runtime.states.tasks as
      { tasks: { taskId: string; type: string; status: string; assigneeId: string }[] }).tasks) {
      if (!outdoor.has(task.type)) continue;
      if (task.status !== 'accepted' && task.status !== 'proposed') continue;
      const result = this.runtime.dispatch('tasks', 'cancel', 'old_qian', { taskId: task.taskId });
      if (result.rejected.length > 0) continue;
      this.withdrawals.push({ at: this.runtime.world.simTime, taskId: task.taskId,
        type: task.type, assigneeId: task.assigneeId });
      this.emit('withdrawal', { taskId: task.taskId, type: task.type });
    }
  }

  private machineRecovery(): void {
    if (!this.strategies.machineRecovery) return;
    const snapshot = this.runtime.snapshot();
    for (const [id, state] of Object.entries(snapshot.machines)) {
      if (state !== 'stopped') continue;
      const spec = MACHINES[id as keyof typeof MACHINES];
      if (!spec) continue;
      const held = snapshot.resources[spec.consumes.resource];
      if (held < spec.consumes.minRun) continue;
      const started = this.runtime.dispatch('production', 'start-machine', 'old_qian',
        { machine: id });
      this.machineEvents.push({ at: this.runtime.world.simTime, machine: id,
        kind: started.rejected.length > 0 ? 'restart_rejected' : 'restarted',
        detail: started.rejected.length > 0
          ? `${started.rejected[0].code}:${started.rejected[0].reason}`
          : `${spec.consumes.resource} ${held} >= minRun ${spec.consumes.minRun}` });
      if (started.rejected.length === 0) this.emit('machine', { machine: id, kind: 'restarted' });
    }
    for (const event of this.runtime.journal.slice(-80)) {
      if (event.type !== 'machine_stopped') continue;
      const machine = String(event.payload.machine ?? '');
      if (this.machineEvents.some(row => row.kind === 'stopped' && row.machine === machine
        && row.at === event.at)) continue;
      this.machineEvents.push({ at: event.at, machine, kind: 'stopped',
        detail: String(event.payload.reason ?? '') });
      this.emit('machine', { machine, kind: 'stopped' });
    }
  }

  /* ---------------- rescue ---------------- */

  private routedRescue(): void {
    if (!this.strategies.routedRescue) return;
    for (const event of this.runtime.journal.slice(-60)) {
      if (event.type !== 'rescue_needed') continue;
      const victimId = String(event.payload.actorId ?? '');
      const open = (this.runtime.states.crises as { active: { kind: string; subjectIds: string[] }[] })
        .active.some(entry => entry.kind === 'rescue' && entry.subjectIds.includes(victimId));
      if (!open) continue;
      const victim = this.runtime.world.npcs[victimId];
      if (!victim?.alive) continue;
      const notes: string[] = [];
      const sameRoom = this.runtime.context().actorIds.filter(id => id !== victimId
        && this.runtime.world.npcs[id]?.alive
        && this.runtime.world.npcs[id].stamina > 30
        && this.atSite(id, victim.location));
      let rescuerId = sameRoom[0] ?? null;
      if (!rescuerId) {
        const walker = this.runtime.context().actorIds.filter(id => id !== victimId
          && this.runtime.world.npcs[id]?.alive)
          .sort((left, right) => this.runtime.world.npcs[right].health
            - this.runtime.world.npcs[left].health)[0];
        if (!walker) continue;
        const walk = this.walkTo(walker, victim.location, 'rescue-reach');
        notes.push(`rescuer walk: ${walk.reason} (${walk.minutes} min, ${walk.tiles} tiles)`);
        if (!this.atSite(walker, victim.location)) {
          this.rescues.push({ at: this.runtime.world.simTime, victimId, rescuerId: walker,
            notes: [...notes, 'still not in the room'] });
          continue;
        }
        rescuerId = walker;
      }
      const reach = this.runtime.dispatch('crises', 'rescue', rescuerId,
        { victimId, stage: 'reach' });
      if (reach.rejected.length > 0) {
        notes.push(`reach refused: ${reach.rejected[0].code} ${reach.rejected[0].reason}`);
        this.rescues.push({ at: this.runtime.world.simTime, victimId, rescuerId, notes });
        continue;
      }
      notes.push('reach applied');
      const victimWalk = this.walkTo(victimId, 'medical', 'escort-victim');
      notes.push(`victim walk: ${victimWalk.reason} (${victimWalk.minutes} min)`);
      const rescuerWalk = this.walkTo(rescuerId, 'medical', 'escort-rescuer');
      notes.push(`rescuer walk: ${rescuerWalk.reason} (${rescuerWalk.minutes} min)`);
      const escort = this.runtime.dispatch('crises', 'rescue', rescuerId,
        { victimId, stage: 'escort' });
      notes.push(escort.rejected.length > 0
        ? `escort refused: ${escort.rejected[0].code} ${escort.rejected[0].reason}`
        : 'escort applied');
      this.rescues.push({ at: this.runtime.world.simTime, victimId, rescuerId, notes });
      this.emit('rescue', { victimId, rescuerId, notes });
    }
  }

  /* ---------------- the original outdoor limit ---------------- */

  /**
   * `weather-system.js:29-40`, and the D-R10 known gap: the two-hour outdoor
   * limit was enforced only inside the survival domain, so the board kept
   * handing out outdoor work and the resident never came back. Once the budget
   * is spent the runner walks the resident to a real indoor site and records the
   * receipt — the same walk interface, no teleport.
   */
  private enforceOutdoorLimit(): void {
    if (!this.strategies.outdoorLimit) return;
    const spent = (this.runtime.states.survival as
      { outdoorMinutes: Record<string, number> }).outdoorMinutes;
    for (const actorId of this.runtime.context().actorIds) {
      const npc = this.runtime.world.npcs[actorId];
      if (!npc?.alive || npc.location !== 'village') continue;
      if ((spent[actorId] ?? 0) < OUTDOOR_LIMIT_MINUTES) continue;
      if (this.runtime.busyUntil(actorId) !== null) continue;
      const site = this.homeOf(actorId);
      const walked = this.walkTo(actorId, site, 'outdoor-limit');
      if (walked.minutes > 0) {
        this.outdoorReturns.push({ ...walked, site });
        this.emit('clock', { outdoorReturn: actorId, site, minutes: walked.minutes });
      }
      if (this.runtime.ended) return;
    }
  }

  /* ---------------- night ---------------- */

  /**
   * The original schedule home: npc_02/npc_04 sleep in dorm-b, everybody else
   * in dorm-a (`data/npc-schedules.js`). Returns a world site id; the original
   * map maps `dorm-a` back to the `dorm_a` map itself.
   */
  private homeOf(actorId: string): string {
    return actorId.endsWith('2') || actorId.endsWith('4') ? 'dorm-b' : 'dorm-a';
  }

  /**
   * `npc-schedule/home-at-night/1`. Every living resident whose location is not
   * its home dorm walks there on the original map — including a resident
   * standing in the open village, which the frozen runner silently skipped
   * (those are the four promisors who froze at D2 01:00 in R10).
   *
   * If the home dorm is not reachable (the route is closed, the actor has no
   * stamina left, or it is mid-work), the resident still does not sleep in the
   * open: it walks to the nearest reachable indoor site, in a fixed order, and
   * the substitution is recorded. Only a resident with no reachable indoor site
   * at all is left outside — and that is written down as `strandedAtNight`, not
   * silently swallowed.
   */
  private nightWalk(): void {
    if (!this.strategies.nightShelter) return;
    const shelterOrder = ['dorm-a', 'dorm-b', 'warehouse', 'workshop', 'medical', 'command'];
    for (const actorId of this.runtime.context().actorIds) {
      const npc = this.runtime.world.npcs[actorId];
      if (!npc?.alive) continue;
      const home = this.homeOf(actorId);
      if (this.atSite(actorId, home)) continue;
      if (this.runtime.busyUntil(actorId) !== null) {
        // Mid-work: the body is occupied until the queued action settles, and a
        // walk now would move it out from under its own receipt.
        this.stranded.push({ at: this.runtime.world.simTime, actorId,
          location: this.runtime.world.npcs[actorId]?.location ?? 'unknown' });
        continue;
      }
      const walked = this.walkTo(actorId, home, 'night');
      if (walked.minutes > 0) this.nightWalks.push(walked);
      if (this.atSite(actorId, home)) continue;
      let sheltered = false;
      for (const site of shelterOrder) {
        if (site === home || this.atSite(actorId, site)) { sheltered = true; break; }
        const tried = this.walkTo(actorId, site, 'night-shelter');
        if (tried.minutes > 0) this.nightWalks.push({ ...tried, site });
        if (this.atSite(actorId, site)) { sheltered = true; break; }
        if (this.runtime.ended) return;
      }
      if (!sheltered) {
        this.stranded.push({ at: this.runtime.world.simTime, actorId,
          location: this.runtime.world.npcs[actorId]?.location ?? 'unknown' });
      }
      if (this.runtime.ended) return;
    }
  }

  /* ---------------- clock ---------------- */

  private recordClock(): void {
    const snapshot = this.runtime.snapshot();
    const heating = heatingOf(snapshot);
    this.clock.push({ at: this.runtime.world.simTime, day: snapshot.day,
      minuteOfDay: snapshot.minuteOfDay, firewood: snapshot.resources.firewood,
      power: snapshot.resources.power, food: snapshot.resources.food,
      medicine: snapshot.resources.medicine, furnaceFuel: snapshot.furnace.fuel,
      furnaceLit: snapshot.furnace.lit, heatingStrength: heating.strength,
      heatingBand: heating.strength >= 0.75 ? 'hot' : heating.strength >= 0.45 ? 'warm'
        : heating.strength >= 0.12 ? 'cold' : 'none',
      alive: Object.values(snapshot.npcs).filter(npc => npc.alive).length,
      dead: [...this.runtime.world.dead].sort(),
      locations: Object.fromEntries(Object.entries(snapshot.npcs)
        .map(([id, npc]) => [id, npc.location])),
      machines: { ...snapshot.machines } as Record<string, string>,
      outdoorMinutes: { ...(this.runtime.states.survival as
        { outdoorMinutes: Record<string, number> }).outdoorMinutes } });
  }

  private step(): void {
    const profile = this.runtime.profile;
    const snapshot = this.runtime.snapshot();
    const night = snapshot.minuteOfDay >= profile.nightSkipFromMinute
      || snapshot.minuteOfDay < profile.nightSkipToMinute;
    if (night) {
      // The walk home is a real route, and a resident that was still working
      // when the night opened gets another chance every hour. The skip is
      // therefore taken one hour at a time, never in one jump that would leave
      // a late body outside for eight hours.
      for (let hour = 0; hour < 8; hour += 1) {
        this.nightWalk();
        if (this.runtime.ended) return;
        const before = this.runtime.world.simTime;
        const dayStart = Math.floor(before / profile.minutesPerDay) * profile.minutesPerDay;
        const wake = dayStart + profile.minutesPerDay + profile.nightSkipToMinute;
        if (before >= wake) break;
        this.runtime.advanceWorld(Math.min(wake, before + 60));
        if (this.runtime.ended) return;
      }
    } else {
      const before = this.runtime.world.simTime;
      this.runtime.advanceWorld(Math.floor(before / 60) * 60 + 60);
    }
    this.recordClock();
    this.emit('clock', { at: this.runtime.world.simTime });
  }

  /* ---------------- pledges, interference, survival exit ---------------- */

  private pledge(): void {
    if (this.runner.pledged || (this.options.commitments ?? true) === false) return;
    const promises = ['npc_01', 'npc_02', 'npc_03', 'npc_04'].map((actorId, index) =>
      this.play.requestCommitment(actorId, index < 2 ? 'deliver-meal' : 'supply-warehouse',
        { verdict: 'accept' }));
    this.runner.pledged = true;
    this.runner.requestedCommitmentIds = promises.map(entry => entry.commitment.commitmentId);
  }

  private applyInterference(): void {
    if (this.interfered || !(this.options.interference ?? true)) return;
    if (!this.runner.pledged || this.runtime.snapshot().day < 2) return;
    this.interfered = true;
    this.runner.interfered = true;
    const rows = this.play.commitments.all().filter(row => row.status === 'active');
    if (rows[0]) {
      this.play.cancelCommitment(rows[0].commitmentId,
        { heardBy: ['npc_02'], reason: '玩家改主意' });
    }
    if (rows[1]) {
      const proposed = this.play.commitments.proposeChange(rows[1].commitmentId, {
        kind: 'alt-source', reason: 'warehouse-empty',
        terms: { source: 'gather', reason: '先采集再交付' },
        at: this.runtime.world.simTime, evidenceEventIds: [] });
      this.runtime.session.ingestCommitmentEvent(proposed.event);
    }
  }

  private applySurvivalExit(): void {
    if (!this.strategies.survivalExit) return;
    for (const actorId of this.runtime.context().actorIds) {
      const npc = this.runtime.world.npcs[actorId];
      if (!npc?.alive) continue;
      const danger = npc.hunger < 45 || npc.stamina < 35 || (npc.bodyTemp ?? 36.5) < 35.9;
      if (!danger) continue;
      for (const row of this.play.commitments.all()) {
        if (row.promisorId !== actorId || row.status !== 'active') continue;
        const exited = this.play.withdrawCommitment(row.commitmentId,
          { reason: 'survival-exit',
            inputId: `exit-${row.commitmentId}-${this.runtime.world.simTime}` });
        this.survivalExits.push({ commitmentId: row.commitmentId, actorId,
          at: this.runtime.world.simTime, status: exited.commitment.status });
      }
    }
  }

  /* ---------------- decisions ---------------- */

  private async decide(actorId: string): Promise<void> {
    const result = await runStep(this.runtime, this.scorer, {
      actorIds: [actorId], mode: this.options.mode ?? 'reference',
      memorySelection: this.options.memorySelection ?? 'obligation-first',
      memoryPolicy: this.options.memoryPolicy ?? 'conditional-experience',
      memoryTokenBudget: this.options.memoryTokenBudget, goalBridge: this.bridge,
      notes: id => notesFor(this.runtime, id,
        this.options.memoryPolicy ?? 'conditional-experience') });
    for (const row of result.records) {
      const selected = row.candidates.find(entry => entry.id === row.selectedId);
      const snapshot = this.runtime.snapshot();
      this.decisions.push({ at: this.runtime.world.simTime, elapsed: this.runtime.elapsed(),
        day: snapshot.day, minuteOfDay: snapshot.minuteOfDay, actorId: row.actorId,
        requestId: row.requestId, candidateSetHash: row.candidateSetHash,
        inputSha256: row.inputSha256 ?? null, rules: row.rules,
        selectedId: row.selectedId, selectedKind: selected?.kind ?? null,
        selectedParameters: selected?.parameters ?? null,
        observations: row.candidates.length, executionStatus: row.executionStatus,
        reason: row.reason, actorLocation: this.runtime.world.npcs[actorId]?.location ?? 'unknown',
        actorSites: this.sitesOf(actorId), worldVersion: row.worldVersion,
        lifeNumber: (this.runtime.states.life as { lifeNumber: number }).lifeNumber,
        taskCompleted: row.taskCompleted ?? null });
      this.emit('decision', { actorId, selectedId: row.selectedId,
        status: row.executionStatus });
    }
  }

  /* ---------------- main loop ---------------- */

  async run(): Promise<FourDayResult> {
    const lives = this.options.lives ?? 1;
    if (!existsSync(this.options.outDir ?? '') && this.options.outDir) {
      mkdirSync(this.options.outDir, { recursive: true });
    }
    this.recordClock();
    for (let life = 1; life <= lives; life += 1) {
      this.bridge = createCommitmentBridge(this.runtime, this.play);
      const reached = (day: number): boolean => {
        const snapshot = this.runtime.snapshot();
        return snapshot.day > day
          || (snapshot.day === day && snapshot.minuteOfDay >= this.runtime.profile.startMinuteOfDay);
      };
      if (this.runner.pledgeAfterDay === null) this.pledge();
      let guard = 0;
      const limit = this.options.maxIterations ?? 1600;
      while (!this.runtime.ended && guard < limit) {
        guard += 1;
        this.withdrawOutdoorTasks();
        this.councilIfDue();
        this.machineRecovery();
        this.enforceOutdoorLimit();
        if (this.runner.pledgeAfterDay !== null && !this.runner.pledged
          && reached(this.runner.pledgeAfterDay)) this.pledge();
        const willStop = this.runner.stopAfterDays !== null
          && reached(this.runner.stopAfterDays);
        if (!willStop) this.applyInterference();
        this.applySurvivalExit();
        for (const actorId of this.runtime.context().actorIds) {
          await this.decide(actorId);
          if (this.runtime.ended) break;
        }
        if (willStop) {
          const pending = [...this.runtime.intents.values()]
            .filter(intent => intent.status === 'working');
          if (pending.length > 0) break;
        }
        this.routedRescue();
        this.rescueByDispatch();
        const before = this.runtime.world.simTime;
        this.step();
        if (this.runtime.ended) break;
        if (this.runtime.world.simTime === before) break;
      }
      const lifeState = this.runtime.states.life as { ending: { kind: string;
        survivors: number; settledAtElapsed: number } | null };
      if (lifeState.ending) {
        this.endings.push({ lifeNumber: life, ending: lifeState.ending.kind,
          survivors: lifeState.ending.survivors,
          elapsed: lifeState.ending.settledAtElapsed, at: this.runtime.world.simTime });
        this.emit('ending', { ...lifeState.ending });
      }
      if (life < lives) {
        this.runtime = this.runtime.reincarnate({ seed: this.options.seed,
          npcCount: this.options.npcCount ?? 8,
          resources: { food: this.options.food ?? 130 }, profile: this.options.profile });
        this.play = new GameplayLoop(this.runtime.session);
        this.runtime.journal.push({ at: this.runtime.world.simTime, type: 'reincarnated',
          actorId: 'system', payload: { lifeNumber: life + 1 } });
      }
    }
    const summary = this.summarise();
    if (this.options.outDir) this.writeEvidence(this.options.outDir, summary);
    if (this.options.statePath) {
      saveFourDaySidecars(this.runtime, this.play, this.options.statePath);
      this.runner.savedAt = (this.options.now ?? (() => new Date().toISOString()))();
      summary.files.runnerState = writeFourDayRunnerState(this.options.statePath, this.runner);
    }
    return { runtime: this.runtime, play: this.play, decisions: this.decisions,
      summary };
  }

  /**
   * The legacy teleport rescue is refused while original coordinates are on
   * (`runtime.dispatch` rejects it by design). On a non-original arm the frozen
   * `crises rescue` command is still the only rescue there is, so it stays.
   */
  private rescueByDispatch(): void {
    if (this.strategies.routedRescue && this.runtime.legacyPosition(
      this.runtime.context().actorIds[0])) return;
    const open = (this.runtime.states.crises as { active: { kind: string; subjectIds: string[] }[] })
      .active.filter(entry => entry.kind === 'rescue');
    if (open.length === 0) return;
    for (const crisis of open) {
      const victimId = crisis.subjectIds[0];
      const rescuer = this.runtime.context().actorIds
        .filter(id => id !== victimId && this.runtime.world.npcs[id]?.alive)
        .sort((left, right) => this.runtime.world.npcs[right].health
          - this.runtime.world.npcs[left].health)[0];
      if (!rescuer) continue;
      const result = this.runtime.dispatch('crises', 'rescue', rescuer, { victimId });
      if (result.rejected.length > 0) continue;
      this.rescues.push({ at: this.runtime.world.simTime, victimId, rescuerId: rescuer,
        notes: ['legacy dispatch rescue'] });
    }
  }

  /* ---------------- summary ---------------- */

  summarise(): FourDaySummary {
    const snapshot = this.runtime.snapshot();
    const lifeState = this.runtime.states.life as { ending: FourDayEnding | null };
    const intents = [...this.runtime.intents.values()];
    const terminal = { applied: 0, rejected: 0, cancelled: 0, unresolved: 0 };
    for (const intent of intents) {
      if (intent.status === 'working') continue;
      terminal[intent.status as keyof typeof terminal] += 1;
    }
    const decisionStates: Record<string, number> = {};
    for (const row of this.decisions) {
      decisionStates[row.executionStatus] = (decisionStates[row.executionStatus] ?? 0) + 1;
    }
    const position = this.runtime.legacyPosition(this.runtime.context().actorIds[0]);
    return {
      schema: 'frostecho.r11.fourday/1', seed: this.options.seed,
      profile: this.runtime.profile.id, mode: this.options.mode ?? 'reference',
      lives: this.options.lives ?? 1,
      strategyLabel: this.strategyLabel, strategies: { ...this.strategies },
      strategiesOn: STRATEGY_KEYS.filter(key => this.strategies[key])
        .map(key => STRATEGY_IDS[key]),
      originalMap: this.runner.originalMap,
      mapProfile: position ? 'gospel-5.8.19-maps/1' : 'engine-3-map/1',
      mapIds: position ? ['village', 'warehouse', 'kitchen', 'medical', 'workshop',
        'dorm-a', 'dorm-b', 'command'] : ['village', 'warehouse', 'kitchen'],
      memoryPolicy: this.options.memoryPolicy ?? 'conditional-experience',
      memorySelection: this.options.memorySelection ?? 'obligation-first',
      sourceHEAD: this.options.sourceHEAD ?? process.env.FROSTECHO_SOURCE_HEAD ?? null,
      node: process.version,
      startedAt: (this.options.now ?? (() => new Date().toISOString()))(),
      endings: this.endings,
      survivors: Object.values(this.runtime.world.npcs).filter(npc => npc.alive).length,
      dead: [...this.runtime.world.dead].sort(),
      ending: this.endings.at(-1) ?? null,
      endedAt: this.runtime.world.simTime, elapsed: this.runtime.elapsed(),
      resources: { ...this.runtime.world.resources },
      furnace: { ...this.runtime.world.furnace } as unknown as Record<string, unknown>,
      heating: heatingOf(snapshot) as unknown as Record<string, unknown>,
      decisions: this.decisions.length, decisionStates,
      council: this.council,
      intents: intents.length, terminal,
      rejectedAtSettlement: intents.filter(intent => intent.status === 'rejected')
        .map(intent => ({ actorId: intent.actorId, intentId: intent.intentId,
          action: String(intent.candidate.parameters.action),
          reason: intent.failureReason })),
      rescues: this.rescues, nightWalks: this.nightWalks,
      outdoorReturns: this.outdoorReturns,
      strandedAtNight: this.stranded, weatherVetoes: this.vetoes,
      outdoorWithdrawals: this.withdrawals, machineEvents: this.machineEvents,
      survivalExits: this.survivalExits,
      clock: this.clock, clockSha256: sha256(JSON.stringify(this.clock)),
      trajectorySha256: sha256(this.decisions.map(row => JSON.stringify(row)).join('\n')),
      settlement: auditSettlement(this.runtime, this.play),
      files: {},
    };
  }

  writeEvidence(dir: string, summary: FourDaySummary): Record<string, string> {
    mkdirSync(dir, { recursive: true });
    const trajectory = join(dir, 'trajectory.jsonl');
    writeFileSync(trajectory,
      `${this.decisions.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    const clockPath = join(dir, 'clock.json');
    writeFileSync(clockPath, `${JSON.stringify(this.clock, null, 2)}\n`, 'utf8');
    const summaryPath = join(dir, 'summary.json');
    summary.files = { trajectory, clock: clockPath, summary: summaryPath,
      runnerState: this.options.statePath ? runnerStatePath(this.options.statePath) : '' };
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    writeFileSync(join(dir, 'intents.json'),
      `${JSON.stringify([...this.runtime.intents.values()], null, 2)}\n`, 'utf8');
    writeFileSync(join(dir, 'journal.jsonl'),
      `${this.runtime.journal.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    return summary.files;
  }
}

/** One call: the same loop the CLI, the web entry and the evaluation use. */
export async function runFourDay(options: FourDayOptions): Promise<FourDayResult> {
  return new FourDayRunner(options).run();
}

export const FOURDAY_PROFILES: Record<string, TimeProfile> = {
  [GOSPEL_PROFILE.id]: GOSPEL_PROFILE, [REFERENCE_PROFILE.id]: REFERENCE_PROFILE,
};
