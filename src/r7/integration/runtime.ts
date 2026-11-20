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
import { mintWorkGrant, requiredPlaceOf } from '../../execution/place-rules';
import { createIntent, demandIdOf, projectionOf, type ActionIntent, type ActionStatus,
  type ProjectionClaim } from './action-intent';
import { survivalDomain, type SurvivalState } from '../domains/survival/index';
import { productionDomain, type ProductionState } from '../domains/production/index';
import { tasksDomain, WORK_MODE_TASK, type TasksState, type WorkMode } from '../domains/tasks/index';
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

/**
 * Read-only view of an actor's occupied interval. `work` is derived from the
 * persistent intents so existing status/CLI surfaces keep working while the
 * intent record stays the single source of truth.
 */
export interface WorkItem {
  intentId: string;
  actorId: string;
  kind: string;
  commandId: string;
  /** Demand identity: a re-issued identical action dedupes onto this record. */
  demandId: string;
  candidate: import('../../decision/contracts').Candidate;
  taskId: string | null;
  commitmentId: string | null;
  commitmentRevision: number | null;
  generation: number;
  startedAt: number;
  endsAt: number;
}

/** Can this queued action still be settled? Returning a string revokes it. */
export type IntentGuard = (intent: ActionIntent) => string | null;
/** Applies a committed receipt to an external ledger (task board/commitments). */
export type IntentProjector = (claim: ProjectionClaim,
  intent: ActionIntent) => boolean;

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
 * night-skip window edges, the settlement hour, the profile end and every
 * pending work `due`.
 *
 * Including the due times is what makes the outcome independent of how a caller
 * chopped the wait: a 10-minute job due at 490 settles at 490 whether the caller
 * advanced to 490 or straight to 540.
 */
export function boundariesBetween(profile: TimeProfile, from: number, to: number,
  duePoints: readonly number[] = []): number[] {
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
  for (const at of duePoints) {
    if (at > from && at < to) points.add(at);
  }
  const end = absoluteMinute(profile, profile.endDay, profile.endMinuteOfDay);
  if (end > from && end < to) points.add(end);
  return [...points].sort((left, right) => left - right);
}

/**
 * Which task an action discharges, for closure on the real receipt. The work
 * mode decides the five non-resource tasks; a caller-supplied `taskType` is
 * never trusted here, so a power receipt cannot close a morale task.
 */
