/**
 * R4 (G4): a negotiable, recoverable commitment — the persistent goal that a
 * delivery attempt works for. It sits beside the TaskBoard (task = the work
 * row, commitment = the promise with its own revision/conditions), never a
 * second world or workflow engine.
 *
 * Frozen semantics (01-CONTRACT §3):
 *  - a player request only PROPOSES; the NPC accepts/declines/counters;
 *  - `pending-change` means a change was proposed, NOT agreed;
 *  - only an explicit accept updates revision/conditions;
 *  - cancel and fulfilment are independent terminal states;
 *  - only an authoritative `meal_delivered` receipt may fulfil an instance;
 *  - a failed attempt keeps the goal; a revision change invalidates old
 *    attempts (attempts carry the revision they were built for).
 */
import { randomUUID } from 'node:crypto';

export type CommitmentStatus = 'proposed' | 'active' | 'pending-change' | 'suspended'
  | 'fulfilled' | 'cancelled' | 'declined' | 'withdrawn';

export type ChangeKind = 'defer' | 'suspend' | 'alt-source';

export interface CommitmentTerms {
  /** Human-readable reason shown to the counterparty. */
  reason?: string;
  /** Resume condition: hunger threshold, restock witness, player order. */
  resumeWhen?: string;
  /** Proposed new deadline (sim minutes). */
  until?: number;
  /** Alternative source the promisor will try. */
  source?: string;
}

export interface CommitmentChange {
  changeId: string;
  /** The revision this change would create once accepted. */
  proposedRevision: number;
  kind: ChangeKind;
  terms: CommitmentTerms;
  reason: string;
  proposedAt: number;
  status: 'open' | 'accepted' | 'rejected';
  respondedAt: number | null;
  responseEventId: string | null;
}

export interface Commitment {
  commitmentId: string;
  taskId: string | null;
  promisorId: string;
  beneficiaryId: string;
  goal: string;
  /** Conditions the promisor requires (e.g. 'warehouse-supply'). */
  conditions: string[];
  deadline: number | null;
  revision: number;
  status: CommitmentStatus;
  evidenceEventIds: string[];
  changes: CommitmentChange[];
  createdAt: number;
  updatedAt: number;
}

export interface CommitmentInput {
  promisorId: string;
  beneficiaryId: string;
  goal: string;
  conditions?: string[];
  deadline?: number | null;
  taskId?: string | null;
  at: number;
  inputId?: string;
}

export interface CommitmentEvent {
  type: string;
  commitmentId: string;
  revision: number;
  at: number;
  actorId: string;
  payload: Record<string, unknown>;
}

export interface CommitmentResult {
  commitment: Commitment;
  event: CommitmentEvent;
  duplicate?: boolean;
  conflict?: boolean;
  reason?: string;
}

const TERMINAL: CommitmentStatus[] = ['fulfilled', 'cancelled', 'declined', 'withdrawn'];

function receiptKey(kind: string, inputId: string): string {
  return `${kind}:${inputId}`;
}

export class CommitmentBoard {
  private readonly rows: Commitment[] = [];
  /** R4: explicit input-id receipts so a retry replays instead of re-acting. */
  private readonly receipts = new Map<string, { digest: string; result: CommitmentResult }>();

  static empty(): CommitmentBoard {
    return new CommitmentBoard();
  }

  static fromJSON(payload: { commitments?: Commitment[];
    receipts?: Record<string, { digest: string; result: CommitmentResult }> }): CommitmentBoard {
    const board = new CommitmentBoard();
    board.rows.push(...structuredClone(payload.commitments ?? []));
    for (const [key, value] of Object.entries(payload.receipts ?? {})) {
      board.receipts.set(key, structuredClone(value));
    }
    return board;
  }

