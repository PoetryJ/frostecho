/**
 * R8 runtime: one clock, one world, one commit point.
 *
 * `advanceWorld(to)` is the only way time moves. It splits the span at every
 * rule boundary (hour, day, night skip, settlement, profile end), settles the
 * domains for each segment in frozen order, commits their intents atomically
 * and only then lets the legacy `survival-rules/2` clock step once. No domain
 * advances the clock itself, and no span is ever charged to a body twice for
 * the same mechanism.
 */
import { PlaySession } from '../../application-v2/session';
import type { WorldEvent, WorldV2 } from '../../survival/world-v2';
import {
  DomainRegistry, GOSPEL_PROFILE, absoluteMinute, dayOf, elapsedMinutes,
  minuteOfDayOf, type CommittedEventRef, type DomainContext, type DomainSnapshot,
  type Rejection, type TimeProfile, type WorldIntent,
} from '../contracts';
import { commitIntents, ensureR8, snapshotOf } from './intents';
import { survivalDomain, type SurvivalState } from '../domains/survival/index';
import { productionDomain, type ProductionState } from '../domains/production/index';
import { tasksDomain, type TasksState } from '../domains/tasks/index';
import { councilDomain, type CouncilState } from '../domains/council/index';
import { crisesDomain, type CrisesState } from '../domains/crises/index';
import { lifeDomain, type LifeState } from '../domains/life/index';
import { LegacySpatialController, type LegacyMovementResult } from './spatial';
import type { Cell } from '../../spatial-v2/map';
import type { LegacyPosition } from '../../spatial-v2/legacy-profile';

export interface DomainStates {
  survival: SurvivalState;
  production: ProductionState;
  tasks: TasksState;
  council: CouncilState;
  crises: CrisesState;
  life: LifeState;
}

export type DomainId = keyof DomainStates;

export function createDomainRegistry(): DomainRegistry {
  const registry = new DomainRegistry();
  registry.register(survivalDomain);
  registry.register(productionDomain);
  registry.register(tasksDomain);
  registry.register(councilDomain);
  registry.register(crisesDomain);
  registry.register(lifeDomain);
  return registry;
}

export interface SegmentReport {
  from: number;
  to: number;
  minutes: number;
  applied: string[];
  rejected: Rejection[];
  events: string[];
}

export interface AdvanceReport {
  from: number;
  to: number;
  reachedEnd: boolean;
  segments: SegmentReport[];
  rejections: Rejection[];
  events: WorldEvent[];
  domainEvents: { type: string; actorId: string; payload: Record<string, unknown> }[];
}

/** A time-consuming action that occupies its actor until `endsAt`. */
export interface WorkItem {
  actorId: string;
  kind: string;
  commandId: string;
  candidate: import('../../decision/contracts').Candidate;
  startedAt: number;
  endsAt: number;
}

export interface RuntimeOptions {
  npcCount?: number;
  seed?: string;
  profile?: TimeProfile;
  /** Original RESOURCE_DEFAULTS (`resource-system.js:16-21`). */
  resources?: { food?: number; firewood?: number; power?: number; medicine?: number };
  session?: PlaySession;
}

/**
 * Rule boundaries in absolute minutes: every hour, every day start, the
 * night-skip window edges, the settlement hour and the profile end.
 */
export function boundariesBetween(profile: TimeProfile, from: number, to: number): number[] {
  const points = new Set<number>([from, to]);
  const hourStart = Math.ceil(from / 60) * 60;
  for (let at = hourStart; at < to; at += 60) {
    if (at > from) points.add(at);
  }
  for (let day = 1; day <= 5; day += 1) {
    for (const minuteOfDay of [0, profile.nightSkipToMinute, profile.nightSkipFromMinute,
      profile.settlementHour * 60]) {
      const at = (day - 1) * profile.minutesPerDay + minuteOfDay;
      if (at > from && at < to) points.add(at);
    }
  }
  const end = absoluteMinute(profile, profile.endDay, profile.endMinuteOfDay);
  if (end > from && end < to) points.add(end);
  return [...points].sort((left, right) => left - right);
}

