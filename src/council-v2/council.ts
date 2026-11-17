/**
 * R5 (P): one morning-council vertical slice.
 *
 * The council is a TEAM EVENT source, not a second execution queue:
 *  - proposals are derived from visible resources and actor state;
 *  - votes are a deterministic reference fixture (never model understanding);
 *  - the winning resolution creates task REQUESTS with councilId/resolutionId/
 *    source/revision;
 *  - a resident answers explicitly (accept/decline/counter), and acceptance is
 *    what creates the commitment + task through the existing gameplay path;
 *  - reassignment creates a NEW request/revision; it never renames the old
 *    person's promise.
 */
import type { NpcState, WorldV2 } from '../survival/world-v2';
import type { GameplayTaskKind } from '../gameplay-v2/tasks';

export type CouncilStatus = 'propose' | 'voting' | 'resolved' | 'superseded';
export type CouncilRole = 'supply' | 'deliver' | 'rest';
export type CouncilRequestStatus = 'pending' | 'accepted' | 'declined'
  | 'countered' | 'superseded' | 'reassigned';

export interface CouncilAssignment {
  role: CouncilRole;
  actorId: string;
  taskKind: GameplayTaskKind;
  goal: string;
}

export interface CouncilProposal {
  proposalId: string;
  name: string;
  description: string;
  assignments: CouncilAssignment[];
  cost: {
    supplyTrips: number;
    deliveryTrips: number;
    restBlocks: number;
    estimatedMinutes: number;
  };
  basis: {
    food: number;
    firewood: number;
    warehouseFood: number;
    actors: Array<{ id: string; hunger: number; stamina: number; location: string }>;
  };
}

export interface CouncilVote {
  voterId: string;
  proposalId: string;
  source: 'fixture-reference/1';
  reason: string;
  revision: number;
}

export interface CouncilRequest {
  requestId: string;
  councilId: string;
  resolutionId: string;
  role: CouncilRole;
  actorId: string;
  taskKind: GameplayTaskKind;
  goal: string;
  source: string;
  revision: number;
  status: CouncilRequestStatus;
  commitmentId: string | null;
  reason?: string;
  createdAt: number;
}

export interface CouncilResolution {
  councilId: string;
  resolutionId: string;
  proposalId: string;
  source: string;
  revision: number;
  votes: CouncilVote[];
  requests: string[];
  decidedAt: number;
}

export interface CouncilRecord {
  councilId: string;
  day: number;
  status: CouncilStatus;
  revision: number;
  proposals: CouncilProposal[];
  votes: CouncilVote[];
  resolution: CouncilResolution | null;
  requests: CouncilRequest[];
  createdAt: number;
  updatedAt: number;
}

export interface CouncilOpenResult {
  council: CouncilRecord;
  duplicate: boolean;
}

export interface CouncilResolveResult {
  council: CouncilRecord;
  resolution: CouncilResolution;
  requests: CouncilRequest[];
  duplicate: boolean;
}

export interface CouncilRespondResult {
  request: CouncilRequest;
  ignored: boolean;
  reason?: string;
}

const ROLE_TASK: Record<CouncilRole, GameplayTaskKind> = {
  supply: 'supply-warehouse',
  deliver: 'deliver-meal',
  rest: 'rest-first',
};

const ROLE_GOAL: Record<CouncilRole, string> = {
  supply: 'supply-warehouse',
  deliver: 'deliver-meal',
  rest: 'rest-first',
};

function livingActors(world: WorldV2): NpcState[] {
  return Object.values(world.npcs).filter(npc => npc.alive);
}

function pickSupplies(actors: NpcState[], excluded: Set<string>): NpcState | undefined {
  return [...actors].filter(npc => !excluded.has(npc.id))
    .sort((left, right) => right.stamina - left.stamina
      || left.hunger - right.hunger || left.id.localeCompare(right.id))[0];
}

function pickLowestStamina(actors: NpcState[], excluded: Set<string>): NpcState | undefined {
  return [...actors].filter(npc => !excluded.has(npc.id))
    .sort((left, right) => left.stamina - right.stamina || left.id.localeCompare(right.id))[0];
}

