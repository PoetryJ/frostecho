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
import { buildPlanningRequest, referenceScorer, type PromiseRef, type PlanningView,
  type ScorerPort } from '../planning/candidates';
import { candidateCommand, UnsupportedActionError } from '../planning/commands';
import { FairScheduler, type TaskLease, type TaskOutcome } from '../scheduler-v2/scheduler';
import type { PromiseInstance } from './lifecycle';
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
  /** R2: promise instances; optional so pre-R2 saves load unchanged. */
  instances?: PromiseInstance[];
  /** R2: per-actor commit generations; optional for the same reason. */
  generations?: Record<string, number>;
  sequence: number;
  seed: string;
  /** R4: persistent player-input sequence (never reset per process). */
  inputSequence?: number;
  /** R4: first authoritative result per explicit input id (retry conflict check). */
  inputReceipts?: Record<string, InputReceipt>;
}

/** R4: one player input identity; only explicit retries key on it. */
export interface InputReceipt {
  kind: string;
  digest: string;
  result: unknown;
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
  /** R2: every promise creation is an instance; retries reuse it by commandId. */
  instances: PromiseInstance[] = [];
  /** R2: per-actor commit generation, bumped on cancel/timeout. */
  readonly generations = new Map<string, number>();
  sequence = 0;
  /**
   * R4: persistent player-input identity. The sequence survives save/restore,
   * so a new process never re-issues an old id (which would be a false retry).
   */
  inputSequence = 0;
  readonly inputReceipts: Record<string, InputReceipt> = {};
  readonly seed: string;
  readonly npcIds: string[];
  /** R3 (M): injectable scorer seam for real-model / async acceptance runs. */
  private readonly scorerProvider: () => ScorerPort;

  constructor(world: WorldV2, npcIds: string[], seed: string,
    scorerProvider: () => ScorerPort = referenceScorer) {
    this.world = world;
    this.npcIds = npcIds;
    this.seed = seed;
    this.scorerProvider = scorerProvider;
    for (const id of npcIds) this.memories.set(id, new MemoryStore());
  }

  generationFor(actorId: string): number {
    return this.generations.get(actorId) ?? 0;
  }

  /** R4: a persistent, cross-process-unique input id for one new operation. */
  nextInputId(kind: string, actorId?: string): string {
    this.inputSequence += 1;
    const suffix = actorId ? `-${actorId}` : '';
    return `in-${this.inputSequence}-${kind}${suffix}`;
  }

  /**
   * R4: replay an explicit retry only when the intent digest matches; a
   * different payload under the same id is an explicit conflict with zero
   * side effects. Returns null when the id was never seen (run it fresh).
   */
  private replayedInput(kind: string, inputId: string, digest: string): InputReceipt | null
    | 'conflict' {
    const seen = this.inputReceipts[inputId];
    if (!seen) return null;
    if (seen.kind !== kind || seen.digest !== digest) return 'conflict';
    return seen;
  }

  private rememberInput(kind: string, inputId: string, digest: string, result: unknown): void {
    if (this.inputReceipts[inputId]) return;
    this.inputReceipts[inputId] = { kind, digest, result };
  }

  /** Revoke every outstanding decision's right to submit for this actor. */
  bumpGeneration(actorId: string, _reason: string): number {
    const next = this.generationFor(actorId) + 1;
    this.generations.set(actorId, next);
    return next;
  }

  private promiseKeyOf(npcId: string): string {
    return `p-food-${npcId}`;
  }

  private liveInstance(npcId: string): PromiseInstance | undefined {
    const key = this.promiseKeyOf(npcId);
    return [...this.instances].reverse().find(instance => instance.promiseKey === key
      && instance.state === 'active');
  }

  static create(npcCount = 8, options: { days?: number; seed?: string; food?: number;
    scorerProvider?: () => ScorerPort } = {}): PlaySession {
    const npcIds = Array.from({ length: npcCount }, (_, index) => `npc_${String(index + 1).padStart(2, '0')}`);
    const seed = options.seed ?? `play-${npcCount}`;
    const world = createWorldV2({ npcIds, days: options.days ?? 4, rngSeed: seed,
      resources: options.food === undefined ? {} : { food: options.food } });
    return new PlaySession(world, npcIds, seed, options.scorerProvider);
  }