/** Which task an action discharges, for closure on the real receipt. */
function workTaskType(candidate: { parameters: Record<string, unknown> }): string | null {
  const action = String(candidate.parameters.action ?? '');
  if (action === 'gather') {
    return candidate.parameters.resource === 'food' ? 'COLLECT_FOOD' : 'COLLECT_WOOD';
  }
  if (action === 'work') return 'MAINTAIN_POWER';
  if (action === 'rest') return 'REST_RECOVER';
  if (action === 'medical') return 'PREPARE_MEDICAL';
  if (action === 'refuel') return 'PREPARE_WARMTH';
  if (action === 'deposit' || action === 'deliver') return 'DISTRIBUTE_FOOD';
  return null;
}

export class R8Runtime {
  readonly registry = createDomainRegistry();
  readonly profile: TimeProfile;
  states: DomainStates;
  /** Every committed domain event, in commit order (the run journal). */
  readonly journal: { at: number; type: string; actorId: string; payload: Record<string, unknown> }[] = [];
  readonly rejections: Rejection[] = [];
  ended = false;
  endingKind: string | null = null;
  /** Occupancy: one work item per actor; several actors overlap in time. */
  readonly work = new Map<string, WorkItem>();
  /** Completed work items, in commit order (evidence for the time story). */
  readonly workLog: { actorId: string; kind: string; startedAt: number; endsAt: number;
    status: string; eventIds: string[] }[] = [];
  /** Every committed event by id: the only receipts a domain may accept. */
  private readonly committed = new Map<string, CommittedEventRef>();
  private readonly legacySpatial: LegacySpatialController;

  constructor(readonly session: PlaySession, profile: TimeProfile = GOSPEL_PROFILE,
    states?: DomainStates) {
    this.profile = profile;
    const context = this.context();
    this.states = states ?? (this.registry.initialise(context) as unknown as DomainStates);
    this.legacySpatial = new LegacySpatialController(this, (intents, events) => this.commit(intents, events));
  }

  static create(options: RuntimeOptions = {}): R8Runtime {
    const profile = options.profile ?? GOSPEL_PROFILE;
    if (options.session) return new R8Runtime(options.session, profile);
    const session = PlaySession.create(options.npcCount ?? 8, {
      seed: options.seed ?? 'r8-1',
      food: options.resources?.food ?? 130,
      days: 4,
    });
    // Original start: D1 08:00 (elapsed 0). The world clock is absolute.
    session.world.simTime = absoluteMinute(profile, profile.startDay, profile.startMinuteOfDay);
    session.world.day = profile.startDay;
    session.world.resources.firewood = options.resources?.firewood ?? 30;
    session.world.resources.power = options.resources?.power ?? 30;
    session.world.resources.medicine = options.resources?.medicine ?? 3;
    ensureR8(session.world);
    return new R8Runtime(session, profile);
  }

  get world(): WorldV2 {
    return this.session.world;
  }

  snapshot(): DomainSnapshot {
    return snapshotOf(this.world, this.profile);
  }

  context(): DomainContext {
    const snapshot = this.snapshot();
    const actorIds = [...this.session.npcIds].sort();
    return {
      snapshot,
      actorIds,
      profile: this.profile,
      seed: this.session.seed,
      canSee: () => true,
      committed: (eventId: string) => this.committed.get(eventId) ?? null,
    };
  }

  elapsed(): number {
    const day = dayOf(this.profile, this.world.simTime);
    return elapsedMinutes(this.profile, day, minuteOfDayOf(this.profile, this.world.simTime));
  }