function estimateMinutes(from: string, to: string): number {
  const distance = from === to ? 4 : 18;
  return distance * 2;
}

/**
 * Two plans with a REAL cost difference. Plan A spends two people; plan B
 * rests the low-stamina carrier and substitutes a third person, costing more
 * travel minutes but protecting the rest block.
 */
export function buildProposals(world: WorldV2, councilId: string): CouncilProposal[] {
  const actors = livingActors(world);
  if (actors.length < 2) return [];
  const excluded = new Set<string>();
  const supplier = pickSupplies(actors, excluded) ?? actors[0];
  excluded.add(supplier.id);
  const carrier = pickSupplies(actors, excluded) ?? actors.find(npc => npc.id !== supplier.id)!;
  excluded.add(carrier.id);
  const substitute = pickSupplies(actors, excluded) ?? carrier;
  const restActor = pickLowestStamina(actors, new Set([supplier.id, substitute.id])) ?? carrier;
  const warehouseFood = world.spatial?.stocks.warehouse.food ?? 0;
  const basis = {
    food: world.resources.food,
    firewood: world.resources.firewood,
    warehouseFood,
    actors: actors.map(npc => ({ id: npc.id, hunger: Math.round(npc.hunger),
      stamina: Math.round(npc.stamina), location: npc.location })),
  };
  const assignment = (role: CouncilRole, actorId: string): CouncilAssignment => ({
    role, actorId, taskKind: ROLE_TASK[role], goal: ROLE_GOAL[role],
  });
  const planA: CouncilProposal = {
    proposalId: `${councilId}:plan-a`,
    name: 'A 采集直送',
    description: 'A 采集并交存仓库，B 从仓库取饭送到厨房；两人满负荷，不安排休息。',
    assignments: [assignment('supply', supplier.id), assignment('deliver', carrier.id)],
    cost: { supplyTrips: 1, deliveryTrips: 1, restBlocks: 0,
      estimatedMinutes: estimateMinutes(supplier.location, 'warehouse')
        + estimateMinutes(carrier.location, 'warehouse')
        + estimateMinutes('warehouse', 'kitchen') },
    basis,
  };
  const planB: CouncilProposal = {
    proposalId: `${councilId}:plan-b`,
    name: 'B 轮换休整',
    description: `${carrier.id} 先休息一个时段，由 ${substitute.id} 代运；供应仍由 `
      + `${supplier.id} 完成，时间更长但保护低体力者。`,
    assignments: [assignment('supply', supplier.id), assignment('rest', restActor.id),
      assignment('deliver', substitute.id)],
    cost: { supplyTrips: 1, deliveryTrips: 1, restBlocks: 1,
      estimatedMinutes: estimateMinutes(supplier.location, 'warehouse')
        + estimateMinutes(substitute.location, 'warehouse')
        + estimateMinutes('warehouse', 'kitchen') + 60 },
    basis,
  };
  return [planA, planB];
}

/** Fixture-reference votes; never a model or player claim. */
export function referenceVotes(world: WorldV2, council: CouncilRecord): CouncilVote[] {
  const actors = livingActors(world);
  const proposalA = council.proposals[0];
  const proposalB = council.proposals[1];
  if (!proposalA || !proposalB) return [];
  const restActor = proposalB.assignments.find(entry => entry.role === 'rest')?.actorId;
  const substituted = proposalB.assignments.find(entry => entry.role === 'deliver')?.actorId;
  return actors.map(npc => {
    const wantsRest = npc.stamina < 35 || (npc.id === restActor && npc.stamina < 55);
    const extraBurden = npc.id === substituted && npc.stamina < 55;
    const chooseB = wantsRest && !extraBurden;
    const chosen = chooseB ? proposalB : proposalA;
    return { voterId: npc.id, proposalId: chosen.proposalId,
      source: 'fixture-reference/1' as const,
      reason: chooseB ? `体力 ${Math.round(npc.stamina)}：轮换休整更可行`
        : extraBurden ? `作为替补 ${npc.id} 不主张把工作转给自己`
          : '两案均可，选成本较低的 A',
      revision: council.revision };
  });
}

