/**
 * Playable session (G). This is the real entry: player commands change the
 * authoritative world through C.runChoice -> E.candidates -> F.submitCommand,
 * and only confirmed events are ingested into D's memory.
 *
 * Frozen by the owner as the single application path for sprint R1. The
 * automatic fixture stays in scripts/play-fixture.ts and is not this entry.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryStore, invalidateDependentPlans, type MemoryRecordInput,
  type PromiseView } from '../memory/store';
import { runChoice, type ExecutionOutcome, type ExecutionPort, type ScorerBinding } from '../decision/runtime';
import { makeChoiceResult, type Candidate, type ChoiceRequest } from '../decision/contracts';
import { buildPlanningRequest, referenceScorer, type PromiseRef, type PlanningView } from '../planning/candidates';
import { candidateCommand, UnsupportedActionError } from '../planning/commands';
import { FairScheduler } from '../scheduler-v2/scheduler';
import {
  createWorldV2,
  submitCommand,
  viewOf,
  MINUTES_PER_DAY,
  type Command,
  type WorldEvent,
  type WorldV2,
} from '../survival/world-v2';

export interface PlayerPlan {
  planId: string;
  ownerId: string;
  promiseId: string;
  dependencyRevision: number;
  state: 'planned' | 'invalidated';
}

export interface SessionDocument {
  schema: 'frostecho.session/1';
  world: WorldV2;
  memories: Record<string, ReturnType<MemoryStore['toJSON']>>;
  outcomes: Record<string, ExecutionOutcome>;
  plans: PlayerPlan[];
  sequence: number;
  seed: string;
}

export interface StepDecision {
  actorId: string;
  status: string;
  selectedId: string | null;
  commandId: string | null;
  executionStatus: string | null;
  eventIds: string[];
  postStateVersion: number | null;
  executed: boolean;
  reason: string;
  promiseStatuses: { promiseId: string; status: string }[];
}

export class PlaySession {
  world: WorldV2;
  readonly memories = new Map<string, MemoryStore>();
  readonly outcomes: Record<string, ExecutionOutcome> = {};
  plans: PlayerPlan[] = [];
  sequence = 0;
  readonly seed: string;
  readonly npcIds: string[];

  constructor(world: WorldV2, npcIds: string[], seed: string) {
    this.world = world;
    this.npcIds = npcIds;
    this.seed = seed;
    for (const id of npcIds) this.memories.set(id, new MemoryStore());
  }

  static create(npcCount = 8, options: { days?: number; seed?: string; food?: number } = {}): PlaySession {
    const npcIds = Array.from({ length: npcCount }, (_, index) => `npc_${String(index + 1).padStart(2, '0')}`);
    const seed = options.seed ?? `play-${npcCount}`;
    const world = createWorldV2({ npcIds, days: options.days ?? 4, rngSeed: seed,
      resources: options.food === undefined ? {} : { food: options.food } });
    return new PlaySession(world, npcIds, seed);
  }

  static load(path: string): PlaySession {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as SessionDocument;
    if (doc.schema !== 'frostecho.session/1') throw new Error('unexpected session schema');
    const session = new PlaySession(doc.world, Object.keys(doc.world.npcs), doc.seed);
    for (const [id, payload] of Object.entries(doc.memories)) {
      session.memories.set(id, MemoryStore.fromJSON(payload));
    }
    Object.assign(session.outcomes, doc.outcomes);
    session.plans = doc.plans ?? [];
    session.sequence = doc.sequence ?? 0;
    return session;
  }

  save(path: string): void {
    this.refreshPlans();
    const memories: Record<string, ReturnType<MemoryStore['toJSON']>> = {};
    for (const [id, store] of this.memories) memories[id] = store.toJSON();
    const doc: SessionDocument = { schema: 'frostecho.session/1', world: this.world,
      memories, outcomes: this.outcomes, plans: this.plans, sequence: this.sequence, seed: this.seed };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }

  /** Recompute plan validity with the same formal API used by E. */
  refreshPlans(): void {
    for (const plan of this.plans) {
      const store = this.memories.get(plan.ownerId);
      if (!store) continue;
      const view = store.promises(plan.ownerId, this.world.simTime)
        .find(promise => promise.promiseId === plan.promiseId);
      if (!view) continue;
      const updated = invalidateDependentPlans([plan], view.promiseId, view.status, view.lastRevision)[0];
      plan.state = updated.state;
      plan.dependencyRevision = Math.max(plan.dependencyRevision, view.lastRevision);
    }
  }

  knowledge(): Record<string, { promises: PromiseView[]; relation: unknown }> {
    this.refreshPlans();
    const out: Record<string, { promises: PromiseView[]; relation: unknown }> = {};
    for (const [id, store] of this.memories) {
      const promises = store.promises(id, this.world.simTime);
      out[id] = { promises,
        relation: store.relation(id, id, 'player') ?? null };
    }
    return out;
  }

  /** Player asks `npcId` to leave food. Everyone in the party hears it. */
  playerPromise(npcId: string): { promiseId: string; heardBy: string[] } {
    if (!this.world.npcs[npcId]) throw new Error(`unknown npc ${npcId}`);
    const promiseId = `p-food-${npcId}`;
    const heardBy: string[] = [];
    for (const observer of this.npcIds) {
      if (!this.world.npcs[observer].alive) continue;
      this.ingest(observer, {
        eventId: `promise-${promiseId}`, occurredAt: this.world.simTime,
        observedAt: this.world.simTime, kind: 'promise_made',
        subjectIds: [npcId, 'player'],
        payload: { promiseId, fromId: npcId, toId: 'player', text: '给玩家留一份饭' },
        source: 'engine', authority: 'npc', speakerId: npcId,
        relatedRequestId: promiseId,
      });
      heardBy.push(observer);
    }
    this.plans.push({ planId: `plan-${npcId}-${promiseId}`, ownerId: npcId, promiseId,
      dependencyRevision: 1, state: 'planned' });
    this.refreshPlans();
    return { promiseId, heardBy };
  }

  /** Player cancels face to face with one NPC only. */
  playerCancel(npcId: string): { promiseId: string; onlyObserver: string } {
    const promiseId = `p-food-${npcId}`;
    this.ingest(npcId, {
      eventId: `cancel-${promiseId}-${this.sequence++}`, occurredAt: this.world.simTime,
      observedAt: this.world.simTime, kind: 'promise_retract',
      subjectIds: [npcId, 'player'],
      payload: { promiseId, byId: 'player', text: '不用留了' },
      source: 'player_statement', authority: 'player', speakerId: 'player',
      retracts: [`promise-${promiseId}`],
    });
    this.refreshPlans();
    return { promiseId, onlyObserver: npcId };
  }

  /** Player repeats the cancellation to another NPC. */
  playerTell(npcId: string, promisorId: string): { promiseId: string; observer: string } {
    const promiseId = `p-food-${promisorId}`;
    this.ingest(npcId, {
      eventId: `relay-${promiseId}-${this.sequence++}`, occurredAt: this.world.simTime,
      observedAt: this.world.simTime, kind: 'promise_retract',
      subjectIds: [npcId, 'player'],
      payload: { promiseId, byId: 'player', text: '玩家当面说已经取消了' },
      source: 'player_statement', authority: 'player', speakerId: 'player',
      retracts: [`promise-${promiseId}`],
    });
    this.refreshPlans();
    return { promiseId, observer: npcId };
  }

  advance(minutes: number): { status: string; simTime: number; eventIds: string[] } {
    const result = submitCommand(this.world, {
      commandId: `player-advance-${this.sequence++}`, type: 'advance', minutes,
    });
    this.world = result.state;
    return { status: result.status, simTime: this.world.simTime, eventIds: result.eventIds };
  }

  private ingest(observerId: string, input: Omit<MemoryRecordInput, 'observerId'>): void {
    const store = this.memories.get(observerId);
    if (!store) throw new Error(`no memory for ${observerId}`);
    store.append({ ...input, observerId });
  }

  private bindingFor(request: ChoiceRequest): ScorerBinding {
    return { model: 'reference-utility/1', head: 'utility', adapter: 'none',
      tokenizer: 'none', renderer: 'jev04/planning', policyVersion: 'policy/1',
      task: request.task, k: request.candidates.length,
      memoryPolicyVersion: request.memoryPolicyVersion ?? 'memory-policy/1',
      supportedK: [request.candidates.length] };
  }

  /**
   * The single command execution path: candidate -> command -> authority ->
   * trusted memory ingest. A rejected command never writes promise_kept.
   */
  executeCandidate(actorId: string, candidate: Candidate, commandId: string): ExecutionOutcome {
    let command: Command | null;
    try {
      command = candidateCommand(candidate, actorId, commandId);
    } catch (error) {
      if (error instanceof UnsupportedActionError) {
        return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
          reason: error.code };
      }
      throw error;
    }
    if (command === null) {
      return { status: 'applied', eventIds: [], postStateVersion: this.world.version, reason: 'wait' };
    }
    const submitted = submitCommand(this.world, command);
    this.world = submitted.state;
    if (submitted.status === 'applied') {
      this.ingestEvents(actorId, submitted.events, commandId, candidate.id);
    }
    const outcome: ExecutionOutcome = {
      status: submitted.status === 'applied' ? 'applied'
        : submitted.status === 'duplicate' ? 'unknown' : 'rejected',
      eventIds: submitted.eventIds,
      postStateVersion: submitted.postStateVersion,
      reason: submitted.reason,
    };
    this.outcomes[commandId] = outcome;
    return outcome;
  }

  /** Run one real decision for an actor through C's execution port. */
  async stepActor(actorId: string): Promise<StepDecision> {
    const npc = this.world.npcs[actorId];
    if (!npc?.alive) return { actorId, status: 'skipped', selectedId: null, commandId: null,
      executionStatus: null, eventIds: [], postStateVersion: null, executed: false,
      reason: 'not alive', promiseStatuses: [] };
    const store = this.memories.get(actorId)!;
    const view = viewOf(this.world);
    const query = store.query({ observerId: actorId, now: this.world.simTime, topK: 8 });
    const promises: PromiseRef[] = query.promises
      .filter(promise => promise.fromId === actorId)
      .map(promise => ({ promiseId: promise.promiseId, toId: promise.toId,
        status: promise.status, revision: promise.lastRevision }));
    const planningView: PlanningView = {
      actorId,
      npcs: view.npcs.map(entry => ({ id: entry.id, hunger: entry.hunger,
        stamina: entry.stamina, health: entry.health, san: entry.san, alive: entry.alive })),
      resources: view.resources, furnace: view.furnace, weather: view.weather,
    };
    const request = buildPlanningRequest({ view: planningView, promises,
      memoryFacts: query.items.map(item => ({ eventId: item.recordId, observerId: actorId,
        simTime: item.observedAt, subjectIds: item.subjectIds, kind: item.kind,
        payload: item.payload, source: item.source })),
      stateVersion: this.world.version, requestId: `${actorId}-d${this.world.day}-${this.sequence++}`,
      memorySnapshotHash: query.memorySnapshotHash,
      memoryPolicyVersion: query.memoryPolicyVersion });

    this.plans = invalidateDependentPlans(this.plans, promises[0]?.promiseId ?? '', 
      (promises[0]?.status ?? 'active') as never, promises[0]?.revision ?? 0);

    let decisions: StepDecision['promiseStatuses'] = [];
    const execution: ExecutionPort = {
      commandId: result => `${actorId}-${this.world.version}-${result.selectedId ?? 'none'}`,
      submit: async (commandId, result) => {
        const candidate = request.candidates.find(entry => entry.id === result.selectedId);
        if (!candidate) return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
          reason: 'unknown_selected_candidate' };
        return this.executeCandidate(actorId, candidate, commandId);
      },
      query: async commandId => this.outcomes[commandId] ?? { status: 'unknown', eventIds: [],
        postStateVersion: null, reason: 'not recorded' },
    };

    const outcome = await runChoice(request, referenceScorer(), this.bindingFor(request), {
      execution,
      currentSnapshot: () => ({ stateVersion: this.world.version,
        memorySnapshotHash: query.memorySnapshotHash,
        memoryPolicyVersion: query.memoryPolicyVersion }),
    });
    const after = store.promises(actorId, this.world.simTime);
    decisions = after.map(promise => ({ promiseId: promise.promiseId, status: promise.status }));
    return { actorId, status: outcome.audit.phase, selectedId: outcome.result.selectedId,
      commandId: outcome.audit.commandId,
      executionStatus: outcome.audit.executionStatus,
      eventIds: outcome.audit.eventIds,
      postStateVersion: outcome.audit.postStateVersion,
      executed: outcome.audit.executed, reason: outcome.result.reason, promiseStatuses: decisions };
  }

  /** Events this actor caused are ingested as trusted engine events. */
  private ingestEvents(actorId: string, events: WorldEvent[], commandId: string,
    selectedId: string): void {
    for (const event of events) {
      const payload = { ...event.payload } as Record<string, unknown>;
      const base: Omit<MemoryRecordInput, 'observerId'> = {
        eventId: event.eventId, occurredAt: event.simTime, observedAt: event.simTime,
        kind: event.type, subjectIds: [actorId, String(payload.forId ?? 'player')],
        payload, source: 'engine', authority: 'engine', speakerId: 'engine',
      };
      if (event.type === 'food_reserved' && selectedId.startsWith('c-help-')) {
        const promiseId = selectedId.slice('c-help-'.length);
        const beneficiaryId = String(payload.forId ?? 'player');
        this.ingest(actorId, { ...base, kind: 'promise_kept',
          payload: { promiseId, fromId: actorId, toId: beneficiaryId,
            text: 'reserved food for player',
            confirmation: { commandId, status: 'applied', eventIds: events.map(entry => entry.eventId),
              promiseId, beneficiaryId } } });
      } else {
        this.ingest(actorId, base);
      }
    }
  }

  /** Round-robin decisions for every actor; one in flight per actor. */
  async stepAll(): Promise<StepDecision[]> {
    const scheduler = new FairScheduler();
    const results = new Map<string, StepDecision>();
    for (const id of this.npcIds) {
      if (!this.world.npcs[id]?.alive) continue;
      scheduler.add({ actorId: id, taskId: `step-${id}-${this.sequence++}`,
        stateVersion: this.world.version, run: async () => {
          const decision = await this.stepActor(id);
          results.set(id, decision);
          return decision;
        } });
    }
    await scheduler.run({ timeoutMs: 30_000, currentVersion: () => this.world.version });
    return [...results.values()];
  }

  observe(): Record<string, unknown> {
    const view = viewOf(this.world);
    return { day: view.day, simTime: view.simTime, hoursElapsed: view.simTime / 60,
      weather: view.weather, resources: view.resources, furnace: view.furnace, npcs: view.npcs };
  }
}

export function defaultStatePath(root = process.cwd()): string {
  return join(root, 'artifacts/sprint-r1/play/session.json');
}

export function commandIdFor(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export { MINUTES_PER_DAY, makeChoiceResult };