  /** Explicit opt-in. No coordinate changes occur in the legacy/default flow. */
  enableLegacySpatial(): ReturnType<LegacySpatialController['enable']> {
    return this.legacySpatial.enable();
  }
  legacyPosition(actorId: string): LegacyPosition | null { return this.legacySpatial.position(actorId); }
  moveLegacy(actorId: string, to: Cell, commandId?: string): LegacyMovementResult {
    return this.legacySpatial.move(actorId, to, commandId);
  }
  transitionLegacy(actorId: string, commandId?: string): LegacyMovementResult {
    return this.legacySpatial.door(actorId, commandId);
  }
  walkLegacy(actorId: string, to: Cell, commandId?: string): LegacyMovementResult {
    return this.legacySpatial.walk(actorId, to, commandId);
  }
  travelLegacyTo(actorId: string, location: string, commandId?: string): LegacyMovementResult {
    return this.legacySpatial.travelTo(actorId, location, commandId);
  }
  observeLegacyStock(actorId: string, commandId?: string): LegacyMovementResult {
    return this.legacySpatial.observeStock(actorId, commandId);
  }

  /** Dispatch one domain command and commit its intents. */
  dispatch(domainId: DomainId, type: string, actorId: string,
    payload: Record<string, unknown> = {}): { applied: string[]; rejected: Rejection[];
      events: WorldEvent[] } {
    // The old rescue command teleports a victim. The original-map profile
    // requires an explicit routed rescue implementation; never leave its
    // authoritative coordinates stale while claiming the rescue succeeded.
    if (this.legacySpatial.enabled() && domainId === 'crises' && type === 'rescue') {
      const rejected = { intentId: `crises:${actorId}:rescue`, code: 'original_map_requires_routed_rescue',
        reason: 'Legacy teleport rescue is unavailable while original-map coordinates are active.' };
      this.rejections.push(rejected);
      return { applied: [], rejected: [rejected], events: [] };
    }
    const module = this.registry.get<DomainStates[DomainId]>(domainId);
    const context = this.context();
    const result = module.reduce(this.states[domainId] as never,
      { type, actorId, payload }, context) as unknown as {
        state: DomainStates[DomainId]; intents: WorldIntent[];
        events: { type: string; actorId: string; payload: Record<string, unknown> }[];
        rejections: Rejection[];
      };
    this.states[domainId] = result.state as never;
    this.rejections.push(...result.rejections);
    const committed = this.commit(result.intents, result.events);
    return { ...committed, rejected: [...result.rejections, ...committed.rejected] };
  }

  /**
   * Settle every domain over [from, to) then step the legacy clock once.
   * Segments are the rule boundaries, so the outcome never depends on how the
   * caller chopped the wait.
   */
  advanceWorld(to: number): AdvanceReport {
    const from = this.world.simTime;
    if (!Number.isFinite(to) || to < from) {
      throw new Error(`advanceWorld refuses to move backwards: ${from} -> ${to}`);
    }
    const profileEnd = absoluteMinute(this.profile, this.profile.endDay,
      this.profile.endMinuteOfDay);
    const target = Math.min(to, profileEnd);
    const points = boundariesBetween(this.profile, from, target);
    const report: AdvanceReport = {
      from, to: target, reachedEnd: target >= profileEnd, segments: [],
      rejections: [], events: [], domainEvents: [],
    };
    for (let index = 1; index < points.length; index += 1) {
      const segmentFrom = points[index - 1];
      const segmentTo = points[index];
      const minutes = segmentTo - segmentFrom;
      if (minutes <= 0) continue;
      const intents: WorldIntent[] = [];
      const domainEvents: { type: string; actorId: string; payload: Record<string, unknown> }[] = [];
      const rejections: Rejection[] = [];
      const context = this.context();
      for (const id of this.registry.ids()) {
        const module = this.registry.get<unknown>(id);
        const result = module.onTimeSpan(this.states[id as DomainId] as never,
          segmentFrom, segmentTo, context) as unknown as {
            state: unknown; intents: WorldIntent[];
            events: { type: string; actorId: string; payload: Record<string, unknown> }[];
            rejections: Rejection[];
          };
        this.states[id as DomainId] = result.state as never;
        intents.push(...result.intents);
        domainEvents.push(...result.events);
        rejections.push(...result.rejections);
      }
      const committed = this.commit(intents, domainEvents);
      const step = this.session.advance(minutes);
      const completedWork = this.settleWork();
      report.segments.push({
        from: segmentFrom, to: segmentTo, minutes,
        applied: [...committed.applied, ...(step.status === 'applied' ? [] : [step.status])],
        rejected: [...committed.rejected, ...rejections],
        events: [...committed.events.map(event => event.eventId),
          ...committed.domainEvents.map(event => `${event.type}@${event.actorId}`)],
      });
      report.rejections.push(...committed.rejected);
      report.events.push(...committed.events);
      report.domainEvents.push(...committed.domainEvents);
    }
    // Life domain drives the ending exactly once (P4). The domain sees the
    // snapshot at each segment START, so the final minute is also checked
    // against the committed clock here.
    for (const event of report.domainEvents) {
      if (event.type === 'ending_due') {
        const settled = this.settleEnding();
        if (settled) report.domainEvents.push(settled);
      }
    }
    if (!this.ended && this.world.simTime >= profileEnd) {
      const day = dayOf(this.profile, this.world.simTime);
      const minuteOfDay = minuteOfDayOf(this.profile, this.world.simTime);
      if (day >= this.profile.endDay && minuteOfDay >= this.profile.endMinuteOfDay) {
        const settled = this.settleEnding();
        if (settled) report.domainEvents.push(settled);
      }
    }
    if (!this.ended && Object.values(this.world.npcs).every(npc => !npc.alive)) {
      const settled = this.settleEnding();
      if (settled) report.domainEvents.push(settled);
    }
    return report;
  }

