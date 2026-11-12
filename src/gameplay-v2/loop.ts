/**
 * Four-day playable loop (P, R2/R3). Composes the frozen PlaySession authority
 * path (candidate -> authoritative command -> events -> memory) with a
 * deterministic reference task policy. Mode is always reported as
 * `reference-rules/1`; this is not model understanding.
 *
 * R3 delivery run: a `deliver-meal` task drives the warehouse -> kitchen state
 * machine. The actor's warehouse belief is derived ONLY from events its own
 * memory holds (own withdrawals / own out_of_stock sightings / restocks it
 * personally witnessed / unverified player rumors), never from world truth.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PlaySession } from '../application-v2/session';
import type { ScorerPort } from '../planning/candidates';
import { TaskBoard, type GameplayTask, type GameplayTaskKind } from './tasks';
import { buildGameplayCandidates, chooseReference, deriveDeliveryPhase,
  type DeliveryView, type GameplayStepRecord } from './decisions';
import { BUILDINGS, findPath, MAPS, cellKey, type Cell } from '../spatial-v2/map';
import { CommitmentBoard, type Commitment, type CommitmentEvent,
  type CommitmentTerms } from './commitments';
import { initialResponse, resumeReady, shouldWithdraw, survivalProposal } from './negotiation';
import { ExperienceStore, type FoldableEvent } from '../memory/experience';
import type { Command, WorldEvent } from '../survival/world-v2';

export interface GameplayStepResult {
  records: GameplayStepRecord[];
  executed: number;
  mode: 'reference-rules/1';
}

export interface GameplayLoopOptions {
  /**
   * R3 (E): when false the loop never learns from past stock events — the
   * delivery policy sees a null stock level forever and must re-verify by
   * acting. This is the reference-only arm of the paired comparison.
   */
  useExperience?: boolean;
  /** Preloaded experience notes (restore path). */
  experience?: ExperienceStore;
  /** R4: preloaded commitments (restore path). */
  commitments?: CommitmentBoard;
}

const KIND_TO_TASK: Record<string, GameplayTaskKind> = {
  'gather-food': 'gather-food', 'gather-wood': 'gather-wood',
  heating: 'heating', 'leave-food': 'leave-food', 'deliver-meal': 'deliver-meal',
};

/** Minutes of sim time one outdoor tile costs (documented reference constant). */
export const MINUTES_PER_TILE = 2;

/** The grid cell an actor currently stands on (door of its building by default). */
export function actorCell(world: PlaySession['world'], actorId: string): Cell {
  const existing = world.spatial?.positions[actorId];
  if (existing) return existing;
  const npc = world.npcs[actorId];
  const building = BUILDINGS.find(entry => entry.id === npc?.location);
  return building ? { ...building.door } : { x: 25, y: 8 };
}

/**
 * Derives the actor's warehouse belief from its OWN memory records, newest
 * first: a witnessed/own out_of_stock pins the level at 0, a stock_withdrawn /
 * stock_restocked payload carries the authoritative level, and an unconfirmed
 * player rumor only raises re-verification priority.
 */
export function warehouseBelief(session: PlaySession, actorId: string):
    { level: number | null; rumor: boolean; evidenceEventIds: string[] } {
  const store = session.memories.get(actorId);
  if (!store) return { level: null, rumor: false, evidenceEventIds: [] };
  // Recompute from the raw record array: array order IS the personal
  // observation order, which is the honest "later evidence" clock. The scored
  // query is for decisions, not for establishing event order.
  const records = store.toJSON().records
    .filter(record => record.observerId === actorId);
  const stockKinds = new Set(['stock_withdrawn', 'out_of_stock', 'stock_restocked',
    'stock_deposited']);
  let level: number | null = null;
  let rumor = false;
  let sawDirectFromNewer = false;
  const evidence: string[] = [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind === 'restock_rumor') {
      // A rumor is a hypothesis: it stays live only while no strictly later
      // personal observation about the same subject exists.
      if (!sawDirectFromNewer) rumor = true;
      evidence.push(record.sourceEventIds[0] ?? record.recordId);
      continue;
    }
    if (!stockKinds.has(record.kind)) continue;
    sawDirectFromNewer = true;
    if (level === null) {
      const payload = record.payload as Record<string, unknown>;
      if (typeof payload.remaining === 'number') level = payload.remaining;
      else if (typeof payload.level === 'number') level = payload.level;
      else if (record.kind === 'out_of_stock') level = Number(payload.available ?? 0);
      else if (record.kind === 'stock_restocked') level = Number(payload.total ?? 0);
      else if (record.kind === 'stock_deposited') level = Number(payload.total ?? 0);
    }
    evidence.push(record.sourceEventIds[0] ?? record.recordId);
  }
  return { level, rumor, evidenceEventIds: evidence };
}

