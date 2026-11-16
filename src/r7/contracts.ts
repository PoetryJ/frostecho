/**
 * R8 frozen domain contracts (owner: integrator, "O").
 *
 * This file is the single place where the eight R8 workstreams meet:
 *   P1 survival/production, P2 space/UI, P3 tasks/council/crises, P4 endings,
 *   A agency/memory, D data, M JEV scorer, H acceptance.
 *
 * Rules encoded here (see handoff/20261116-r8-vibe/CONTRACT.txt):
 *  - a domain owns only its own state; every change to a shared resource, a
 *    body or a position is a typed intent with preconditions;
 *  - events are proposals until the integrator commits them atomically;
 *  - domains never call each other and never advance the clock;
 *  - one clock, one world version, one commit point. No second world, no second
 *    task queue, no second commit clock.
 */
import type { Candidate, ChoiceRequest, ChoiceResult } from '../decision/contracts';

export const R7_CONTRACTS_VERSION = 'r7-contracts/1';

/**
 * Shared, authoritative resource ids. The original has exactly these four and
 * charges `buildMaterialCost` from `power` (`machine-system.js:304-314`), so a
 * fifth "material" resource would be an invention.
 */
export type ResourceId = 'food' | 'firewood' | 'power' | 'medicine';

export const RESOURCE_IDS: readonly ResourceId[] = ['food', 'firewood', 'power', 'medicine'];

/** The three original machines. No second furnace. */
export type MachineId = 'generator' | 'lumberMill' | 'foodCollector';

export type MachineState = 'absent' | 'building' | 'running' | 'stopped' | 'broken';

export type LocationId =
  | 'village' | 'command' | 'dorm-a' | 'dorm-b'
  | 'kitchen' | 'warehouse' | 'workshop' | 'medical';

/** Place ids of the original seven interiors plus the outdoor village. */
export const LOCATION_IDS: readonly LocationId[] = [
  'village', 'command', 'dorm-a', 'dorm-b', 'kitchen', 'warehouse', 'workshop', 'medical',
];

/**
 * Original calendar (`src/core/game.js:40-41,428-435`,
 * `src/systems/death-ending.js:35-47`): D1 08:00 -> D4 18:00, 1440-minute day.
 * elapsed = 3*1440 + (18-8)*60 = 4920 minutes.
 */
export interface TimeProfile {
  id: string;
  startDay: number;
  startMinuteOfDay: number;
  endDay: number;
  endMinuteOfDay: number;
  minutesPerDay: number;
  /** Original night-skip window (inclusive start, exclusive end) in minutes. */
  nightSkipFromMinute: number;
  nightSkipToMinute: number;
  /** Original daily settlement hour (`core/game-time.js:21-23`). */
  settlementHour: number;
}

export const GOSPEL_PROFILE_ID = 'gospel-5.8.19';

export const GOSPEL_PROFILE: TimeProfile = {
  id: GOSPEL_PROFILE_ID,
  startDay: 1,
  startMinuteOfDay: 8 * 60,
  endDay: 4,
  endMinuteOfDay: 18 * 60,
  minutesPerDay: 24 * 60,
  nightSkipFromMinute: 20 * 60,
  nightSkipToMinute: 6 * 60,
  settlementHour: 21,
};

/** Legacy reference profile used by older sprints; kept separate on purpose. */
export const REFERENCE_PROFILE: TimeProfile = {
  ...GOSPEL_PROFILE,
  id: 'reference-4x24h',
  startMinuteOfDay: 8 * 60,
  endMinuteOfDay: 8 * 60,
};

export const TIME_PROFILES: readonly TimeProfile[] = [GOSPEL_PROFILE, REFERENCE_PROFILE];

export function profileById(id: string): TimeProfile {
  const found = TIME_PROFILES.find(profile => profile.id === id);
  if (!found) throw new ContractViolation('unknown_profile', `unknown time profile ${id}`);
  return found;
}