function requestsFor(resolution: CouncilResolution, proposal: CouncilProposal,
  at: number): CouncilRequest[] {
  return proposal.assignments.map(assignment => ({
    requestId: `${resolution.resolutionId}:${assignment.role}:${assignment.actorId}`,
    councilId: resolution.councilId,
    resolutionId: resolution.resolutionId,
    role: assignment.role,
    actorId: assignment.actorId,
    taskKind: assignment.taskKind,
    goal: assignment.goal,
    source: resolution.source,
    revision: 1,
    status: 'pending' as const,
    commitmentId: null,
    createdAt: at,
  }));
}

export class CouncilBoard {
  readonly records: CouncilRecord[] = [];

  static empty(): CouncilBoard {
    return new CouncilBoard();
  }

  static fromJSON(payload: { councils?: CouncilRecord[] }): CouncilBoard {
    const board = new CouncilBoard();
    board.records.push(...structuredClone(payload.councils ?? []));
    return board;
  }

  toJSON(): { councils: CouncilRecord[] } {
    return { councils: structuredClone(this.records) };
  }

  all(): CouncilRecord[] {
    return [...this.records];
  }

  find(councilId: string): CouncilRecord | undefined {
    return this.records.find(record => record.councilId === councilId);
  }

  openMorning(world: WorldV2): CouncilOpenResult {
    const day = world.day;
    const councilId = `council-d${day}`;
    const existing = this.find(councilId);
    if (existing) return { council: existing, duplicate: true };
    const at = world.simTime;
    const council: CouncilRecord = {
      councilId, day, status: 'propose', revision: 1,
      proposals: buildProposals(world, councilId), votes: [], resolution: null,
      requests: [], createdAt: at, updatedAt: at,
    };
    this.records.push(council);
    return { council, duplicate: false };
  }

  /** Add one player vote; a closed resolution cannot be overwritten. */
  vote(councilId: string, proposalId: string, voterId: string,
    reason = 'player-reference-vote'): { council: CouncilRecord; ignored: boolean } {
    const council = this.find(councilId);
    if (!council) throw new Error(`unknown council ${councilId}`);
    if (council.status === 'resolved') return { council, ignored: true };
    if (!council.proposals.some(proposal => proposal.proposalId === proposalId)) {
      throw new Error(`unknown proposal ${proposalId}`);
    }
    council.votes = council.votes.filter(vote => vote.voterId !== voterId);
    council.votes.push({ voterId, proposalId, source: 'fixture-reference/1',
      reason, revision: council.revision });
    council.status = 'voting';
    council.updatedAt = council.createdAt;
    return { council, ignored: false };
  }

  /** Auto-vote every living NPC with the fixture policy (idempotent per voter). */
  autoVote(world: WorldV2, councilId: string): CouncilVote[] {
    const council = this.find(councilId);
    if (!council) throw new Error(`unknown council ${councilId}`);
    if (council.status === 'resolved') return [];
    const votes = referenceVotes(world, council);
    for (const vote of votes) {
      council.votes = council.votes.filter(existing => existing.voterId !== vote.voterId);
      council.votes.push(vote);
    }
    council.status = 'voting';
    return votes;
  }