  /** Settle the run once, using the original four thresholds. */
  settleEnding(): { type: string; actorId: string; payload: Record<string, unknown> } | null {
    if (this.ended) return null;
    const result = this.dispatch('life', 'settle', 'system', {});
    const event = result.events.find(entry => entry.type.startsWith('r8_'));
    const ending = (this.states.life as LifeState).ending;
    if (!ending) return null;
    this.ended = true;
    this.endingKind = ending.kind;
    this.world.ending = ending.survivors === 0 ? 'all-dead' : 'survived';
    const domainEvent = { type: 'ending_reached', actorId: 'system',
      payload: { ending: ending.kind, survivors: ending.survivors,
        elapsed: ending.settledAtElapsed } };
    this.journal.push({ at: this.world.simTime, ...domainEvent });
    void event;
    return domainEvent;
  }

  /** D4 18:00 or extinction: advance as far as allowed, then settle. */
  runToEnding(): AdvanceReport {
    const end = absoluteMinute(this.profile, this.profile.endDay, this.profile.endMinuteOfDay);
    const report = this.advanceWorld(end);
    this.settleEnding();
    return report;
  }

  /** New life: same engine, cleared commitments/tasks, kept conditional lessons. */
  reincarnate(options: RuntimeOptions = {}): R8Runtime {
    if (!this.ended) throw new Error('reincarnate requires a settled ending');
    const result = this.dispatch('life', 'reincarnate', 'system', {});
    void result;
    const lessons = (this.states.life as LifeState).pastLives
      .flatMap(record => record.lessons).slice(-20);
    const next = R8Runtime.create({ ...options, profile: this.profile,
      seed: `${this.session.seed}-life${(this.states.life as LifeState).lifeNumber}` });
    // Carry the life bookkeeping, never current facts.
    (next.states.life as LifeState).lifeNumber = (this.states.life as LifeState).lifeNumber;
    (next.states.life as LifeState).pastLives = (this.states.life as LifeState).pastLives
      .map(record => ({ ...record, lessons: [...record.lessons] }));
    if (this.legacySpatial.enabled()) next.enableLegacySpatial();
    void lessons;
    return next;
  }