  toJSON(): { commitments: Commitment[];
    receipts: Record<string, { digest: string; result: CommitmentResult }> } {
    return { commitments: structuredClone(this.rows),
      receipts: Object.fromEntries([...this.receipts.entries()].map(([key, value]) =>
        [key, structuredClone(value)])) };
  }

  all(): Commitment[] {
    return [...this.rows];
  }

  find(commitmentId: string): Commitment | undefined {
    return this.rows.find(row => row.commitmentId === commitmentId);
  }

  activeFor(actorId: string): Commitment[] {
    return this.rows.filter(row => row.promisorId === actorId
      && ['active', 'pending-change', 'suspended', 'proposed'].includes(row.status));
  }

  /** Replay an explicit retry only on identical content; else explicit conflict. */
  private replay(kind: string, inputId: string | undefined, digest: string):
    CommitmentResult | 'conflict' | null {
    if (!inputId) return null;
    const seen = this.receipts.get(receiptKey(kind, inputId));
    if (!seen) return null;
    if (seen.digest !== digest) return 'conflict';
    return { ...structuredClone(seen.result), duplicate: true };
  }

  private remember(kind: string, inputId: string | undefined, digest: string,
    result: CommitmentResult): CommitmentResult {
    if (inputId) {
      this.receipts.set(receiptKey(kind, inputId), { digest, result: structuredClone(result) });
    }
    return result;
  }

  private conflictEvent(commitment: Commitment | undefined, at: number, actorId: string,
    inputId: string | undefined): CommitmentResult {
    return {
      commitment: commitment ?? {
        commitmentId: 'conflict', taskId: null, promisorId: actorId,
        beneficiaryId: 'player', goal: 'unknown', conditions: [], deadline: null,
        revision: 0, status: 'cancelled', evidenceEventIds: [], changes: [],
        createdAt: at, updatedAt: at,
      },
      event: { type: 'commitment_conflict', commitmentId: commitment?.commitmentId ?? 'conflict',
        revision: commitment?.revision ?? 0, at, actorId,
        payload: { inputId: inputId ?? '', text: 'command_id_conflict' } },
      conflict: true, reason: 'command_id_conflict',
    };
  }