export class GameplayLoop {
  readonly useExperience: boolean;
  readonly experience: ExperienceStore;
  readonly commitments: CommitmentBoard;

  constructor(readonly session: PlaySession,
    readonly board: TaskBoard = new TaskBoard(),
    options: GameplayLoopOptions = {}) {
    this.useExperience = options.useExperience !== false;
    this.experience = options.experience ?? ExperienceStore.empty();
    this.commitments = options.commitments ?? CommitmentBoard.empty();
  }

  static create(npcCount = 8, options: { days?: number; seed?: string; food?: number } = {},
    loopOptions: GameplayLoopOptions = {}):
    GameplayLoop {
    return new GameplayLoop(PlaySession.create(npcCount, options),
      new TaskBoard(), loopOptions);
  }

  /** Assign one task; `leave-food` also creates a promise instance for that NPC. */
  assign(actorId: string, kind: GameplayTaskKind): GameplayTask {
    if (!KIND_TO_TASK[kind]) throw new Error(`unknown task kind ${kind}`);
    const existing = this.board.activeFor(actorId).find(task => task.kind === kind);
    if (existing) return existing;
    let promiseId: string | undefined;
    if (kind === 'leave-food') {
      promiseId = this.session.playerPromise(actorId).promiseId;
    }
    return this.board.assign(actorId, kind,
      { promiseId, now: this.session.world.simTime });
  }

  /**
   * R4 (G4): the playable request path. The request only PROPOSES; the NPC's
   * reference policy answers immediately (accept / decline / counter), and a
   * task is linked only when the commitment is actually active.
   */
  requestCommitment(actorId: string, goal: string,
    options: { deadline?: number | null; conditions?: string[]; inputId?: string } = {}):
    CommitmentRequestResult {
    const world = this.session.world;
    const npc = world.npcs[actorId];
    if (!npc) throw new Error(`unknown npc ${actorId}`);
    const at = world.simTime;
    const requested = this.commitments.request({ promisorId: actorId,
      beneficiaryId: 'player', goal, conditions: options.conditions ?? ['warehouse-supply'],
      deadline: options.deadline ?? null, at, inputId: options.inputId });
    if (requested.conflict) {
      return { commitment: requested.commitment, task: null,
        response: { verdict: 'decline', reason: 'command_id_conflict' },
        events: [requested.event], conflict: true };
    }
    if (requested.duplicate) {
      const live = this.commitments.find(requested.commitment.commitmentId);
      return { commitment: live ?? requested.commitment, task: null,
        response: { verdict: 'accept', reason: 'duplicate_replay' },
        events: [requested.event], duplicate: true };
    }
    const live = this.commitments.find(requested.commitment.commitmentId)!;
    const answer = requested.reason === 'already-committed'
      ? { verdict: 'decline' as const, reason: 'already-committed' }
      : initialResponse(npc, this.commitments.activeFor(actorId)
        .filter(row => row.commitmentId !== live.commitmentId));
    const responded = this.commitments.respond(live.commitmentId, answer.verdict,
      { at, reason: answer.reason, terms: 'terms' in answer ? answer.terms : undefined,
        inputId: options.inputId ? `${options.inputId}:respond` : undefined });
    this.session.ingestCommitmentEvent(requested.event);
    this.session.ingestCommitmentEvent(responded.event);
    let task: GameplayTask | null = null;
    if (responded.commitment.status === 'active') {
      task = this.board.assign(actorId, 'deliver-meal', { now: at,
        inputId: options.inputId ? `${options.inputId}:task` : undefined });
      live.taskId = task.taskId;
    }
    return { commitment: this.commitments.find(live.commitmentId)!, response: answer,
      task, events: [requested.event, responded.event] };
  }

