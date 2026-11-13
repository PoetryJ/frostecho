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
import { CommitmentBoard, isTerminal, type Commitment, type CommitmentEvent,
  type CommitmentTerms } from './commitments';
import { initialResponse, resumeReady, shouldWithdraw, survivalProposal } from './negotiation';
import { ExperienceStore, type FoldableEvent } from '../memory/experience';
import { CouncilBoard, type CouncilRecord, type CouncilRequest,
  type CouncilResolveResult } from '../council-v2/council';
import type { Command, WorldEvent } from '../survival/world-v2';

export interface GameplayStepResult {
  records: GameplayStepRecord[];
  executed: number;
  mode: 'reference-rules/1';
}

/**
 * R4 (G5) memory arms for the paired comparison — identical visible state,
 * candidates and rules; only the stock-belief mechanism differs:
 *   none        : no memory at all (each step re-verifies blindly)
 *   raw         : newest direct event only (strong rules over raw events)
 *   summary     : raw evidence + a deterministic one-line summary of the
 *                 last shortage (no per-note conditions, no refetch)
 *   experience  : conditional notes with evidence/conditions/invalidation
 */
export type MemoryArm = 'none' | 'raw' | 'summary' | 'experience';

export interface GameplayLoopOptions {
  /**
   * R3 (E): when false the loop never learns from past stock events — the
   * delivery policy sees a null stock level forever and must re-verify by
   * acting. Kept for the historical reference-only arm.
   */
  useExperience?: boolean;
  /** R4: explicit memory arm for the three-way comparison. */
  memoryArm?: MemoryArm;
  /** Preloaded experience notes (restore path). */
  experience?: ExperienceStore;
  /** R4: preloaded commitments (restore path). */
  commitments?: CommitmentBoard;
  /** R5: preloaded council records (restore path). */
  council?: CouncilBoard;
}

const KIND_TO_TASK: Record<string, GameplayTaskKind> = {
  'gather-food': 'gather-food', 'gather-wood': 'gather-wood',
  heating: 'heating', 'leave-food': 'leave-food', 'deliver-meal': 'deliver-meal',
  'supply-warehouse': 'supply-warehouse', 'rest-first': 'rest-first',
};