function workTaskType(candidate: { parameters: Record<string, unknown> }): string | null {
  const action = String(candidate.parameters.action ?? '');
  if (action === 'gather') {
    return candidate.parameters.resource === 'food' ? 'COLLECT_FOOD' : 'COLLECT_WOOD';
  }
  if (action === 'work') {
    const mode = String(candidate.parameters.mode ?? 'power') as WorkMode;
    return WORK_MODE_TASK[mode] ?? 'MAINTAIN_POWER';
  }
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
  /**
   * Every execution record, including terminal ones (bounded). This is the
   * single source of truth for "who is busy, until when, under which
   * authorisation and for which instance".
   */
  readonly intents = new Map<string, ActionIntent>();
  /** Occupancy view derived from `intents`; several actors overlap in time. */
  readonly work = new Map<string, WorkItem>();
  /** Completed work items, in commit order (evidence for the time story). */
  readonly workLog: { intentId: string; actorId: string; kind: string; demandId?: string;
    startedAt: number; endsAt: number; settledAt: number; status: string;
    eventIds: string[]; failureReason: string | null }[] = [];
  /**
   * Re-issued demands that were absorbed instead of queued a second time. Kept
   * as evidence, not as behaviour: a duplicate must be visible, not silent.
   */
  readonly duplicateDemands: { at: number; actorId: string; demandId: string;
    intentId: string; commandId: string; dueAt: number }[] = [];
  /**
   * Authorisation guards and ledger projectors are behaviour, not state: they
   * are re-registered by the owning subsystem after a restore, and every
   * pending projection is replayed from the persisted intent, never from a
   * process-local closure.
   */
  private readonly intentGuards: IntentGuard[] = [];
  private readonly projectors: IntentProjector[] = [];
  /** Every committed event by id: the only receipts a domain may accept. */
  private readonly committed = new Map<string, CommittedEventRef>();
  private readonly legacySpatial: LegacySpatialController;
  /**
   * R11-A: settlement reentrancy guard. While an intent is being settled, the
   * physical effect may not advance the global clock (the intent already paid
   * for its window), and a nested settle may not claim the same intent again.
   */
  private settlingDepth = 0;
  private readonly settlingIntents = new Set<string>();
  private activeSettlement: ActionIntent | null = null;
  /** Nested advance attempts are counted as evidence, never as clock movement. */
  nestedAdvanceSuppressed = 0;

  constructor(readonly session: PlaySession, profile: TimeProfile = GOSPEL_PROFILE,
    states?: DomainStates) {
    this.profile = profile;
    const context = this.context();
    this.states = states ?? (this.registry.initialise(context) as unknown as DomainStates);
    this.legacySpatial = new LegacySpatialController(this, (intents, events) => this.commit(intents, events));
    // Work only lands through `settleDueIntents`: the R8 entry helper refuses
    // an un-queued time-consuming action (see `executeCandidate` in step.ts).
    // The frozen legacy reference loop keeps its historical command path.
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
    // R11-A capability: on the original-map authority a work action may not
    // run inline without an intent-minted grant. Legacy callers that never
    // enable the original map keep their historical command path.
    this.session.requireWorkGrant = true;
    return this.legacySpatial.enable();
  }
  legacyPosition(actorId: string): LegacyPosition | null { return this.legacySpatial.position(actorId); }
  /** Planned original-map travel minutes (null when the route is unknown/blocked). */
  legacySpatialMinutes(actorId: string, target: string): number | null {
    return this.legacySpatial.planTravelMinutes(actorId, target);
  }
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
    // R11-A: inside settlement the paid window is already on the clock. A
    // physical effect (the original tile walk) must project, not buy more time.
    // Returning an empty report is deliberate: it cannot silently shorten or
    // extend anybody's clock, and the counter keeps the attempt auditable.
    if (this.settlingDepth > 0) {
      this.nestedAdvanceSuppressed += 1;
      return { from, to: from, reachedEnd: false, segments: [],
        rejections: [], events: [], domainEvents: [] };
    }
    const profileEnd = absoluteMinute(this.profile, this.profile.endDay,
      this.profile.endMinuteOfDay);
    const target = Math.min(to, profileEnd);
    // Every pending `due` is a clock boundary, so a job never waits for the
    // next hour and its settlement cannot depend on the caller's chunking.
    const points = boundariesBetween(this.profile, from, target, this.pendingDuePoints());
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
      const completedWork = this.settleDueIntents();
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
   * Queue a persistent, resumable action. Nothing is applied until the clock
   * reaches `dueAt`; the actor cannot start a second action meanwhile, while
   * two actors' work overlaps instead of being serialised.
   *
   * The authorisation token, the place premise and the exact task/commitment
   * instance are captured HERE, so settlement can re-validate them from data.
   */
  beginIntent(input: {
    intentId: string; commandId: string; actorId: string;
    candidate: import('../../decision/contracts').Candidate; minutes: number;
    inputSha256?: string | null; taskId?: string | null; taskType?: string | null;
    commitmentId?: string | null; commitmentRevision?: number | null;
    demandId?: string | null;
  }): { intent: ActionIntent; duplicate?: boolean } | { rejected: string } {
    const npc = this.world.npcs[input.actorId];
    if (!npc) return { rejected: `unknown actor ${input.actorId}` };
    if (!npc.alive) return { rejected: `actor ${input.actorId} is not alive` };
    // The SAME demand re-issued while it is still queued is not a second job:
    // it maps onto the intent that already occupies this body, so work minutes
    // and receipts cannot be counted twice. A different ledger instance has a
    // different demandId and still goes through the ordinary busy check.
    const demandId = input.demandId ?? demandIdOf({
      actorId: input.actorId, candidate: input.candidate,
      taskId: input.taskId ?? null, commitmentId: input.commitmentId ?? null,
      commitmentRevision: input.commitmentRevision ?? null });
    const queued = [...this.intents.values()].find(intent => intent.status === 'working'
      && intent.actorId === input.actorId
      && (intent.demandId ?? demandIdOf(intent)) === demandId);
    if (queued) {
      this.duplicateDemands.push({ at: this.world.simTime, actorId: input.actorId,
        demandId, intentId: queued.intentId, commandId: input.commandId, dueAt: queued.dueAt });
      return { intent: queued, duplicate: true };
    }
    const busy = this.work.get(input.actorId);
    if (busy) return { rejected: `actor ${input.actorId} is busy until ${busy.endsAt}` };
    const action = String(input.candidate.parameters.action ?? '');
    // R11-A: the original map's travel is planned up front, so the paid window
    // equals the real route. A fixed 15/20-minute estimate would either settle
    // the actor mid-route or buy extra clock at settlement.
    const plannedMinutes = action === 'move' && this.legacySpatial.enabled()
      ? this.legacySpatial.planTravelMinutes(input.actorId,
        String(input.candidate.parameters.to ?? '')) : null;
    const minutes = plannedMinutes !== null && plannedMinutes > 0
      ? plannedMinutes : input.minutes;
    if (!Number.isFinite(minutes) || minutes <= 0)
      return { rejected: `invalid work duration ${minutes}` };
    if (this.intents.has(input.intentId))
      return { rejected: `intent ${input.intentId} already exists` };
    const place = requiredPlaceOf(action, input.candidate.parameters as Record<string, unknown>);
    if (place && npc.location !== place) {
      return { rejected: `wrong_location: ${action} needs ${place}, actor is at ${npc.location}` };
    }
    const intent = createIntent({ ...input, minutes, demandId,
      generation: this.session.generationFor(input.actorId) },
      this.world.simTime, place, npc.location);
    this.intents.set(intent.intentId, intent);
    this.syncWorkView();
    return { intent };
  }

  /** Compatibility wrapper: no explicit instance binding. */
  beginWork(actorId: string, kind: string, commandId: string,
    candidate: import('../../decision/contracts').Candidate, minutes: number):
    { startedAt: number; endsAt: number } | { rejected: string } {
    const begun = this.beginIntent({ intentId: commandId, commandId, actorId, candidate, minutes,
      taskId: typeof candidate.parameters.taskId === 'string' ? candidate.parameters.taskId : null,
      taskType: workTaskType(candidate) });
    if ('rejected' in begun) return { rejected: begun.rejected };
    void kind;
    return { startedAt: begun.intent.startedAt, endsAt: begun.intent.dueAt };
  }

  /** The queued intent that already carries this demand, if any. */
  queuedDemand(actorId: string, demandId: string): ActionIntent | null {
    for (const intent of this.intents.values()) {
      if (intent.status !== 'working' || intent.actorId !== actorId) continue;
      if ((intent.demandId ?? demandIdOf(intent)) === demandId) return intent;
    }
    return null;
  }

  busyUntil(actorId: string): number | null {
    return this.work.get(actorId)?.endsAt ?? null;
  }

  activeIntent(actorId: string): ActionIntent | null {
    const view = this.work.get(actorId);
    return view ? this.intents.get(view.intentId) ?? null : null;
  }

  /** Authorisation guards are behaviour: re-register them after a restore. */
  registerIntentGuard(guard: IntentGuard): void {
    this.intentGuards.push(guard);
  }

  /** Ledger projector for a committed receipt; replayable, never a closure. */
  registerIntentProjector(projector: IntentProjector): void {
    this.projectors.push(projector);
  }

  /** Due times of every queued action: they are clock boundaries. */
  pendingDuePoints(): number[] {
    return [...this.intents.values()].filter(intent => intent.status === 'working')
      .map(intent => intent.dueAt);
  }

  /**
   * Cancel a queued action before it commits: zero late physical effect, and
   * the cancelled record stays readable (reason + time).
   */
  cancelIntent(intentId: string, reason: string): boolean {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== 'working') return false;
    this.finishIntent(intent, 'cancelled', reason);
    return true;
  }

  /** Revoke every queued action bound to a commitment instance/revision. */
  cancelForCommitment(commitmentId: string, reason: string): string[] {
    const cancelled: string[] = [];
    for (const intent of [...this.intents.values()]) {
      if (intent.status !== 'working' || intent.commitmentId !== commitmentId) continue;
      this.finishIntent(intent, 'cancelled', reason);
      cancelled.push(intent.intentId);
    }
    return cancelled;
  }

  /**
   * Complete every queued action the committed clock has reached, in a fixed
   * order (due, then id). Called by advanceWorld only, so CLI, web, the
   * four-day runner and a resumed process settle at the same authoritative
   * moment.
   */
  settleDueIntents(): { actorId: string; kind: string; status: string; eventIds: string[] }[] {
    const due = [...this.intents.values()]
      .filter(intent => intent.status === 'working' && this.world.simTime >= intent.dueAt
        && !this.settlingIntents.has(intent.intentId))
      // A strict total order that does not depend on ICU/locale or Map
      // insertion order: (dueAt, intentId) with a code-unit comparison.
      .sort((left, right) => left.dueAt - right.dueAt
        || (left.intentId < right.intentId ? -1 : left.intentId > right.intentId ? 1 : 0));
    const done: { actorId: string; kind: string; status: string; eventIds: string[] }[] = [];
    for (const intent of due) {
      let status: ActionStatus = 'applied';
      let reason: string | null = null;
      let eventIds: string[] = [];
      const npc = this.world.npcs[intent.actorId];
      if (!npc || !npc.alive) {
        status = 'cancelled'; reason = 'actor_not_alive';
      } else if (this.session.generationFor(intent.actorId) !== intent.generation) {
        status = 'cancelled'; reason = 'generation_revoked';
      } else if (intent.requiredPlace && npc.location !== intent.requiredPlace) {
        status = 'rejected';
        reason = `wrong_location: ${String(intent.candidate.parameters.action)} needs `
          + `${intent.requiredPlace}, actor is at ${npc.location}`;
      } else {
        // A withdrawn authorisation is a REFUSAL the actor really receives, not
        // a silent cancellation: the world keeps its answer, and the actor gets
        // its own observation of the failed attempt.
        for (const guard of this.intentGuards) {
          const revoked = guard(intent);
          if (revoked) { status = 'rejected'; reason = revoked; break; }
        }
        if (status === 'applied' && intent.taskId && intent.taskType) {
          const task = this.taskRow(intent.taskId);
          if (!task || task.status !== 'accepted' || task.assigneeId !== intent.actorId) {
            status = 'cancelled'; reason = 'task_not_open';
          }
        }
      }
      if (status === 'applied') {
        // Claim BEFORE the physical effect: a nested settle (the original
        // travel path calls back into the clock) sees a claimed intent and
        // cannot execute, log or bill it a second time.
        this.settlingIntents.add(intent.intentId);
        this.settlingDepth += 1;
        this.activeSettlement = intent;
        try {
          const grant = mintWorkGrant(intent.intentId, intent.actorId, intent.candidateId);
          const outcome = this.session.executeCandidate(intent.actorId, intent.candidate,
            intent.commandId, grant);
          if (outcome.events) this.recordCommitted(outcome.events);
          status = outcome.status === 'applied' ? 'applied'
            : outcome.status === 'rejected' ? 'rejected' : 'unresolved';
          eventIds = outcome.eventIds;
          reason = outcome.reason ?? null;
        } catch (error) {
          status = 'rejected';
          reason = `error:${(error as Error).message}`;
        } finally {
          this.activeSettlement = null;
          this.settlingDepth -= 1;
          this.settlingIntents.delete(intent.intentId);
        }
      }
      intent.status = status;
      intent.receiptIds = eventIds;
      intent.failureReason = reason;
      intent.settledAt = this.world.simTime;
      if (status === 'rejected' && reason) this.recordRejection(intent, reason);
      if (status === 'applied' && eventIds.length > 0) {
        this.applyProjection(intent, eventIds);
      }
      this.logIntent(intent);
      done.push({ actorId: intent.actorId, kind: String(intent.candidate.parameters.action),
        status, eventIds });
    }
    return done;
  }

  /** Alias kept for callers that name the R9 method. */
  settleWork(): { actorId: string; kind: string; status: string; eventIds: string[] }[] {
    return this.settleDueIntents();
  }

  /** True while a committed intent's physical effect is being applied. */
  isSettling(): boolean { return this.settlingDepth > 0; }

  /**
   * The window the current settlement already paid for. Physical effects use
   * it to project themselves inside the paid minutes instead of buying more.
   */
  currentSettlement(): { intentId: string; startedAt: number; dueAt: number;
    paidMinutes: number } | null {
    const intent = this.activeSettlement;
    return intent ? { intentId: intent.intentId, startedAt: intent.startedAt,
      dueAt: intent.dueAt, paidMinutes: intent.dueAt - intent.startedAt } : null;
  }

  /**
   * Apply (or retry) the ledger projection of an already committed receipt.
   * Safe to call repeatedly: a claim records whether it was applied.
   */
  replayPendingProjections(): number {
    let applied = 0;
    for (const intent of this.intents.values()) {
      for (const claim of intent.projections) {
        if (claim.applied) continue;
        if (this.runProjection(intent, claim)) applied += 1;
      }
    }
    return applied;
  }

  /**
   * A refused attempt is an observation of THIS actor, phrased so it cannot
   * reveal a terminal state the actor never heard: the precise reason stays in
   * the engine record (`failureReason`), the personal note says only that the
   * attempt was not authorised.
   */
  private recordRejection(intent: ActionIntent, reason: string): void {
    const neutral = reason.startsWith('commitment_') ? 'authorisation_withdrawn'
      : reason === 'task_not_open' ? 'task_no_longer_open' : reason;
    const eventId = `d:${this.world.simTime}:action_rejected:${intent.actorId}:${intent.intentId}`;
    const payload = { intentId: intent.intentId,
      action: String(intent.candidate.parameters.action), reason: neutral };
    this.committed.set(eventId, { eventId, type: 'action_rejected',
      actorId: intent.actorId, simTime: this.world.simTime, payload });
    this.journal.push({ at: this.world.simTime, type: 'action_rejected',
      actorId: intent.actorId, payload });
    this.session.memories.get(intent.actorId)?.append({
      eventId, observerId: intent.actorId, occurredAt: this.world.simTime,
      observedAt: this.world.simTime, kind: 'action_rejected', source: 'engine',
      authority: 'engine', subjectIds: [intent.actorId], sourceEventIds: [eventId],
      payload });
  }

  private taskRow(taskId: string): { taskId: string; type: string; status: string;
    assigneeId: string } | undefined {
    return (this.states.tasks as { tasks: { taskId: string; type: string; status: string;
      assigneeId: string }[] }).tasks.find(entry => entry.taskId === taskId);
  }

  /**
   * One action can commit several receipts (a shortage observation and a later
   * delivery). Each gets its own claim, so the ledger absorbs the real ones and
   * an unrelated last event cannot hide the delivery.
   */
  private applyProjection(intent: ActionIntent, receiptIds: string[]): void {
    for (const receiptId of [...new Set([...receiptIds].reverse())]) {
      const claim = projectionOf(intent, receiptId);
      if (!claim) continue;
      intent.projections.push(claim);
      this.runProjection(intent, claim);
    }
  }

  private runProjection(intent: ActionIntent, claim: ProjectionClaim): boolean {
    if (claim.applied) return false;
    if (claim.kind === 'task') {
      // A receipt closes the EXACT task instance this action was queued for,
      // never the first task of the same type.
      if (!intent.taskType) return false;
      const task = this.taskRow(claim.id);
      if (!task || task.status !== 'accepted' || task.assigneeId !== intent.actorId) return false;
      if (task.type !== intent.taskType) return false;
      const result = this.dispatch('tasks', 'complete', intent.actorId,
        { taskId: task.taskId, receiptEventId: claim.receiptId });
      const after = this.taskRow(task.taskId);
      const closed = result.rejected.length === 0 && after?.status === 'done'
        && result.events.some(event => event.type === 'task_completed'
          && event.payload.taskId === task.taskId && event.payload.receipt === claim.receiptId);
      if (!closed) return false;
      claim.applied = true;
      claim.appliedAt = this.world.simTime;
      return true;
    }
    for (const projector of this.projectors) {
      let ok = false;
      try { ok = projector(claim, intent); } catch { ok = false; }
      if (ok) {
        claim.applied = true;
        claim.appliedAt = this.world.simTime;
        return true;
      }
    }
    return false;
  }

  /** Cancel/fail a queued action with zero late physical effect. */
  private finishIntent(intent: ActionIntent, status: ActionStatus, reason: string | null): void {
    intent.status = status;
    intent.failureReason = reason;
    intent.receiptIds = [];
    intent.settledAt = this.world.simTime;
    this.logIntent(intent);
  }

  private logIntent(intent: ActionIntent): void {
    this.workLog.push({ intentId: intent.intentId, actorId: intent.actorId,
      kind: String(intent.candidate.parameters.action), demandId: intent.demandId,
      startedAt: intent.startedAt,
      endsAt: intent.dueAt, settledAt: intent.settledAt ?? this.world.simTime,
      status: intent.status, eventIds: [...intent.receiptIds],
      failureReason: intent.failureReason });
    this.syncWorkView();
    this.pruneTerminalIntents();
  }

  private syncWorkView(): void {
    this.work.clear();
    for (const intent of this.intents.values()) {
      if (intent.status !== 'working') continue;
      this.work.set(intent.actorId, { intentId: intent.intentId, actorId: intent.actorId,
        kind: String(intent.candidate.parameters.action), commandId: intent.commandId,
        demandId: intent.demandId,
        candidate: intent.candidate, taskId: intent.taskId, commitmentId: intent.commitmentId,
        commitmentRevision: intent.commitmentRevision, generation: intent.generation,
        startedAt: intent.startedAt, endsAt: intent.dueAt });
    }
  }

  /** Terminal records are evidence, but the file cannot grow without bound. */
  private pruneTerminalIntents(keep = 200): void {
    const terminal = [...this.intents.values()].filter(intent => intent.status !== 'working')
      .sort((left, right) => (left.settledAt ?? 0) - (right.settledAt ?? 0)
        || left.intentId.localeCompare(right.intentId));
    for (const intent of terminal.slice(0, Math.max(0, terminal.length - keep))) {
      this.intents.delete(intent.intentId);
    }
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
      intents?: ActionIntent[];
      work?: WorkItem[];
      workLog?: R8Runtime['workLog'];
      duplicateDemands?: R8Runtime['duplicateDemands'];
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
    for (const intent of document.intents ?? []) {
      // Pre-R10 intents predate the demand identity; backfill it from the same
      // content hash so a restored queue still dedupes re-issued demands.
      if (!intent.demandId) intent.demandId = demandIdOf(intent);
      runtime.intents.set(intent.intentId, intent);
    }
    // R9 sidecars only stored the occupancy tuple. Migrate it into a real
    // intent so the resumed process settles from data, not from a closure.
    for (const item of document.work ?? []) {
      if (runtime.intents.has(item.intentId ?? item.commandId)) continue;
      const intentId = (item as WorkItem).intentId ?? item.commandId;
      const taskId = (item as WorkItem).taskId ?? null;
      const commitmentId = (item as WorkItem).commitmentId ?? null;
      const commitmentRevision = (item as WorkItem).commitmentRevision ?? null;
      runtime.intents.set(intentId, {
        intentId, commandId: item.commandId, actorId: item.actorId,
        candidateId: item.candidate.id,
        demandId: demandIdOf({ actorId: item.actorId, candidate: item.candidate,
          taskId, commitmentId, commitmentRevision }),
        candidate: item.candidate, inputSha256: null,
        generation: runtime.session.generationFor(item.actorId),
        taskId,
        taskType: workTaskType(item.candidate),
        commitmentId,
        commitmentRevision,
        startedAt: item.startedAt, dueAt: item.endsAt,
        requiredPlace: requiredPlaceOf(String(item.candidate.parameters.action ?? ''),
          item.candidate.parameters as Record<string, unknown>),
        startPlace: runtime.world.npcs[item.actorId]?.location ?? 'village',
        status: 'working', receiptIds: [], failureReason: null, projections: [],
        settledAt: null,
      });
    }
    runtime.syncWorkView();
    if (document.workLog) runtime.workLog.push(...document.workLog);
    if (document.duplicateDemands) runtime.duplicateDemands.push(...document.duplicateDemands);
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
      intents: [...this.intents.values()],
      // Derived view kept for readers of the R9 sidecar shape.
      work: [...this.work.values()],
      workLog: this.workLog,
      duplicateDemands: this.duplicateDemands.slice(-200),
      rejections: this.rejections.slice(-200),
    };
  }
}