  /** The beneficiary answers the newest open change proposal. */
  respondChange(commitmentId: string, verdict: 'accept' | 'reject',
    options: { inputId?: string; reason?: string } = {}):
    { commitment: Commitment; event: CommitmentEvent } {
    const at = this.session.world.simTime;
    const open = this.commitments.find(commitmentId)?.changes
      .filter(change => change.status === 'open').at(-1);
    if (!open) throw new Error(`no open change proposal for ${commitmentId}`);
    const result = this.commitments.respondChange(commitmentId, open.changeId, verdict,
      { at, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    return { commitment: result.commitment, event: result.event };
  }

  /** The promisor resumes after the agreed condition holds (explicit only). */
  resumeCommitment(commitmentId: string, options: { inputId?: string;
    reason?: string } = {}): { commitment: Commitment; event: CommitmentEvent } {
    const result = this.commitments.resume(commitmentId,
      { at: this.session.world.simTime, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    return { commitment: result.commitment, event: result.event };
  }

  /** The beneficiary cancels; every later attempt stops (independent terminal). */
  cancelCommitment(commitmentId: string, options: { inputId?: string;
    reason?: string } = {}): { commitment: Commitment; event: CommitmentEvent } {
    const result = this.commitments.cancel(commitmentId,
      { at: this.session.world.simTime, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    const task = result.commitment.taskId ? this.board.find(result.commitment.taskId) : undefined;
    if (task && task.status === 'active') this.board.cancel(task.taskId);
    return { commitment: result.commitment, event: result.event };
  }

  /** The promisor exits explicitly; the relation moves on this evidence. */
  withdrawCommitment(commitmentId: string, options: { inputId?: string;
    reason?: string } = {}): { commitment: Commitment; event: CommitmentEvent } {
    const result = this.commitments.withdraw(commitmentId,
      { at: this.session.world.simTime, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    return { commitment: result.commitment, event: result.event };
  }

  commitmentStatus(): { commitments: Commitment[]; tasks: unknown[] } {
    return { commitments: this.commitments.all(), tasks: this.board.toJSON() };
  }

  /** R4: delivery work only happens under an active commitment (or fixture mode). */
  private deliveryAllowed(actorId: string): boolean {
    const rows = this.commitments.activeFor(actorId)
      .filter(row => row.goal === 'deliver-meal');
    if (rows.length === 0) return true; // legacy assign path stays a fixture
    return rows.some(row => row.status === 'active');
  }

  /** R4: has this actor personally seen an empty warehouse (belief, not truth)? */
  private witnessedEmptyWarehouse(actorId: string): boolean {
    if (this.experience.believesWarehouseEmpty(actorId)) return true;
    return warehouseBelief(this.session, actorId).level === 0;
  }

  /** R4: survival proposals, agreed resumes and explicit exits, once per step. */
  private advanceCommitments(actorId: string): void {
    const world = this.session.world;
    const npc = world.npcs[actorId];
    if (!npc?.alive) return;
    const at = world.simTime;
    for (const commitment of this.commitments.activeFor(actorId)) {
      if (commitment.status === 'active') {
        const proposal = survivalProposal(npc, commitment);
        if (proposal) {
          const result = this.commitments.proposeChange(commitment.commitmentId, {
            kind: proposal.kind, reason: proposal.reason, terms: proposal.terms, at });
          this.session.ingestCommitmentEvent(result.event);
        } else if (commitment.goal === 'deliver-meal'
          && this.witnessedEmptyWarehouse(actorId)
          // Propose once: an accepted alt-source is already part of the
          // revision, and an open one is still waiting for the answer.
          && !commitment.changes.some(change => change.kind === 'alt-source'
            && change.status !== 'rejected')) {
          // R4 (G4 story A): a personally-witnessed shortage is SAID, not
          // silently worked around. The promise stays; the change waits for an
          // explicit answer.
          const result = this.commitments.proposeChange(commitment.commitmentId, {
            kind: 'alt-source', reason: 'warehouse-empty',
            terms: { source: 'gather', reason: '仓库缺货，我改从村里采集再送来' },
            at, evidenceEventIds: [] });
          this.session.ingestCommitmentEvent(result.event);
        }
      } else if (commitment.status === 'suspended') {
        if (resumeReady(npc, commitment)) {
          const result = this.commitments.resume(commitment.commitmentId,
            { at, reason: 'resume-condition-met' });
          this.session.ingestCommitmentEvent(result.event);
        }
      } else if (commitment.status === 'pending-change') {
        if (shouldWithdraw(npc, commitment)) {
          const result = this.commitments.withdraw(commitment.commitmentId,
            { at, reason: 'survival-exit' });
          this.session.ingestCommitmentEvent(result.event);
        }
      }
    }
  }

  /** Cancel a task. A cancelled leave-food task also retracts its promise. */
  cancelTask(taskId: string): boolean {
    const task = this.board.find(taskId);
    if (!task) return false;
    if (!this.board.cancel(taskId)) return false;
    if (task.kind === 'leave-food') this.session.playerCancel(task.actorId);
    return true;
  }

  /** Delivery phase inputs for one actor, derived from observable state only. */
  deliveryView(actorId: string): DeliveryView {
    const world = this.session.world;
    const npc = world.npcs[actorId];
    const from = actorCell(world, actorId);
    const closed = new Set(world.spatial?.closedCells ?? []);
    const belief = warehouseBelief(this.session, actorId);
    // A delivery route must END on the door cell: the legacy goal-correction
    // would otherwise stop next to a sealed door and never enter the building.
    const routeTo = (buildingId: string, at: boolean): Array<{ x: number; y: number }> | null => {
      if (at) return [];
      const door = BUILDINGS.find(building => building.id === buildingId)!.door;
      const result = findPath(MAPS.village, from, door, closed);
      if (!result.path) return null;
      return cellKey(result.path[result.path.length - 1]) === cellKey(door) ? result.path : null;
    };
    return {
      carried: world.spatial?.carry[actorId]?.meals ?? 0,
      stockLevel: this.useExperience
        ? (this.experience.believesWarehouseEmpty(actorId) ? 0 : belief.level)
        : null,
      publicFood: world.resources.food,
      restockRumor: belief.rumor,
      routeToWarehouse: routeTo('warehouse', npc.location === 'warehouse'),
      routeToKitchen: routeTo('kitchen', npc.location === 'kitchen'),
    };
  }

  /** Events of a just-executed command, resolved from the actor's own memory. */
  private itemsOfEvents(actorId: string, eventIds: string[]): unknown[] {
    if (eventIds.length === 0) return [];
    const store = this.session.memories.get(actorId)!;
    const query = store.query({ observerId: actorId, now: this.session.world.simTime, topK: 50 });
    const wanted = new Set(eventIds);
    return query.items.filter(item => wanted.has(item.evidenceIds[0] ?? item.recordId)
      || wanted.has(item.recordId));
  }

  /** One decision per alive NPC, executed through the authoritative session path. */
  step(): GameplayStepResult {
    const records: GameplayStepRecord[] = [];
    const knowledge = this.session.knowledge();
    for (const actorId of this.session.npcIds) {
      const npc = this.session.world.npcs[actorId];
      if (!npc?.alive) continue;
      const relation = knowledge[actorId]?.relation as { trust?: number } | null;
      const trust = typeof relation?.trust === 'number' ? relation.trust : 0;
      // R4 (G4): survival proposals / agreed resumes / explicit exits happen
      // BEFORE the actor chooses, so the choice reflects the negotiated state.
      this.advanceCommitments(actorId);
      const tasks = this.board.activeFor(actorId);
      const delivery = tasks.some(task => task.kind === 'deliver-meal')
        && this.deliveryAllowed(actorId) ? this.deliveryView(actorId) : undefined;
      const { candidates, conflict } = buildGameplayCandidates({
        actorId, npc: { id: npc.id, location: npc.location, hunger: npc.hunger,
          stamina: npc.stamina, health: npc.health, san: npc.san, alive: npc.alive },
        resources: this.session.world.resources, furnace: this.session.world.furnace,
        tasks, relationTrust: trust, ...(delivery ? { delivery } : {}),
      });
      const chosen = chooseReference(candidates);
      const commandId = `${actorId}-game-${this.session.world.version}-${chosen.candidate.id}`;
      const outcome = this.session.executeCandidate(actorId, chosen.candidate, commandId);
      const items = outcome.status === 'applied'
        ? this.itemsOfEvents(actorId, outcome.eventIds) : [];
      if (items.length > 0 && this.useExperience) {
        for (const item of items as Array<Record<string, unknown>>) {
          this.experience.observe(actorId, {
            eventId: Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0
              ? String(item.evidenceIds[0]) : String(item.recordId),
            kind: String(item.kind), simTime: Number(item.occurredAt ?? 0),
            payload: item.payload as Record<string, unknown>,
          } satisfies FoldableEvent);
        }
      }
      const kinds = (items as Array<{ kind: string }>).map(item => item.kind);
      if (outcome.status === 'applied') {
        const taskKind = chosen.candidate.id === 'g-gather-food' ? 'gather-food'
          : chosen.candidate.id === 'g-gather-wood' ? 'gather-wood'
            : chosen.candidate.id === 'g-heat' ? 'heating'
              : chosen.candidate.id.startsWith('c-help-') ? 'leave-food'
                : chosen.candidate.id === 'g-deliver' ? 'deliver-meal' : null;
        if (taskKind) {
          // A delivery only completes on the confirmed meal_delivered event;
          // out_of_stock / delivery_shortfall keep the task honestly open.
          if (taskKind === 'deliver-meal') {
            if (kinds.includes('meal_delivered')) {
              const task = this.board.activeFor(actorId).find(entry => entry.kind === 'deliver-meal');
              if (task) this.board.complete(task.taskId);
              // R4 (G4): the commitment is fulfilled ONLY from this receipt.
              const commitment = this.commitments.activeFor(actorId)
                .filter(row => row.goal === 'deliver-meal')
                .find(row => ['active', 'pending-change', 'suspended']
                  .includes(row.status));
              if (commitment) {
                const receiptEventId = outcome.eventIds
                  .find(id => id.includes('meal_delivered')) ?? outcome.eventIds[0];
                const fulfilled = this.commitments.fulfil(commitment.commitmentId, {
                  eventId: receiptEventId, commandId,
                  at: this.session.world.simTime, amount: 1 });
                this.session.ingestCommitmentEvent(fulfilled.event);
              }
            }
          } else {
            const task = this.board.activeFor(actorId).find(entry => entry.kind === taskKind);
            if (task) this.board.complete(task.taskId);
          }
        }
      }
      records.push({ actorId, selectedId: chosen.candidate.id,
        executed: outcome.status === 'applied', reason: chosen.rule,
        conflict, candidates: candidates.map(entry => ({ id: entry.candidate.id,
          utility: entry.utility, rule: entry.rule })), mode: 'reference-rules/1' });
    }
    return { records, executed: records.filter(record => record.executed).length,
      mode: 'reference-rules/1' };
  }

  /** Direct spatial command submission for CLI use (same authority path). */
  submitSpatial(command: Command): { status: string; eventIds: string[]; events: WorldEvent[];
    observedBy: string[] } {
    const result = this.session.submitWorldCommand(command);
    if (this.useExperience && result.status === 'applied') {
      for (const observer of result.observedBy) {
        for (const worldEvent of result.events) {
          this.experience.observe(observer, { eventId: worldEvent.eventId,
            kind: worldEvent.type, simTime: worldEvent.simTime,
            payload: worldEvent.payload as Record<string, unknown> });
        }
      }
    }
    return result;
  }

  advance(minutes: number): { status: string; simTime: number; eventIds: string[] } {
    return this.session.advance(minutes);
  }

  status(): Record<string, unknown> {
    const spatial = this.session.world.spatial;
    return { day: this.session.world.day, simTime: this.session.world.simTime,
      hoursElapsed: this.session.world.simTime / 60, ending: this.session.world.ending,
      mode: 'reference-rules/1', tasks: this.board.toJSON(),
      resources: this.session.world.resources,
      ...(spatial ? { spatial: { warehouseFood: spatial.stocks.warehouse.food,
        carry: spatial.carry, deliveredMeals: spatial.deliveredMeals,
        closedCells: spatial.closedCells } } : {}),
      deliveryBeliefs: Object.fromEntries(this.session.npcIds
        .filter(id => this.board.activeFor(id).some(task => task.kind === 'deliver-meal'))
        .map(id => [id, warehouseBelief(this.session, id)])),
      commitments: this.commitments.all() };
  }

  /** Session + task-board + experience sidecars; restore keeps them honest. */
  save(path: string): void {
    this.session.save(path);
    writeFileSync(`${path}.tasks.json`, `${JSON.stringify(this.board.toJSON(), null, 2)}\n`,
      'utf8');
    writeFileSync(`${path}.experience.json`,
      `${JSON.stringify(this.experience.toJSON(), null, 2)}\n`, 'utf8');
    writeFileSync(`${path}.commitments.json`,
      `${JSON.stringify(this.commitments.toJSON(), null, 2)}\n`, 'utf8');
  }

  static load(path: string, options: GameplayLoopOptions = {},
    scorerProvider?: () => ScorerPort): GameplayLoop {
    const session = PlaySession.load(path, scorerProvider);
    const sidecar = `${path}.tasks.json`;
    const board = existsSync(sidecar)
      ? TaskBoard.fromJSON(JSON.parse(readFileSync(sidecar, 'utf8'))) : new TaskBoard();
    const experienceSidecar = `${path}.experience.json`;
    const experience = existsSync(experienceSidecar)
      ? ExperienceStore.fromJSON(JSON.parse(readFileSync(experienceSidecar, 'utf8')))
      : ExperienceStore.empty();
    const commitmentSidecar = `${path}.commitments.json`;
    const commitments = existsSync(commitmentSidecar)
      ? CommitmentBoard.fromJSON(JSON.parse(readFileSync(commitmentSidecar, 'utf8')))
      : CommitmentBoard.empty();
    return new GameplayLoop(session, board, { experience, commitments, ...options });
  }
}

/** Structured player commands this module exposes (owner wires them into the CLI). */
export const GAMEPLAY_COMMANDS = [
  { name: 'assign', usage: 'assign <npcId> <gather-food|gather-wood|heating|leave-food|deliver-meal>' },
  { name: 'cancel-task', usage: 'cancel-task <taskId>' },
  { name: 'task-status', usage: 'task-status' },
  { name: 'map', usage: 'map [village|warehouse|kitchen]' },
  { name: 'where', usage: 'where <npcId>' },
  { name: 'travel', usage: 'travel <npcId> <buildingId>' },
  { name: 'withdraw', usage: 'withdraw <npcId> [amount]' },
  { name: 'deliver', usage: 'deliver <npcId> [amount]' },
  { name: 'restock', usage: 'restock <amount> [source]' },
  { name: 'close-road', usage: 'close-road <x,y> [x,y ...]' },
  { name: 'open-road', usage: 'open-road <x,y> [x,y ...]' },
  { name: 'tell-restock', usage: 'tell-restock <npcId>' },
] as const;

/**
 * R4 frozen P interface (R consumes, P implements) — five methods + event shape:
 *   1. requestCommitment(actorId, goal, { deadline?, conditions?, inputId? })
 *        -> { commitment, response, task, events }
 *   2. respondChange(commitmentId, 'accept'|'reject', { inputId?, reason? })
 *        -> { commitment, event }
 *   3. resumeCommitment(commitmentId, { inputId?, reason? }) / withdrawCommitment(...)
 *   4. step() drives survival proposals, agreed resumes and both-sided fulfilment
 *   5. save/load sidecars: session.json + .tasks.json + .experience.json + .commitments.json
 * Event shape: { type, commitmentId, revision, at, actorId, payload }
 *   types: commitment_proposed|accepted|declined|change_proposed|change_accepted|
 *          change_rejected|resumed|withdrawn|cancelled|fulfilled|response_ignored|
 *          request_rejected|conflict
 */
export interface CommitmentRequestResult {
  commitment: Commitment;
  response: { verdict: 'accept' | 'decline' | 'counter'; reason: string;
    terms?: CommitmentTerms };
  task: GameplayTask | null;
  events: CommitmentEvent[];
  duplicate?: boolean;
  conflict?: boolean;
}

export { deriveDeliveryPhase };