  resolve(world: WorldV2, councilId: string): CouncilResolveResult {
    const council = this.find(councilId);
    if (!council) throw new Error(`unknown council ${councilId}`);
    if (council.resolution) {
      return { council, resolution: council.resolution,
        requests: council.requests, duplicate: true };
    }
    if (council.proposals.length === 0) throw new Error('council has no proposals');
    const tally = new Map<string, number>();
    for (const proposal of council.proposals) tally.set(proposal.proposalId, 0);
    for (const vote of council.votes) {
      tally.set(vote.proposalId, (tally.get(vote.proposalId) ?? 0) + 1);
    }
    // Tie-break: the first proposal (lower estimated cost) wins deterministically.
    const winner = [...council.proposals].sort((left, right) =>
      (tally.get(right.proposalId) ?? 0) - (tally.get(left.proposalId) ?? 0)
        || left.proposalId.localeCompare(right.proposalId))[0];
    const slug = winner.proposalId.split(':').at(-1);
    const resolutionId = `${councilId}:${slug}:rev${council.revision}`;
    const resolution: CouncilResolution = {
      councilId,
      resolutionId,
      proposalId: winner.proposalId,
      source: `council:${councilId}/${resolutionId}`,
      revision: council.revision,
      votes: structuredClone(council.votes),
      requests: [],
      decidedAt: world.simTime,
    };
    const requests = requestsFor(resolution, winner, world.simTime);
    resolution.requests = requests.map(request => request.requestId);
    council.resolution = resolution;
    council.requests = requests;
    council.status = 'resolved';
    council.updatedAt = world.simTime;
    return { council, resolution, requests, duplicate: false };
  }

  request(requestId: string): CouncilRequest | undefined {
    for (const council of this.records) {
      const found = council.requests.find(entry => entry.requestId === requestId);
      if (found) return found;
    }
    return undefined;
  }

  respond(requestId: string, verdict: 'accept' | 'decline' | 'counter',
    reason?: string): CouncilRespondResult {
    const request = this.request(requestId);
    if (!request) throw new Error(`unknown council request ${requestId}`);
    if (request.status !== 'pending') {
      return { request, ignored: true, reason: `status_${request.status}` };
    }
    request.status = verdict === 'accept' ? 'accepted'
      : verdict === 'decline' ? 'declined' : 'countered';
    if (reason) request.reason = reason;
    return { request, ignored: false };
  }

  attachCommitment(requestId: string, commitmentId: string): CouncilRequest {
    const request = this.request(requestId);
    if (!request) throw new Error(`unknown council request ${requestId}`);
    request.commitmentId = commitmentId;
    return request;
  }

  requestByCommitment(commitmentId: string): CouncilRequest | undefined {
    for (const council of this.records) {
      const found = council.requests.find(entry => entry.commitmentId === commitmentId);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Replace a request with a NEW one for a substitute. The old request keeps
   * its revision and history; the substitute must answer explicitly.
   */
  reassign(requestId: string, actorId: string, at: number,
    force = false): CouncilRequest {
    const request = this.request(requestId);
    if (!request) throw new Error(`unknown council request ${requestId}`);
    if (!force && (request.status === 'accepted' || request.status === 'reassigned')) {
      throw new Error(`request ${requestId} is ${request.status}`);
    }
    request.status = 'superseded';
    const replacement: CouncilRequest = {
      ...request,
      requestId: `${request.requestId}:r${request.revision + 1}:${actorId}`,
      actorId,
      revision: request.revision + 1,
      status: 'pending',
      commitmentId: null,
      createdAt: at,
      reason: `reassigned-from:${requestId}`,
    };
    const council = this.find(request.councilId);
    council?.requests.push(replacement);
    return replacement;
  }

  /** Recover a request whose commitment terminated (exit/cancel). */
  statusView(world: WorldV2,
    commitments: { find(id: string): { status: string; revision: number;
      taskId?: string | null } | undefined },
    tasks: Array<{ taskId: string; status: string; kind: string }>): Array<Record<string, unknown>> {
    return this.records.map(council => ({
      ...council,
      requests: council.requests.map(request => {
        const commitment = request.commitmentId
          ? commitments.find(request.commitmentId) : undefined;
        const task = commitment?.taskId
          ? tasks.find(entry => entry.taskId === commitment.taskId) : undefined;
        return { ...request, commitmentStatus: commitment?.status ?? null,
          commitmentRevision: commitment?.revision ?? null,
          taskStatus: task?.status ?? null,
          taskKind: task?.kind ?? request.taskKind,
          visibleResources: { food: world.resources.food,
            firewood: world.resources.firewood,
            warehouseFood: world.spatial?.stocks.warehouse.food ?? 0 } };
      }),
    }));
  }
}