  static load(path: string, scorerProvider?: () => ScorerPort): PlaySession {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as SessionDocument;
    if (doc.schema !== 'frostecho.session/1') throw new Error('unexpected session schema');
    const session = new PlaySession(doc.world, Object.keys(doc.world.npcs), doc.seed, scorerProvider);
    for (const [id, payload] of Object.entries(doc.memories)) {
      session.memories.set(id, MemoryStore.fromJSON(payload));
    }
    Object.assign(session.outcomes, doc.outcomes);
    session.plans = doc.plans ?? [];
    session.instances = doc.instances ?? [];
    for (const [id, value] of Object.entries(doc.generations ?? {})) session.generations.set(id, value);
    session.sequence = doc.sequence ?? 0;
    session.inputSequence = doc.inputSequence ?? 0;
    Object.assign(session.inputReceipts, doc.inputReceipts ?? {});
    return session;
  }

  save(path: string): void {
    this.refreshPlans();
    const memories: Record<string, ReturnType<MemoryStore['toJSON']>> = {};
    for (const [id, store] of this.memories) memories[id] = store.toJSON();
    const doc: SessionDocument = { schema: 'frostecho.session/1', world: this.world,
      memories, outcomes: this.outcomes, plans: this.plans, instances: this.instances,
      generations: Object.fromEntries(this.generations), sequence: this.sequence, seed: this.seed,
      inputSequence: this.inputSequence, inputReceipts: this.inputReceipts };
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

  /**
   * Player asks `npcId` to leave food. Everyone in the party hears it.
   * Each creation is a new instance with a unique event id; retrying the same
   * player command (same commandId) returns the existing instance instead of
   * creating a second obligation.
   */
  playerPromise(npcId: string, commandId?: string): { promiseId: string; instanceId: string;
    heardBy: string[]; duplicate: boolean; inputId: string; conflict?: boolean;
    reason?: string } {
    if (!this.world.npcs[npcId]) throw new Error(`unknown npc ${npcId}`);
    const promiseId = this.promiseKeyOf(npcId);
    const digest = JSON.stringify({ kind: 'promise', npcId, promiseKey: promiseId });
    const inputId = commandId ?? this.nextInputId('promise', npcId);
    if (commandId) {
      const replay = this.replayedInput('promise', inputId, digest);
      if (replay === 'conflict') {
        return { promiseId, instanceId: '', heardBy: [], duplicate: false,
          inputId, conflict: true, reason: 'command_id_conflict' };
      }
      if (replay) {
        return { ...(replay.result as { promiseId: string; instanceId: string;
          heardBy: string[] }), duplicate: true, inputId };
      }
    }
    const instanceId = `pi-${randomUUID()}`;
    const eventId = `promise-${instanceId}`;
    const heardBy: string[] = [];
    for (const observer of this.npcIds) {
      if (!this.world.npcs[observer].alive) continue;
      this.ingest(observer, {
        eventId, occurredAt: this.world.simTime,
        observedAt: this.world.simTime, kind: 'promise_made',
        subjectIds: [npcId, 'player'],
        payload: { promiseId, fromId: npcId, toId: 'player', text: '给玩家留一份饭',
          instanceId },
        source: 'engine', authority: 'npc', speakerId: npcId,
        relatedRequestId: instanceId,
      });
      heardBy.push(observer);
    }
    const instance: PromiseInstance = { instanceId, promiseKey: promiseId,
      commandId: commandId ?? instanceId, createdAt: this.world.simTime, state: 'active' };
    this.instances.push(instance);
    const store = this.memories.get(npcId);
    const revision = store?.promises(npcId, this.world.simTime)
      .find(promise => promise.promiseId === promiseId)?.lastRevision ?? 1;
    this.plans.push({ planId: `plan-${instanceId}`, ownerId: npcId, promiseId,
      dependencyRevision: revision, state: 'planned' });
    this.refreshPlans();
    const result = { promiseId, instanceId, heardBy };
    this.rememberInput('promise', inputId, digest, result);
    return { ...result, duplicate: false, inputId };
  }

  /** Player cancels face to face with one NPC only. */
  playerCancel(npcId: string, instanceId?: string, commandId?: string): { promiseId: string;
    instanceId: string | null; onlyObserver: string; inputId: string; duplicate?: boolean;
    conflict?: boolean; reason?: string } {
    const promiseId = this.promiseKeyOf(npcId);
    const digest = JSON.stringify({ kind: 'cancel', npcId, instanceId: instanceId ?? 'live' });
    const inputId = commandId ?? this.nextInputId('cancel', npcId);
    if (commandId) {
      const replay = this.replayedInput('cancel', inputId, digest);
      if (replay === 'conflict') {
        return { promiseId, instanceId: null, onlyObserver: npcId, inputId,
          conflict: true, reason: 'command_id_conflict' };
      }
      if (replay) {
        return { ...(replay.result as { promiseId: string; instanceId: string | null;
          onlyObserver: string }), duplicate: true, inputId };
      }
    }
    const target = instanceId
      ? this.instances.find(instance => instance.instanceId === instanceId)
      : this.liveInstance(npcId);
    this.ingest(npcId, {
      eventId: `cancel-${randomUUID()}`, occurredAt: this.world.simTime,
      observedAt: this.world.simTime, kind: 'promise_retract',
      subjectIds: [npcId, 'player'],
      payload: { promiseId, byId: 'player', text: '不用留了',
        instanceId: target?.instanceId ?? null },
      source: 'player_statement', authority: 'player', speakerId: 'player',
      retracts: target ? [`promise-${target.instanceId}`] : [],
    });
    if (target) target.state = 'cancelled';
    // A cancellation revokes any in-flight decision built on the old promise.
    this.bumpGeneration(npcId, 'promise_cancelled');
    this.refreshPlans();
    const result = { promiseId, instanceId: target?.instanceId ?? null, onlyObserver: npcId };
    this.rememberInput('cancel', inputId, digest, result);
    return { ...result, inputId };
  }

  /** Player repeats the cancellation to another NPC. */
  playerTell(npcId: string, promisorId: string): { promiseId: string; observer: string } {
    const promiseId = this.promiseKeyOf(promisorId);
    const target = this.liveInstance(promisorId);
    this.ingest(npcId, {
      eventId: `relay-${randomUUID()}`, occurredAt: this.world.simTime,
      observedAt: this.world.simTime, kind: 'promise_retract',
      subjectIds: [npcId, 'player'],
      payload: { promiseId, byId: 'player', text: '玩家当面说已经取消了' },
      source: 'player_statement', authority: 'player', speakerId: 'player',
      retracts: target ? [`promise-${target.instanceId}`] : [],
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

  /**
   * R3 (P): player-side world command submission with explicit observation
   * rules. Actor-attributed commands (travel/withdraw/deliver) are seen by the
   * actor; a restock is personally witnessed only by NPCs standing at the
   * warehouse; road closures/reopenings are communal announcements seen by all
   * alive NPCs. Unobserved world changes never enter any NPC's memory.
   */
  submitWorldCommand(command: Command): { status: string; reason: string | null;
    eventIds: string[]; events: WorldEvent[]; observedBy: string[] } {
    const result = submitCommand(this.world, command);
    const observedBy: string[] = [];
    if (result.status === 'applied') {
      this.world = result.state;
      const actorId = 'actorId' in command ? command.actorId : undefined;
      const observers = actorId !== undefined
        ? [actorId]
        : command.type === 'restock'
          ? this.npcIds.filter(id => this.world.npcs[id]?.alive
            && this.world.npcs[id].location === 'warehouse')
          : this.npcIds.filter(id => this.world.npcs[id]?.alive);
      for (const observer of observers) {
        observedBy.push(observer);
        for (const worldEvent of result.events) {
          this.ingest(observer, {
            eventId: worldEvent.eventId, occurredAt: worldEvent.simTime,
            observedAt: this.world.simTime, kind: worldEvent.type,
            subjectIds: [observer, String(worldEvent.payload.place ?? 'world')],
            payload: { ...worldEvent.payload }, source: 'engine',
            authority: 'engine', speakerId: 'engine',
          });
        }
      }
    }
    return { status: result.status, reason: result.reason ?? null,
      eventIds: result.eventIds, events: result.events, observedBy };
  }

  /**
   * R3 (P): the player tells one NPC the warehouse was restocked. This is a
   * RUMOR (source player_statement): it raises re-verification priority but
   * never changes the actor's confirmed stock level.
   */
  tellRestock(npcId: string): { observer: string; rumor: true } {
    if (!this.world.npcs[npcId]) throw new Error(`unknown npc ${npcId}`);
    this.ingest(npcId, {
      eventId: `rumor-restock-${randomUUID()}`, occurredAt: this.world.simTime,
      observedAt: this.world.simTime, kind: 'restock_rumor',
      subjectIds: [npcId, 'warehouse'], payload: { text: '玩家说仓库已补货', place: 'warehouse' },
      source: 'player_statement', authority: 'player', speakerId: 'player',
    });
    return { observer: npcId, rumor: true };
  }

  /**
   * R4 (G4): a commitment event is a real communication record: sender,
   * recipient, content, revision and the supporting receipt. It is ingested
   * into every living NPC's memory (social events are public here); the
   * promisor additionally gets the relation-bearing records:
   *  - commitment_fulfilled  -> promise_kept  (trust +, only with the receipt)
   *  - commitment_withdrawn  -> promise_broken (trust -, grievance +)
   * Nothing else moves a relation.
   */
  ingestCommitmentEvent(event: {
    type: string; commitmentId: string; revision: number; at: number;
    actorId: string; payload: Record<string, unknown>;
  }): string[] {
    const observers = this.npcIds.filter(id => this.world.npcs[id]?.alive);
    const eventId = `cmt-${event.type}-${event.commitmentId}-${this.sequence++}`;
    const recipient = String(event.payload.toId ?? 'player');
    for (const observer of observers) {
      const base: Omit<MemoryRecordInput, 'observerId'> = {
        eventId, occurredAt: event.at, observedAt: this.world.simTime, kind: event.type,
        subjectIds: [event.actorId, recipient],
        payload: { ...event.payload, commitmentId: event.commitmentId,
          revision: event.revision },
        source: 'engine', authority: 'engine', speakerId: event.actorId,
        relatedRequestId: event.commitmentId,
      };
      this.ingest(observer, base);
      if (event.type === 'commitment_fulfilled' && observer === event.actorId) {
        const promiseId = String(event.payload.promiseId ?? event.commitmentId);
        const keptId = `${eventId}:kept`;
        // Distinct event id: the memory store dedupes by (observer, eventId).
        this.ingest(observer, { ...base, eventId: keptId, kind: 'promise_kept', payload: {
          promiseId, fromId: event.actorId, toId: recipient, text: '按约定送达',
          confirmation: { commandId: String(event.payload.receiptCommandId
            ?? event.commitmentId), status: 'applied', eventIds: [keptId],
            promiseId, beneficiaryId: recipient } } });
      }
      if (event.type === 'commitment_withdrawn') {
        this.ingest(observer, { ...base, eventId: `${eventId}:broken`,
          kind: 'promise_broken', payload: {
            promiseId: String(event.payload.promiseId ?? event.commitmentId),
            fromId: event.actorId, toId: recipient,
            reason: String(event.payload.reason ?? 'withdrawn') } });
      }
    }
    return observers;
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
    if (submitted.status === 'applied') {
      this.world = submitted.state;
      this.ingestEvents(actorId, submitted.events, commandId, candidate.id);
      const outcome: ExecutionOutcome = { status: 'applied', eventIds: submitted.eventIds,
        postStateVersion: submitted.postStateVersion, reason: submitted.reason };
      this.outcomes[commandId] = outcome;
      return outcome;
    }
    if (submitted.status === 'duplicate') {
      // Replay the FIRST authoritative receipt; a confirmed success is never
      // downgraded to unknown by a retry.
      const previous = this.outcomes[commandId];
      if (previous?.status === 'applied') return { ...previous, reason: 'duplicate' };
      const first = submitted.firstReceipt;
      const outcome: ExecutionOutcome = { status: 'applied',
        eventIds: first?.eventIds ?? submitted.eventIds,
        postStateVersion: first?.postStateVersion ?? submitted.postStateVersion,
        reason: 'duplicate_replay' };
      this.outcomes[commandId] = outcome;
      return outcome;
    }
    // Rejected: a same-id/different-content conflict must not overwrite an
    // already confirmed applied receipt in the ledger.
    const previous = this.outcomes[commandId];
    const outcome: ExecutionOutcome = { status: 'rejected',
      eventIds: submitted.eventIds, postStateVersion: submitted.postStateVersion,
      reason: submitted.reason };
    if (previous?.status === 'applied') return { ...outcome, reason: submitted.reason };
    this.outcomes[commandId] = outcome;
    return outcome;
  }

  /** Run one real decision for an actor through C's execution port. */
  async stepActor(actorId: string, lease?: TaskLease, expectedGeneration?: number): Promise<StepDecision> {
    const npc = this.world.npcs[actorId];
    if (!npc?.alive) return { actorId, status: 'skipped', selectedId: null, commandId: null,
      executionStatus: null, eventIds: [], postStateVersion: null, executed: false,
      reason: 'not alive', promiseStatuses: [] };
    // A step accepted BEFORE a cancel must not run afterwards: the generation
    // captured when the player input was accepted is the commit right.
    if (expectedGeneration !== undefined && this.generationFor(actorId) !== expectedGeneration) {
      return { actorId, status: 'cancelled', selectedId: null, commandId: null,
        executionStatus: null, eventIds: [], postStateVersion: null, executed: false,
        reason: 'generation_changed_before_start', promiseStatuses: [] };
    }
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
    const generation = this.generationFor(actorId);
    const execution: ExecutionPort = {
      commandId: result => `${actorId}-${this.world.version}-${result.selectedId ?? 'none'}`,
      submit: async (commandId, result, submittedRequest) => {
        const candidate = request.candidates.find(entry => entry.id === result.selectedId);
        if (!candidate) return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
          reason: 'unknown_selected_candidate' };
        // R2 commit-time identity check. Everything below is synchronous: no
        // await may separate these reads from the authoritative submission.
        if (lease && !lease.active) {
          return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
            reason: `lease_revoked:${lease.revokedReason ?? 'expired'}` };
        }
        if (this.generationFor(actorId) !== generation) {
          return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
            reason: 'stale_generation' };
        }
        if (this.world.version !== submittedRequest.stateVersion) {
          return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
            reason: 'stale_state' };
        }
        if (store.snapshotHash() !== submittedRequest.memorySnapshotHash) {
          return { status: 'rejected', eventIds: [], postStateVersion: this.world.version,
            reason: 'stale_memory' };
        }
        return this.executeCandidate(actorId, candidate, commandId);
      },
      query: async commandId => this.outcomes[commandId] ?? { status: 'unknown', eventIds: [],
        postStateVersion: null, reason: 'not recorded' },
    };

    const outcome = await runChoice(request, this.scorerProvider(), this.bindingFor(request), {
      execution,
      // Fresh reads, never the captured query values: a cancel between request
      // build and submission must invalidate this decision.
      currentSnapshot: () => ({ stateVersion: this.world.version,
        memorySnapshotHash: store.snapshotHash(),
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

  /**
   * R4 (G2): one CLI step with a revocable lease and a bounded timeout. When
   * the scorer never returns, the lease is revoked and an explicit
   * `timed_out` terminal state is returned; a late result then hits the
   * synchronous commit checks and executes nothing.
   */
  async stepActorBounded(actorId: string, expectedGeneration: number,
    timeoutMs = 10_000): Promise<{ decision: StepDecision; outcome: TaskOutcome<StepDecision> }> {
    const scheduler = new FairScheduler();
    scheduler.add<StepDecision>({ actorId, taskId: `cli-step-${actorId}-${this.sequence++}`,
      stateVersion: this.world.version, run: async lease => {
        const decision = await this.stepActor(actorId, lease, expectedGeneration);
        // A revoked lease must surface as a timeout terminal state, never as a
        // successful action: the commit section already refused to submit.
        if (!lease.active) throw new Error(`lease_revoked:${lease.revokedReason ?? 'expired'}`);
        return decision;
      } });
    const outcomes = await scheduler.run<StepDecision>({ timeoutMs, checkVersion: false,
      currentVersion: () => this.world.version });
    const outcome = outcomes[0];
    if (outcome && outcome.status === 'completed') return { decision: outcome.value, outcome };
    const status = outcome?.status ?? 'failed';
    return {
      decision: { actorId, status: status === 'timed_out' ? 'timed_out' : status,
        selectedId: null, commandId: null, executionStatus: null, eventIds: [],
        postStateVersion: null, executed: false,
        reason: status === 'timed_out' ? 'step_timeout_revoked' : `step_${status}`,
        promiseStatuses: [] },
      outcome: outcome ?? { taskId: `cli-step-${actorId}`, actorId, status: 'failed',
        error: 'no outcome' },
    };
  }

  /**
   * Round-robin decisions for every actor; one in flight per actor. Returns
   * both the decisions and the REAL scheduler outcomes (completed/timed_out/
   * failed/cancelled/late), so callers never silently drop work.
   */
  async stepAll(options: { expectedGenerations?: Record<string, number> } = {}):
    Promise<{ decisions: StepDecision[]; outcomes: TaskOutcome<StepDecision>[] }> {
    const scheduler = new FairScheduler();
    const results = new Map<string, StepDecision>();
    for (const id of this.npcIds) {
      if (!this.world.npcs[id]?.alive) continue;
      const expected = options.expectedGenerations?.[id];
      scheduler.add({ actorId: id, taskId: `step-${id}-${this.sequence++}`,
        stateVersion: this.world.version, run: async lease => {
          const decision = await this.stepActor(id, lease, expected);
          results.set(id, decision);
          return decision;
        } });
    }
    // Each step builds its request fresh inside run(), so the enqueue-time
    // version is not a staleness signal; commit-time checks enforce it.
    const outcomes = await scheduler.run<StepDecision>({ timeoutMs: 30_000, checkVersion: false,
      currentVersion: () => this.world.version });
    return { decisions: [...results.values()], outcomes };
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