  private commit(intents: readonly WorldIntent[],
    domainEvents: { type: string; actorId: string; payload: Record<string, unknown> }[]):
    { applied: string[]; rejected: Rejection[]; events: WorldEvent[];
      domainEvents: { type: string; actorId: string; payload: Record<string, unknown> }[] } {
    const { world, outcome } = commitIntents(this.world, intents, { profile: this.profile });
    this.session.world = world;
    this.rejections.push(...outcome.rejected);
    for (const event of outcome.events) {
      this.committed.set(event.eventId, { eventId: event.eventId, type: event.type,
        actorId: event.actorId ?? 'system', simTime: event.simTime,
        payload: event.payload });
      this.session.ingestTeamEvent(event.type, event.payload, event.simTime);
    }
    const delivered: typeof domainEvents = [];
    const events: WorldEvent[] = [...outcome.events];
    for (const event of domainEvents) {
      // A domain event becomes a committed event with its own id, so it can be
      // used as a receipt ("machine_built") exactly like a world event.
      const eventId = `d:${this.world.simTime}:${event.type}:${event.actorId}`;
      const committed = { eventId, type: event.type, actorId: event.actorId,
        simTime: this.world.simTime, payload: event.payload };
      this.committed.set(eventId, committed);
      events.push({ ...committed, actorId: event.actorId } as WorldEvent);
      this.session.ingestTeamEvent(event.type, event.payload, this.world.simTime);
      this.journal.push({ at: this.world.simTime, ...event });
      delivered.push(event);
    }
    return { applied: outcome.applied, rejected: outcome.rejected,
      events, domainEvents: delivered };
  }

  /**
   * Start a time-consuming action. Nothing is applied until the clock reaches
   * `endsAt`; the actor cannot start a second action meanwhile. Two actors'
   * work overlaps instead of being serialised onto one another.
   */
  beginWork(actorId: string, kind: string, commandId: string,
    candidate: import('../../decision/contracts').Candidate, minutes: number):
    { startedAt: number; endsAt: number } | { rejected: string } {
    if (this.work.has(actorId)) {
      return { rejected: `actor ${actorId} is busy until ${this.work.get(actorId)!.endsAt}` };
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { rejected: `invalid work duration ${minutes}` };
    }
    const startedAt = this.world.simTime;
    const endsAt = startedAt + minutes;
    this.work.set(actorId, { actorId, kind, commandId, candidate, startedAt, endsAt });
    return { startedAt, endsAt };
  }

  busyUntil(actorId: string): number | null {
    return this.work.get(actorId)?.endsAt ?? null;
  }

  /**
   * Complete every work item the committed clock has passed. Called by
   * advanceWorld only, so CLI, web and the four-day runner finish work at the
   * same authoritative moment.
   */
  settleWork(): { actorId: string; kind: string; status: string; eventIds: string[] }[] {
    const done: { actorId: string; kind: string; status: string; eventIds: string[] }[] = [];
    for (const item of [...this.work.values()]) {
      if (this.world.simTime < item.endsAt) continue;
      this.work.delete(item.actorId);
      let status = 'applied';
      let eventIds: string[] = [];
      try {
        const outcome = this.session.executeCandidate(item.actorId, item.candidate,
          item.commandId);
        if (outcome.events) this.recordCommitted(outcome.events);
        status = outcome.status;
        eventIds = outcome.eventIds;
      } catch (error) {
        status = `error:${(error as Error).message}`;
      }
      // A finished work item closes its own task on its own receipt.
      if (status === 'applied' && eventIds.length > 0) {
        const type = workTaskType(item.candidate);
        if (type) {
          const tasks = (this.states.tasks as { tasks: { taskId: string; type: string;
            status: string; assigneeId: string }[] }).tasks;
          const task = tasks.find(entry => entry.assigneeId === item.actorId
            && entry.status === 'accepted' && entry.type === type);
          if (task) {
            this.dispatch('tasks', 'complete', item.actorId,
              { taskId: task.taskId, receiptEventId: eventIds[eventIds.length - 1] });
          }
        }
      }
      this.workLog.push({ actorId: item.actorId, kind: item.kind,
        startedAt: item.startedAt, endsAt: item.endsAt, status, eventIds });
      done.push({ actorId: item.actorId, kind: item.kind, status, eventIds });
    }
    return done;
  }

  /**
   * Register events produced by the world authority itself (a gather, a walk,
   * a delivery). Only these can back a task completion receipt.
   */
  recordCommitted(events: readonly { eventId: string; type: string;
    actorId?: string; simTime: number; payload: Record<string, unknown> }[]): void {
    for (const event of events) {
      this.committed.set(event.eventId, { eventId: event.eventId, type: event.type,
        actorId: event.actorId ?? 'system', simTime: event.simTime,
        payload: event.payload });
    }
  }