/** R5: a commitment goal is bound to exactly one work row on every entry path. */
const GOAL_TO_TASK: Record<string, GameplayTaskKind> = {
  'deliver-meal': 'deliver-meal',
  'supply-warehouse': 'supply-warehouse',
  'rest-first': 'rest-first',
  'gather-food': 'gather-food',
  'gather-wood': 'gather-wood',
  heating: 'heating',
  'leave-food': 'leave-food',
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
  readonly memoryArm: MemoryArm;
  readonly experience: ExperienceStore;
  readonly commitments: CommitmentBoard;
  readonly council: CouncilBoard;

  constructor(readonly session: PlaySession,
    readonly board: TaskBoard = new TaskBoard(),
    options: GameplayLoopOptions = {}) {
    this.memoryArm = options.memoryArm ?? (options.useExperience === false
      ? 'none' : 'experience');
    this.useExperience = this.memoryArm === 'experience';
    this.experience = options.experience ?? ExperienceStore.empty();
    this.commitments = options.commitments ?? CommitmentBoard.empty();
    this.council = options.council ?? CouncilBoard.empty();
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
    options: { deadline?: number | null; conditions?: string[]; inputId?: string;
      beneficiaryId?: string; source?: string;
      /** R5: the acceptance verdict is supplied by the requesting team. */
      verdict?: 'accept' | 'decline' | 'counter';
      /** R5: an explicit counter keeps the instance proposed with terms. */
      counterTerms?: CommitmentTerms } = {}):
    CommitmentRequestResult {
    const world = this.session.world;
    const npc = world.npcs[actorId];
    if (!npc) throw new Error(`unknown npc ${actorId}`);
    const at = world.simTime;
    const requested = this.commitments.request({ promisorId: actorId,
      beneficiaryId: options.beneficiaryId ?? 'player', goal,
      ...(options.source ? { source: options.source } : {}),
      conditions: options.conditions ?? ['warehouse-supply'],
      deadline: options.deadline ?? null, at, inputId: options.inputId });
    if (requested.conflict) {
      return { commitment: requested.commitment, task: null,
        response: { verdict: 'decline', reason: 'command_id_conflict' },
        events: [requested.event], conflict: true };
    }
    if (requested.duplicate) {
      const live = this.commitments.find(requested.commitment.commitmentId);
      const task = live?.taskId ? this.board.find(live.taskId) ?? null : null;
      return { commitment: live ?? requested.commitment, task,
        response: { verdict: 'accept', reason: 'duplicate_replay' },
        events: [requested.event], duplicate: true };
    }
    const live = this.commitments.find(requested.commitment.commitmentId)!;
    const answer = requested.reason === 'already-committed'
      ? { verdict: 'decline' as const, reason: 'already-committed' }
      : options.verdict === 'decline'
        ? { verdict: 'decline' as const, reason: 'declined-by-resident' }
        : options.verdict === 'counter'
          ? { verdict: 'counter' as const, reason: 'conditional-by-resident',
            terms: options.counterTerms ?? initialResponse(npc)
              .terms ?? { resumeWhen: 'hunger>=40' } }
          : options.verdict === 'accept'
            ? { verdict: 'accept' as const, reason: 'accepted-by-resident' }
            : initialResponse(npc, this.commitments.activeFor(actorId)
              .filter(row => row.commitmentId !== live.commitmentId));
    const responded = this.commitments.respond(live.commitmentId, answer.verdict,
      { at, reason: answer.reason, terms: 'terms' in answer ? answer.terms : undefined,
        inputId: options.inputId ? `${options.inputId}:respond` : undefined });
    this.session.ingestCommitmentEvent(requested.event);
    this.session.ingestCommitmentEvent(responded.event);
    const task = responded.commitment.status === 'active'
      ? this.linkTask(responded.commitment, at, options.inputId
        ? `${options.inputId}:task` : undefined)
      : null;
    return { commitment: this.commitments.find(live.commitmentId)!, response: answer,
      task, events: [requested.event, responded.event] };
  }

  /**
   * R5: every path that reaches an executable state uses this one binding rule.
   * A row is created only when the commitment is active (or suspended, where it
   * exists but the wait gate keeps it from executing); repeated calls reuse it.
   */
  private linkTask(commitment: Commitment, at: number, inputId?: string): GameplayTask | null {
    if (isTerminal(commitment.status)) return null;
    // Board results are clones; the binding must land on the live row.
    const live = this.commitments.find(commitment.commitmentId) ?? commitment;
    if (live.taskId) {
      const existing = this.board.find(live.taskId);
      if (existing && existing.status === 'active') return existing;
    }
    const bound = this.board.activeFor(live.promisorId)
      .find(task => task.commitmentId === live.commitmentId);
    if (bound) {
      live.taskId = bound.taskId;
      commitment.taskId = bound.taskId;
      return bound;
    }
    if (!['active', 'suspended'].includes(live.status)) return null;
    const kind = GOAL_TO_TASK[live.goal];
    if (!kind) return null;
    const task = this.board.assign(live.promisorId, kind, { now: at,
      commitmentId: live.commitmentId, ...(inputId ? { inputId } : {}) });
    live.taskId = task.taskId;
    commitment.taskId = task.taskId;
    return task;
  }

  /** R5: the accepted resumeWhen is a real wait gate, not a note. */
  private waitGateOpen(commitment: Commitment): boolean {
    const npc = this.session.world.npcs[commitment.promisorId];
    if (!npc) return false;
    const accepted = [...commitment.changes].reverse()
      .find(change => change.status === 'accepted' && change.terms.resumeWhen);
    if (!accepted?.terms.resumeWhen) return true;
    return resumeReady(npc, commitment);
  }

  /** The beneficiary answers the newest open change proposal. */
  respondChange(commitmentId: string, verdict: 'accept' | 'reject',
    options: { inputId?: string; reason?: string } = {}):
    { commitment: Commitment; event: CommitmentEvent } {
    const at = this.session.world.simTime;
    const commitment = this.commitments.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const open = commitment.changes.filter(change => change.status === 'open').at(-1);
    if (!open || isTerminal(commitment.status)) {
      // R5: a repeated/late answer is ignored, never a second work row.
      const event: CommitmentEvent = { type: 'commitment_response_ignored',
        commitmentId, revision: commitment.revision, at, actorId: commitment.promisorId,
        payload: { reason: open ? `status_${commitment.status}` : 'no_open_change',
          inputId: options.inputId ?? '' } };
      this.session.ingestCommitmentEvent(event);
      return { commitment: this.commitments.find(commitmentId)!, event };
    }
    const result = this.commitments.respondChange(commitmentId, open.changeId, verdict,
      { at, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    if (result.event.type === 'commitment_change_accepted'
      || (result.event.type === 'commitment_change_rejected'
        && result.commitment.status === 'active')) {
      this.linkTask(result.commitment, at);
      const request = this.council.requestByCommitment(commitmentId);
      if (request && request.status === 'countered' && result.commitment.status === 'active') {
        request.status = 'accepted';
      }
    }
    return { commitment: result.commitment, event: result.event };
  }

  /** The promisor resumes after the agreed condition holds (explicit only). */
  resumeCommitment(commitmentId: string, options: { inputId?: string;
    reason?: string } = {}): { commitment: Commitment; event: CommitmentEvent } {
    const result = this.commitments.resume(commitmentId,
      { at: this.session.world.simTime, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    if (result.commitment.status === 'active') {
      this.linkTask(result.commitment, this.session.world.simTime);
    }
    return { commitment: result.commitment, event: result.event };
  }

  /** Stop the work row bound to a terminal commitment; never a legacy fallback. */
  private closeBoundTasks(commitment: Commitment): void {
    for (const task of this.board.tasks) {
      if (task.status !== 'active') continue;
      if (task.commitmentId !== commitment.commitmentId
        && task.taskId !== commitment.taskId) continue;
      this.board.cancel(task.taskId);
    }
  }

  /** The beneficiary cancels; every later attempt stops (independent terminal). */
  cancelCommitment(commitmentId: string, options: { inputId?: string;
    reason?: string } = {}): { commitment: Commitment; event: CommitmentEvent } {
    const result = this.commitments.cancel(commitmentId,
      { at: this.session.world.simTime, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    this.closeBoundTasks(result.commitment);
    return { commitment: result.commitment, event: result.event };
  }

  /** The promisor exits explicitly; the relation moves on this evidence. */
  withdrawCommitment(commitmentId: string, options: { inputId?: string;
    reason?: string } = {}): { commitment: Commitment; event: CommitmentEvent } {
    const result = this.commitments.withdraw(commitmentId,
      { at: this.session.world.simTime, inputId: options.inputId, reason: options.reason });
    this.session.ingestCommitmentEvent(result.event);
    this.closeBoundTasks(result.commitment);
    return { commitment: result.commitment, event: result.event };
  }

  commitmentStatus(): { commitments: Commitment[]; tasks: unknown[] } {
    return { commitments: this.commitments.all(), tasks: this.board.toJSON() };
  }

  /** R5: one morning council for the current day (idempotent per save). */
  openCouncil(): { council: CouncilRecord; duplicate: boolean } {
    const opened = this.council.openMorning(this.session.world);
    if (!opened.duplicate) {
      this.session.ingestTeamEvent('council_opened', {
        councilId: opened.council.councilId, revision: opened.council.revision,
        source: 'council:morning', proposals: opened.council.proposals.length,
      }, this.session.world.simTime);
    }
    return opened;
  }

  /** Player/reference vote on one proposal. */
  councilVote(proposalId: string): { council: CouncilRecord; ignored: boolean } {
    const current = this.council.all().at(-1);
    if (!current) throw new Error('no council open');
    return this.council.vote(current.councilId, proposalId, 'player',
      'player-reference-vote');
  }

  /** Tally votes, create the team event and the resident task requests. */
  councilResolve(): CouncilResolveResult {
    const current = this.council.all().at(-1);
    if (!current) throw new Error('no council open');
    // Auto-vote any living resident who has not answered yet, then resolve.
    this.council.autoVote(this.session.world, current.councilId);
    const result = this.council.resolve(this.session.world, current.councilId);
    if (!result.duplicate) {
      this.session.ingestTeamEvent('council_resolved', {
        councilId: result.resolution.councilId,
        resolutionId: result.resolution.resolutionId,
        source: result.resolution.source,
        revision: result.resolution.revision,
        proposalId: result.resolution.proposalId,
        requests: result.resolution.requests,
      }, result.resolution.decidedAt);
    }
    return result;
  }

  /**
   * A resident answers a council request explicitly. Acceptance creates the
   * commitment + task through the existing path; the council never writes a
   * task itself. A counter stays a proposal until the beneficiary answers.
   */
  councilRespond(requestId: string, verdict: 'accept' | 'decline' | 'counter'):
    { request: CouncilRequest; ignored: boolean; reason?: string;
      commitment?: Commitment | null; task?: GameplayTask | null } {
    const request = this.council.request(requestId);
    if (!request) throw new Error(`unknown council request ${requestId}`);
    const answer = this.council.respond(requestId, verdict);
    if (answer.ignored) return { ...answer };
    const at = this.session.world.simTime;
    if (verdict === 'decline') {
      this.session.ingestTeamEvent('council_request_declined', {
        councilId: request.councilId, resolutionId: request.resolutionId,
        source: request.source, revision: request.revision, requestId,
        actorId: request.actorId, role: request.role,
      }, at);
      return { request: answer.request, ignored: false };
    }
    const terms = verdict === 'counter'
      ? { resumeWhen: 'hunger>=40', reason: '先处理生存需要再承接议会分工' }
      : undefined;
    const result = this.requestCommitment(request.actorId, request.goal, {
      source: request.source,
      beneficiaryId: 'council',
      inputId: `council-${request.requestId}`,
      verdict,
      ...(terms ? { counterTerms: terms } : {}),
    });
    this.council.attachCommitment(requestId, result.commitment.commitmentId);
    if (verdict === 'accept' && result.commitment.status !== 'active') {
      // An old promise is never silently erased: the refusal is recorded.
      request.status = 'declined';
      request.reason = result.response.reason;
    }
    if (result.task) request.taskKind = result.task.kind;
    this.session.ingestTeamEvent(
      verdict === 'counter' ? 'council_request_countered' : 'council_request_accepted',
      { councilId: request.councilId, resolutionId: request.resolutionId,
        source: request.source, revision: request.revision, requestId,
        actorId: request.actorId, role: request.role,
        commitmentId: result.commitment.commitmentId,
        commitmentStatus: result.commitment.status,
        taskId: result.task?.taskId ?? null,
      }, at);
    return { request: answer.request, ignored: false,
      commitment: result.commitment, task: result.task };
  }

  /** Explicitly replace an exited resident with a NEW request/revision. */
  councilReassign(requestId: string, actorId: string):
    { request: CouncilRequest; previous: CouncilRequest } {
    const request = this.council.request(requestId);
    if (!request) throw new Error(`unknown council request ${requestId}`);
    if (!this.session.world.npcs[actorId]?.alive) {
      throw new Error(`unknown/alive npc required: ${actorId}`);
    }
    const commitment = request.commitmentId
      ? this.commitments.find(request.commitmentId) : undefined;
    const terminated = commitment ? isTerminal(commitment.status) : true;
    if (!terminated && request.status === 'accepted') {
      throw new Error(`cannot reassign an active assignment: ${requestId}`);
    }
    const previous = { ...request };
    const replacement = this.council.reassign(requestId, actorId,
      this.session.world.simTime, true);
    this.session.ingestTeamEvent('council_request_reassigned', {
      councilId: request.councilId, resolutionId: request.resolutionId,
      source: request.source, revision: replacement.revision,
      previousRequestId: requestId, requestId: replacement.requestId,
      previousActorId: previous.actorId, actorId,
    }, this.session.world.simTime);
    return { request: replacement, previous };
  }

  councilStatus(): Array<Record<string, unknown>> {
    return this.council.statusView(this.session.world, this.commitments,
      this.board.toJSON());
  }

  /**
   * R5: a work row bound to a commitment executes only while that instance is
   * active and its agreed wait gate is open. A row bound to a terminal promise
   * never falls back to the legacy fixture path; only an explicitly unbound
   * fixture row may run without a commitment.
   */
  private deliveryAllowed(actorId: string): boolean {
    const tasks = this.board.activeFor(actorId).filter(task => task.kind === 'deliver-meal');
    if (tasks.length === 0) return false;
    for (const task of tasks) {
      if (!task.commitmentId) continue; // explicit fixture assignment
      const commitment = this.commitments.find(task.commitmentId);
      if (!commitment || isTerminal(commitment.status)) return false;
      if (commitment.status !== 'active') return false;
      if (!this.waitGateOpen(commitment)) return false;
    }
    return true;
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
        // A counter-accept with an unmet resumeWhen is an agreed wait: the
        // promisor eats/rests first instead of renegotiating its own condition.
        if (!this.waitGateOpen(commitment)) continue;
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
          if (result.commitment.status === 'active') this.linkTask(result.commitment, at);
        }
      } else if (commitment.status === 'pending-change') {
        if (shouldWithdraw(npc, commitment)) {
          const result = this.commitments.withdraw(commitment.commitmentId,
            { at, reason: 'survival-exit' });
          this.session.ingestCommitmentEvent(result.event);
          // The explicit exit also stops the bound work row; no legacy fallback.
          this.closeBoundTasks(result.commitment);
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
    let stockLevel: number | null = null;
    if (this.memoryArm === 'experience') {
      stockLevel = this.experience.believesWarehouseEmpty(actorId) ? 0 : belief.level;
    } else if (this.memoryArm === 'raw' || this.memoryArm === 'summary') {
      stockLevel = belief.level;
    }
    return {
      carried: world.spatial?.carry[actorId]?.meals ?? 0,
      stockLevel,
      publicFood: world.resources.food,
      restockRumor: belief.rumor,
      routeToWarehouse: routeTo('warehouse', npc.location === 'warehouse'),
      routeToKitchen: routeTo('kitchen', npc.location === 'kitchen'),
    };
  }

  /** R5: what a supply-warehouse assignee can see about its own route/stock. */
  private supplyView(actorId: string): {
    publicFood: number; atWarehouse: boolean;
    routeToWarehouse: Array<{ x: number; y: number }> | null } {
    const world = this.session.world;
    const npc = world.npcs[actorId];
    const from = actorCell(world, actorId);
    if (npc.location === 'warehouse') {
      return { publicFood: world.resources.food, atWarehouse: true,
        routeToWarehouse: [] };
    }
    const door = BUILDINGS.find(building => building.id === 'warehouse')!.door;
    const closed = new Set(world.spatial?.closedCells ?? []);
    const result = findPath(MAPS.village, from, door, closed);
    const route = result.path
      && cellKey(result.path[result.path.length - 1]) === cellKey(door)
      ? result.path : null;
    return { publicFood: world.resources.food, atWarehouse: false,
      routeToWarehouse: route };
  }

  /**
   * The receipt this actor's own command actually produced.
   * Amount and event id come from that receipt. A missing event, a non-positive
   * amount, or another command's id does not qualify, and eventIds[0] is never
   * a substitute.
   */
  private authoritativeReceipt(actorId: string, eventIds: string[], kind: string):
    { eventId: string; amount: number } | null {
    if (eventIds.length === 0) return null;
    const wanted = new Set(eventIds);
    const items = this.itemsOfEvents(actorId, eventIds) as Array<{
      kind: string; payload?: Record<string, unknown>; evidenceIds?: string[];
    }>;
    for (const item of items) {
      if (item.kind !== kind) continue;
      const amount = item.payload?.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) continue;
      const eventId = (item.evidenceIds ?? []).find(id => wanted.has(id)
        && id.includes(`:${kind}:`));
      if (!eventId) continue;
      return { eventId, amount };
    }
    return null;
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
      const supply = tasks.some(task => task.kind === 'supply-warehouse')
        ? this.supplyView(actorId) : undefined;
      const { candidates, conflict } = buildGameplayCandidates({
        actorId, npc: { id: npc.id, location: npc.location, hunger: npc.hunger,
          stamina: npc.stamina, health: npc.health, san: npc.san, alive: npc.alive },
        resources: this.session.world.resources, furnace: this.session.world.furnace,
        tasks, relationTrust: trust, ...(delivery ? { delivery } : {}),
        ...(supply ? { supply } : {}),
      });
      const chosen = chooseReference(candidates);
      const commandId = `${actorId}-game-${this.session.world.version}-${chosen.candidate.id}`;
      const outcome = this.session.executeCandidate(actorId, chosen.candidate, commandId);
      const items = outcome.status === 'applied'
        ? this.itemsOfEvents(actorId, outcome.eventIds) : [];
      if (items.length > 0 && this.memoryArm === 'experience') {
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
        const active = this.board.activeFor(actorId);
        const has = (kind: GameplayTaskKind) => active.some(task => task.kind === kind);
        const taskKind = chosen.candidate.id === 'g-gather-food'
          ? (has('supply-warehouse') ? null : 'gather-food')
          : chosen.candidate.id === 'g-gather-wood' ? 'gather-wood'
            : chosen.candidate.id === 'g-heat' ? 'heating'
              : chosen.candidate.id.startsWith('c-help-') ? 'leave-food'
                : chosen.candidate.id === 'g-deposit'
                  ? (has('supply-warehouse') ? 'supply-warehouse' : null)
                  : chosen.candidate.id === 'g-rest'
                    ? (has('rest-first') ? 'rest-first' : null)
                    : chosen.candidate.id === 'g-rest-first' ? 'rest-first'
                      : chosen.candidate.id === 'g-deliver' ? 'deliver-meal' : null;
        if (taskKind) {
          // Delivery and supply complete only on the confirmed receipt for
          // THIS actor and THIS command. The amount is the receipt's amount.
          // out_of_stock / delivery_shortfall / a failed deposit stay open.
          if (taskKind === 'deliver-meal' || taskKind === 'supply-warehouse') {
            const receiptKind = taskKind === 'deliver-meal'
              ? 'meal_delivered' : 'stock_deposited';
            const receipt = this.authoritativeReceipt(actorId, outcome.eventIds, receiptKind);
            if (receipt) {
              const task = this.board.activeFor(actorId)
                .find(entry => entry.kind === taskKind);
              const commitment = task?.commitmentId
                ? this.commitments.find(task.commitmentId) : undefined;
              // Only the task's own commitment, and only while it can still
              // be settled. Never scan this NPC's other promises.
              if (task && commitment && commitment.promisorId === actorId
                && !isTerminal(commitment.status)) {
                const fulfilled = this.commitments.fulfil(commitment.commitmentId, {
                  eventId: receipt.eventId, commandId,
                  at: this.session.world.simTime, amount: receipt.amount });
                this.session.ingestCommitmentEvent(fulfilled.event);
                if (fulfilled.commitment.status === 'fulfilled'
                  && fulfilled.commitment.evidenceEventIds.includes(receipt.eventId)) {
                  this.board.complete(task.taskId);
                }
              } else if (task && !task.commitmentId) {
                // An explicitly unbound legacy fixture row completes on the
                // receipt and never settles some other promise.
                this.board.complete(task.taskId);
              }
            }
          } else if (taskKind === 'rest-first') {
            if (!kinds.includes('rested')) {
              // A rest assignment that cannot execute stays open.
            } else {
              const task = this.board.activeFor(actorId)
                .find(entry => entry.kind === 'rest-first');
              if (task) this.board.complete(task.taskId);
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
    if (this.memoryArm === 'experience' && result.status === 'applied') {
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
      commitments: this.commitments.all(),
      council: this.councilStatus() };
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
    writeFileSync(`${path}.council.json`,
      `${JSON.stringify(this.council.toJSON(), null, 2)}\n`, 'utf8');
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
    const councilSidecar = `${path}.council.json`;
    const council = existsSync(councilSidecar)
      ? CouncilBoard.fromJSON(JSON.parse(readFileSync(councilSidecar, 'utf8')))
      : CouncilBoard.empty();
    return new GameplayLoop(session, board,
      { experience, commitments, council, ...options });
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
  { name: 'council-open', usage: 'council-open' },
  { name: 'council-vote', usage: 'council-vote <proposalId>' },
  { name: 'council-resolve', usage: 'council-resolve' },
  { name: 'council-status', usage: 'council-status' },
  { name: 'council-respond', usage: 'council-respond <requestId> <accept|decline|counter>' },
  { name: 'council-reassign', usage: 'council-reassign <requestId> <npcId>' },
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