  /** Step 1: the player asks; the commitment stays `proposed` (never auto-active). */
  request(input: CommitmentInput): CommitmentResult {
    const digest = JSON.stringify({ goal: input.goal, promisorId: input.promisorId,
      beneficiaryId: input.beneficiaryId, deadline: input.deadline ?? null });
    const replay = this.replay('request', input.at === 0 ? input.inputId : input.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(undefined, input.at, input.promisorId,
      input.inputId);
    if (replay) return replay;
    if (this.activeFor(input.promisorId).length > 0) {
      // One live commitment per promisor keeps the story honest and simple.
      const existing = this.activeFor(input.promisorId)[0];
      return this.remember('request', input.inputId, digest, {
        commitment: existing,
        event: { type: 'commitment_request_rejected', commitmentId: existing.commitmentId,
          revision: existing.revision, at: input.at, actorId: input.promisorId,
          payload: { reason: 'already-committed' } },
        reason: 'already-committed',
      });
    }
    const commitment: Commitment = {
      commitmentId: `cm-${randomUUID()}`,
      taskId: input.taskId ?? null,
      promisorId: input.promisorId,
      beneficiaryId: input.beneficiaryId,
      goal: input.goal,
      conditions: [...(input.conditions ?? [])],
      deadline: input.deadline ?? null,
      revision: 1,
      status: 'proposed',
      evidenceEventIds: [],
      changes: [],
      createdAt: input.at,
      updatedAt: input.at,
    };
    this.rows.push(commitment);
    const event: CommitmentEvent = {
      type: 'commitment_proposed',
      commitmentId: commitment.commitmentId,
      revision: 1,
      at: input.at,
      actorId: input.promisorId,
      payload: { goal: input.goal, fromId: input.promisorId,
        toId: input.beneficiaryId, conditions: commitment.conditions.join(';'),
        deadline: commitment.deadline ?? -1 },
    };
    return this.remember('request', input.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /** Step 2: the NPC answers; accept activates, decline ends, counter defers. */
  respond(commitmentId: string, verdict: 'accept' | 'decline' | 'counter',
    options: { at: number; reason?: string; terms?: CommitmentTerms; inputId?: string } = { at: 0 }):
    CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, verdict, reason: options.reason ?? '' });
    const replay = this.replay('respond', options.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, options.at,
      commitment.promisorId, options.inputId);
    if (replay) return replay;
    if (commitment.status !== 'proposed') {
      return this.remember('respond', options.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId, revision: commitment.revision,
          at: options.at, actorId: commitment.promisorId,
          payload: { reason: `status_${commitment.status}` } },
        reason: `status_${commitment.status}`,
      });
    }
    if (verdict === 'accept') {
      commitment.status = 'active';
      commitment.updatedAt = options.at;
      const event: CommitmentEvent = { type: 'commitment_accepted', commitmentId,
        revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
        payload: { fromId: commitment.promisorId, toId: commitment.beneficiaryId,
          text: options.reason ?? '接受请求' } };
      return this.remember('respond', options.inputId, digest,
        { commitment: structuredClone(commitment), event });
    }
    if (verdict === 'decline') {
      commitment.status = 'declined';
      commitment.updatedAt = options.at;
      const event: CommitmentEvent = { type: 'commitment_declined', commitmentId,
        revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
        payload: { fromId: commitment.promisorId, toId: commitment.beneficiaryId,
          text: options.reason ?? '拒绝请求' } };
      return this.remember('respond', options.inputId, digest,
        { commitment: structuredClone(commitment), event });
    }
    // counter = a conditional acceptance attempt: stays proposed, records the
    // proposal as a change the player must answer.
    const change: CommitmentChange = {
      changeId: `chg-${randomUUID()}`,
      proposedRevision: commitment.revision + 1,
      kind: 'defer',
      terms: options.terms ?? {},
      reason: options.reason ?? '先处理生存需要',
      proposedAt: options.at,
      status: 'open',
      respondedAt: null,
      responseEventId: null,
    };
    commitment.changes.push(change);
    commitment.updatedAt = options.at;
    const event: CommitmentEvent = { type: 'commitment_change_proposed', commitmentId,
      revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
      payload: { changeId: change.changeId, kind: change.kind, reason: change.reason,
        proposedRevision: change.proposedRevision, terms: JSON.stringify(change.terms) } };
    return this.remember('respond', options.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /**
   * The promisor asks to change terms (defer/suspend/alt-source). The
   * commitment becomes `pending-change`; nothing else moves until the
   * beneficiary answers explicitly.
   */
  proposeChange(commitmentId: string, change: { kind: ChangeKind; reason: string;
    terms?: CommitmentTerms; at: number; inputId?: string; evidenceEventIds?: string[] }):
    CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, kind: change.kind, reason: change.reason });
    const replay = this.replay('propose-change', change.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, change.at,
      commitment.promisorId, change.inputId);
    if (replay) return replay;
    if (!['active', 'suspended'].includes(commitment.status)) {
      return this.remember('propose-change', change.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_change_ignored', commitmentId,
          revision: commitment.revision, at: change.at, actorId: commitment.promisorId,
          payload: { reason: `status_${commitment.status}` } },
        reason: `status_${commitment.status}`,
      });
    }
    const row: CommitmentChange = {
      changeId: `chg-${randomUUID()}`,
      proposedRevision: commitment.revision + 1,
      kind: change.kind,
      terms: change.terms ?? {},
      reason: change.reason,
      proposedAt: change.at,
      status: 'open',
      respondedAt: null,
      responseEventId: null,
    };
    commitment.changes.push(row);
    commitment.status = 'pending-change';
    commitment.updatedAt = change.at;
    if (change.evidenceEventIds) commitment.evidenceEventIds.push(...change.evidenceEventIds);
    const event: CommitmentEvent = { type: 'commitment_change_proposed', commitmentId,
      revision: commitment.revision, at: change.at, actorId: commitment.promisorId,
      payload: { changeId: row.changeId, kind: row.kind, reason: row.reason,
        proposedRevision: row.proposedRevision, terms: JSON.stringify(row.terms) } };
    return this.remember('propose-change', change.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /**
   * The beneficiary answers a proposal. Accept updates revision/conditions
   * (suspend becomes `suspended`); reject restores `active` with the OLD terms.
   */
  respondChange(commitmentId: string, changeId: string, verdict: 'accept' | 'reject',
    options: { at: number; inputId?: string; reason?: string } = { at: 0 }): CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, changeId, verdict });
    const replay = this.replay('respond-change', options.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, options.at,
      commitment.promisorId, options.inputId);
    if (replay) return replay;
    const change = commitment.changes.find(row => row.changeId === changeId);
    if (!change || change.status !== 'open') {
      return this.remember('respond-change', options.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId, revision: commitment.revision,
          at: options.at, actorId: commitment.promisorId,
          payload: { reason: change ? `change_${change.status}` : 'unknown_change' } },
        reason: change ? `change_${change.status}` : 'unknown_change',
      });
    }
    if (verdict === 'reject') {
      change.status = 'rejected';
      change.respondedAt = options.at;
      commitment.status = 'active';
      commitment.updatedAt = options.at;
      const event: CommitmentEvent = { type: 'commitment_change_rejected', commitmentId,
        revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
        payload: { changeId, text: options.reason ?? '不同意调整，按原约定' } };
      change.responseEventId = event.type;
      return this.remember('respond-change', options.inputId, digest,
        { commitment: structuredClone(commitment), event });
    }
    change.status = 'accepted';
    change.respondedAt = options.at;
    commitment.revision += 1;
    commitment.status = change.kind === 'suspend' ? 'suspended' : 'active';
    commitment.updatedAt = options.at;
    if (change.kind === 'defer' && change.terms.until !== undefined) {
      commitment.deadline = change.terms.until;
    }
    if (change.kind === 'alt-source' && change.terms.source) {
      commitment.conditions = [...commitment.conditions, `source:${change.terms.source}`];
    }
    const event: CommitmentEvent = { type: 'commitment_change_accepted', commitmentId,
      revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
      payload: { changeId, kind: change.kind, revision: commitment.revision,
        status: commitment.status } };
    change.responseEventId = event.type;
    return this.remember('respond-change', options.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /** The promisor resumes a suspended commitment (agreed resume only). */
  resume(commitmentId: string, options: { at: number; inputId?: string;
    reason?: string } = { at: 0 }): CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, action: 'resume' });
    const replay = this.replay('resume', options.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, options.at,
      commitment.promisorId, options.inputId);
    if (replay) return replay;
    if (commitment.status !== 'suspended') {
      return this.remember('resume', options.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId, revision: commitment.revision,
          at: options.at, actorId: commitment.promisorId,
          payload: { reason: `status_${commitment.status}` } },
        reason: `status_${commitment.status}`,
      });
    }
    commitment.status = 'active';
    commitment.updatedAt = options.at;
    const event: CommitmentEvent = { type: 'commitment_resumed', commitmentId,
      revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
      payload: { text: options.reason ?? '条件允许，恢复约定' } };
    return this.remember('resume', options.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /** The promisor exits explicitly (never silent); relations move on evidence. */
  withdraw(commitmentId: string, options: { at: number; inputId?: string;
    reason?: string } = { at: 0 }): CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, action: 'withdraw' });
    const replay = this.replay('withdraw', options.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, options.at,
      commitment.promisorId, options.inputId);
    if (replay) return replay;
    if (TERMINAL.includes(commitment.status)) {
      return this.remember('withdraw', options.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId, revision: commitment.revision,
          at: options.at, actorId: commitment.promisorId,
          payload: { reason: `status_${commitment.status}` } },
        reason: `status_${commitment.status}`,
      });
    }
    commitment.status = 'withdrawn';
    commitment.updatedAt = options.at;
    const event: CommitmentEvent = { type: 'commitment_withdrawn', commitmentId,
      revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
      payload: { fromId: commitment.promisorId, toId: commitment.beneficiaryId,
        reason: options.reason ?? '明确退出', text: options.reason ?? '无法继续，明确退出' } };
    return this.remember('withdraw', options.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /** The beneficiary cancels; the promisor stops (no further attempts). */
  cancel(commitmentId: string, options: { at: number; inputId?: string;
    reason?: string } = { at: 0 }): CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, action: 'cancel' });
    const replay = this.replay('cancel', options.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, options.at,
      commitment.promisorId, options.inputId);
    if (replay) return replay;
    if (TERMINAL.includes(commitment.status)) {
      return this.remember('cancel', options.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId, revision: commitment.revision,
          at: options.at, actorId: commitment.promisorId,
          payload: { reason: `status_${commitment.status}` } },
        reason: `status_${commitment.status}`,
      });
    }
    commitment.status = 'cancelled';
    commitment.updatedAt = options.at;
    const event: CommitmentEvent = { type: 'commitment_cancelled', commitmentId,
      revision: commitment.revision, at: options.at, actorId: commitment.promisorId,
      payload: { fromId: commitment.promisorId, toId: commitment.beneficiaryId,
        text: options.reason ?? '玩家取消' } };
    return this.remember('cancel', options.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }

  /**
   * Fulfilment is ONLY reachable from an authoritative delivery receipt:
   * no dialogue, rule reason or wait can substitute for it.
   */
  fulfil(commitmentId: string, receipt: { eventId: string; commandId: string; at: number;
    amount: number; inputId?: string }): CommitmentResult {
    const commitment = this.find(commitmentId);
    if (!commitment) throw new Error(`unknown commitment ${commitmentId}`);
    const digest = JSON.stringify({ commitmentId, receiptEventId: receipt.eventId });
    const replay = this.replay('fulfil', receipt.inputId, digest);
    if (replay === 'conflict') return this.conflictEvent(commitment, receipt.at,
      commitment.promisorId, receipt.inputId);
    if (replay) return replay;
    if (commitment.status === 'fulfilled') {
      return this.remember('fulfil', receipt.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId,
          revision: commitment.revision, at: receipt.at, actorId: commitment.promisorId,
          payload: { reason: 'already_fulfilled' } },
        reason: 'already_fulfilled',
      });
    }
    if (!['active', 'pending-change', 'suspended'].includes(commitment.status)) {
      return this.remember('fulfil', receipt.inputId, digest, {
        commitment: structuredClone(commitment),
        event: { type: 'commitment_response_ignored', commitmentId,
          revision: commitment.revision, at: receipt.at, actorId: commitment.promisorId,
          payload: { reason: `status_${commitment.status}` } },
        reason: `status_${commitment.status}`,
      });
    }
    commitment.status = 'fulfilled';
    commitment.updatedAt = receipt.at;
    commitment.evidenceEventIds.push(receipt.eventId);
    const event: CommitmentEvent = { type: 'commitment_fulfilled', commitmentId,
      revision: commitment.revision, at: receipt.at, actorId: commitment.promisorId,
      payload: { fromId: commitment.promisorId, toId: commitment.beneficiaryId,
        receiptEventId: receipt.eventId, receiptCommandId: receipt.commandId,
        amount: receipt.amount, promiseId: `cm-${commitment.commitmentId}`,
        text: '按约定送达' } };
    return this.remember('fulfil', receipt.inputId, digest,
      { commitment: structuredClone(commitment), event });
  }
}