/** Absolute minute since day 1 00:00. Profile-independent arithmetic. */
export function absoluteMinute(profile: TimeProfile, day: number, minuteOfDay: number): number {
  if (!Number.isInteger(day) || day < 1) {
    throw new ContractViolation('bad_day', `day must be a positive integer, got ${day}`);
  }
  if (!Number.isFinite(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= profile.minutesPerDay) {
    throw new ContractViolation('bad_minute', `minuteOfDay out of range: ${minuteOfDay}`);
  }
  return (day - 1) * profile.minutesPerDay + minuteOfDay;
}

/** Elapsed calendar minutes from profile start to (day, minuteOfDay). */
export function elapsedMinutes(profile: TimeProfile, day: number, minuteOfDay: number): number {
  const start = absoluteMinute(profile, profile.startDay, profile.startMinuteOfDay);
  return absoluteMinute(profile, day, minuteOfDay) - start;
}

export const GOSPEL_ELAPSED_MINUTES =
  elapsedMinutes(GOSPEL_PROFILE, GOSPEL_PROFILE.endDay, GOSPEL_PROFILE.endMinuteOfDay);

export function dayOf(profile: TimeProfile, absolute: number): number {
  return Math.floor(absolute / profile.minutesPerDay) + 1;
}

export function minuteOfDayOf(profile: TimeProfile, absolute: number): number {
  return absolute % profile.minutesPerDay;
}

// ---------------------------------------------------------------------------
// Preconditions and intents
// ---------------------------------------------------------------------------

export type Precondition =
  | { kind: 'resource_at_least'; resource: ResourceId; amount: number }
  | { kind: 'actor_alive'; actorId: string }
  | { kind: 'actor_at'; actorId: string; location: LocationId }
  | { kind: 'machine_state'; machine: MachineId; states: MachineState[] }
  | { kind: 'time_before'; absoluteMinute: number };

export type ActorVitalField =
  | 'hunger' | 'stamina' | 'health' | 'san' | 'bodyTemp';

export type ActorDelta = Partial<Record<ActorVitalField, number>>;

/**
 * A typed, preconditioned request to change shared state. The integrator
 * validates it against the authoritative snapshot and applies it atomically;
 * nothing else may write the shared world.
 */
export type WorldIntent =
  | {
    id: string;
    kind: 'resource';
    resource: ResourceId;
    /** Negative spends, positive gains. Never both in one intent. */
    delta: number;
    actorId: string;
    source: string;
    preconditions: Precondition[];
  }
  | {
    id: string;
    kind: 'actor';
    actorId: string;
    delta: ActorDelta;
    source: string;
    preconditions: Precondition[];
  }
  | {
    id: string;
    kind: 'spatial';
    actorId: string;
    to: LocationId;
    source: string;
    preconditions: Precondition[];
  }
  | {
    id: string;
    kind: 'machine';
    machine: MachineId;
    to: MachineState;
    actorId: string;
    source: string;
    preconditions: Precondition[];
  }
  | {
    id: string;
    kind: 'intent-note';
    /** Deterministic, world-visible note used by tasks/crises (no hidden state). */
    key: string;
    value: number;
    actorId: string;
    source: string;
    preconditions: Precondition[];
  };

export type IntentKind = WorldIntent['kind'];

/** Proposed event: not authoritative until committed. */
export interface DomainEventProposal {
  /** Proposal id, stable within a domain result. */
  proposalId: string;
  type: string;
  actorId: string;
  /** Everyone sees it, or only the listed observers (rumor scope). */
  observedBy: 'all' | string[];
  payload: Record<string, unknown>;
}

/** A request that needs another subsystem's decision (never executed here). */
export interface DomainRequest {
  requestId: string;
  kind: 'commitment' | 'council' | 'choice';
  actorId: string;
  payload: Record<string, unknown>;
}

export interface Rejection {
  intentId: string;
  code: string;
  reason: string;
}

export interface DomainResult<S> {
  state: S;
  intents: WorldIntent[];
  events: DomainEventProposal[];
  requests: DomainRequest[];
  rejections: Rejection[];
}

export function emptyResult<S>(state: S): DomainResult<S> {
  return { state, intents: [], events: [], requests: [], rejections: [] };
}

// ---------------------------------------------------------------------------
// Domain commands and context
// ---------------------------------------------------------------------------

export interface DomainCommand {
  type: string;
  actorId: string;
  /** Domain-owned, already validated payload. */
  payload?: Record<string, unknown>;
}

/** Read-only authoritative view handed to a domain. Never mutable. */
export interface DomainSnapshot {
  worldVersion: number;
  profile: TimeProfile;
  absoluteMinute: number;
  day: number;
  minuteOfDay: number;
  /** Inclusive day-1 elapsed minute, the number reported everywhere. */
  elapsed: number;
  resources: Record<ResourceId, number>;
  furnace: { lit: boolean; fuel: number; warmth: number };
  machines: Record<MachineId, MachineState>;
  weather: string;
  npcs: Record<string, DomainActorView>;
  /** Public, already-committed world facts (not proposals). */
  facts: Record<string, number>;
}

export interface DomainActorView {
  id: string;
  location: LocationId;
  alive: boolean;
  hunger: number;
  stamina: number;
  health: number;
  san: number;
  bodyTemp: number;
  /** Player-visible promise ids this actor is party to. */
  promises: string[];
}

export interface DomainContext {
  snapshot: Readonly<DomainSnapshot>;
  /** Stable, sorted actor ids. */
  actorIds: readonly string[];
  profile: TimeProfile;
  seed: string;
  /** True when this observer may see the fact/event with this id. */
  canSee: (observerId: string, eventIdOrType: string) => boolean;
}

// ---------------------------------------------------------------------------
// Domain module
// ---------------------------------------------------------------------------

export interface DomainModule<S> {
  readonly id: string;
  initial(context: Readonly<DomainContext>): S;
  reduce(state: Readonly<S>, command: DomainCommand,
    context: Readonly<DomainContext>): DomainResult<S>;
  onTimeSpan(state: Readonly<S>, fromMinute: number, toMinute: number,
    context: Readonly<DomainContext>): DomainResult<S>;
  /** Optional serialisable shape check; the integrator calls it on restore. */
  serialize?(state: Readonly<S>): unknown;
  restore?(raw: unknown): S;
}

export class ContractViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractViolation';
    this.code = code;
  }
}