  /** Every committed event, oldest first; the receipt source of truth. */
  committedEvents(): CommittedEventRef[] {
    return [...this.committed.values()];
  }

  /** Lookup used by tests and by the completion gate. */
  committedEvent(eventId: string): CommittedEventRef | null {
    return this.committed.get(eventId) ?? null;
  }

  /** Session + runtime sidecar: one save, restored together. */
  save(path: string): void {
    this.session.save(path);
    const document = this.toDocument();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    // Original-map restoration compares live authority, not a lossy JSON
    // projection. The crisis cooldown starts at -Infinity; ordinary JSON
    // turns it into null and changes the resumed domain state.
    document.numberEncoding = 'frostecho.nonfinite-number/1';
    const text = JSON.stringify(document, (_key, value: unknown) => {
      if (typeof value !== 'number' || Number.isFinite(value)) return value;
      if (value === Number.NEGATIVE_INFINITY) return { $frostechoNumber: '-Infinity' };
      throw new Error('unsupported_nonfinite_runtime_number');
    }, 2);
    writeFileSync(`${path}.r8.json`, `${text}\n`, 'utf8');
  }

  static load(path: string, profile: TimeProfile = GOSPEL_PROFILE): R8Runtime {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const session = PlaySession.load(path);
    const sidecar = `${path}.r8.json`;
    if (!existsSync(sidecar)) {
      const runtime = new R8Runtime(session, profile);
      if (runtime.legacySpatial.enabled()) throw new Error('missing_r8_sidecar_for_original_map_receipts');
      return runtime;
    }
    const document = JSON.parse(readFileSync(sidecar, 'utf8'), (_key, value: unknown) => {
      if (value && typeof value === 'object' && Object.keys(value).length === 1
        && (value as { $frostechoNumber?: string }).$frostechoNumber === '-Infinity') return Number.NEGATIVE_INFINITY;
      return value;
    }) as {
      schema: string; clock: number; ended: boolean;
      endingKind: string | null; states: DomainStates;
      journal?: R8Runtime['journal']; rejections?: Rejection[];
      committed?: CommittedEventRef[];
      work?: WorkItem[];
      workLog?: R8Runtime['workLog'];
    };
    if (document.schema !== 'frostecho.r8-runtime/1') {
      throw new Error(`unsupported runtime sidecar ${document.schema}`);
    }
    // Pre-encoding v1 sidecars wrote the initial -Infinity sentinel as null.
    // Finite cooldown times were already JSON-safe; repair only that field.
    if (document.states.crises.lastFoodConflictMinute === null)
      document.states.crises.lastFoodConflictMinute = Number.NEGATIVE_INFINITY;
    const runtime = new R8Runtime(session, profile, document.states);
    runtime.ended = Boolean(document.ended);
    runtime.endingKind = document.endingKind ?? null;
    if (document.journal) runtime.journal.push(...document.journal);
    for (const event of document.committed ?? []) {
      runtime.committed.set(event.eventId, event);
    }
    for (const item of document.work ?? []) runtime.work.set(item.actorId, item);
    if (document.workLog) runtime.workLog.push(...document.workLog);
    if (document.rejections) runtime.rejections.push(...document.rejections);
    if (runtime.legacySpatial.enabled()) {
      if (profile.id !== 'gospel-5.8.19') throw new Error('original_map_save_requires_gospel_profile');
      for (const actorId of runtime.session.npcIds) runtime.legacyPosition(actorId);
    }
    return runtime;
  }

  /** Sidecar document: the domains plus the clock, in one transaction. */
  toDocument(): Record<string, unknown> {
    return {
      schema: 'frostecho.r8-runtime/1',
      profile: this.profile.id,
      clock: this.world.simTime,
      ended: this.ended,
      endingKind: this.endingKind,
      states: this.states,
      journal: this.journal,
      committed: [...this.committed.values()],
      work: [...this.work.values()],
      workLog: this.workLog,
      rejections: this.rejections.slice(-200),
    };
  }
}