/**
 * Registration order is the commit order for equal-priority intents; it is
 * frozen here so two runs cannot disagree.
 */
export class DomainRegistry {
  private readonly modules = new Map<string, DomainModule<unknown>>();

  static readonly ORDER: readonly string[] = ['survival', 'production', 'tasks', 'council', 'crises', 'life'];

  register<S>(module: DomainModule<S>): void {
    if (this.modules.has(module.id)) {
      throw new ContractViolation('duplicate_domain', `domain ${module.id} registered twice`);
    }
    this.modules.set(module.id, module as unknown as DomainModule<unknown>);
  }

  get<S>(id: string): DomainModule<S> {
    const found = this.modules.get(id);
    if (!found) throw new ContractViolation('unknown_domain', `domain ${id} is not registered`);
    return found as unknown as DomainModule<S>;
  }

  ids(): string[] {
    return [...this.modules.keys()].sort((left, right) =>
      DomainRegistry.ORDER.indexOf(left) - DomainRegistry.ORDER.indexOf(right));
  }

  /** Initialise every domain against one snapshot, in frozen order. */
  initialise(context: Readonly<DomainContext>): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const id of this.ids()) state[id] = this.modules.get(id)!.initial(context);
    return state;
  }
}

// ---------------------------------------------------------------------------
// JEV bridge (CONTRACT.txt section 3)
// ---------------------------------------------------------------------------

/**
 * What the game sends to a scorer. It is the existing ChoiceRequest, not a
 * second public input; the fields below are exactly the ones the adapter may
 * read when rendering candidates.
 */
export interface ActionRenderView {
  actorId: string;
  kind: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Only facts this actor can establish. Hidden stock is never enumerated. */
  preconditions: string[];
}

export function candidateToRenderView(candidate: Candidate): ActionRenderView {
  const action = candidate.parameters?.action;
  if (typeof action === 'string' && action !== candidate.kind) {
    throw new ContractViolation('kind_action_mismatch',
      `kind ${candidate.kind} disagrees with parameters.action ${action}`);
  }
  return {
    actorId: '',
    kind: candidate.kind,
    description: candidate.description,
    parameters: candidate.parameters,
    preconditions: [...candidate.preconditions].sort(),
  };
}

export type ScorerModeId = 'reference' | 'jev-experimental' | 'jev-admitted';

export interface ScorerIdentity {
  mode: ScorerModeId;
  scorerId: string;
  checkpointSha256?: string;
  encoderId?: string;
  rendererId?: string;
  memoryPolicyId?: string;
  dataCertificateSha256?: string;
  calibrationId?: string;
  /** Experimental scorers can never claim admission. */
  experimental: boolean;
  countsAsAdmitted: boolean;
}

export interface ScorerReply {
  result: ChoiceResult;
  identity: ScorerIdentity;
  latencyMs: number;
}

export interface ScorePort {
  readonly identity: ScorerIdentity;
  score(request: ChoiceRequest): ChoiceResult | Promise<ChoiceResult>;
}

export function assertScorerIdentity(identity: ScorerIdentity, expected: {
  mode?: ScorerModeId; experimental?: boolean;
}): void {
  if (expected.mode && identity.mode !== expected.mode) {
    throw new ContractViolation('scorer_mode', `expected ${expected.mode}, got ${identity.mode}`);
  }
  if (expected.experimental !== undefined && identity.experimental !== expected.experimental) {
    throw new ContractViolation('scorer_flag',
      `experimental flag mismatch: ${identity.experimental} != ${expected.experimental}`);
  }
  if (identity.experimental && identity.countsAsAdmitted) {
    throw new ContractViolation('experimental_admitted',
      'an experimental scorer may not report countsAsAdmitted=true');
  }
}
