/** Existing commitment/task ledgers become goals of the one R8 choice loop.
 * This adapter has no queue and never chooses or executes a world action.
 *
 * Two rules make the adapter honest:
 *   - the goal/candidate view is a pure function of THIS actor's own records,
 *     never of engine truth, so an unheard terminal state cannot leak through a
 *     marker such as `unheard-cancellation`;
 *   - the committed receipt, not the offered candidate, is what fulfils the
 *     promise, and that projection is replayed from the persisted intent after
 *     a restore instead of relying on a process-local callback.
 */
import { canonicalJson, sha256Hex, type Candidate } from '../../decision/contracts';
import type { GameplayLoop } from '../../gameplay-v2/loop';
import { isTerminal, type Commitment } from '../../gameplay-v2/commitments';
import { resumeReady } from '../../gameplay-v2/negotiation';
import type { GameplayTask } from '../../gameplay-v2/tasks';
import type { ActionIntent } from './action-intent';
import type { R8Runtime } from './runtime';

export interface CommitmentGoalBridge {
  view(actorId: string): { goals: unknown[]; candidates: Candidate[] };
  afterCommit(actorId: string, candidate: Candidate, eventIds: string[]): void;
}

/** References to actual actor receipts survive restart in the existing memory. */
function progressEvents(runtime: R8Runtime, commitment: Commitment) {
  const records = runtime.session.memories.get(commitment.promisorId)?.toJSON().records ?? [];
  return records.filter(record => record.kind === 'commitment_action_committed'
    && record.observerId === commitment.promisorId && record.authority === 'engine')
    .flatMap(record => {
      const payload = record.payload as Record<string, unknown>;
      if (payload.commitmentId !== commitment.commitmentId || payload.revision !== commitment.revision)
        return [];
      return record.sourceEventIds.map(id => runtime.committedEvent(id))
        .filter(event => event !== null && event.actorId === commitment.promisorId);
    });
}

function personalStock(runtime: R8Runtime, actorId: string): number | null {
  const records = runtime.session.memories.get(actorId)?.toJSON().records ?? [];
  for (const record of [...records].reverse()) {
    if (record.observerId !== actorId || record.source !== 'engine') continue;
    if (!['out_of_stock', 'stock_withdrawn', 'stock_deposited', 'warehouse_stock_observed',
      'stock_restocked'].includes(record.kind)) continue;
    const payload = record.payload as Record<string, unknown>;
    const amount = payload.remaining ?? payload.total;
    if (typeof amount === 'number' && Number.isFinite(amount)) return amount;
    if (record.kind === 'out_of_stock') return 0;
  }
  return null;
}

function option(commitment: Commitment, task: GameplayTask, action: string,
  description: string, parameters: Record<string, unknown>, preconditions: string[]): Candidate {
  const bound = { action, ...parameters, legacyTaskId: task.taskId,
    commitmentId: commitment.commitmentId, commitmentRevision: commitment.revision };
  return { id: `b-${sha256Hex(canonicalJson(bound)).slice(0, 16)}`, kind: action,
    description, parameters: bound, preconditions, expectedEffects: {}, utilityComponents: {} };
}

/** The terminal kinds a promisor can only know because it was told/observed. */
const TERMINAL_KINDS = ['commitment_cancelled', 'commitment_declined',
  'commitment_withdrawn', 'commitment_fulfilled'];

const TERMINAL_STATUS: Record<string, string> = {
  commitment_cancelled: 'cancelled', commitment_declined: 'declined',
  commitment_withdrawn: 'withdrawn', commitment_fulfilled: 'fulfilled',
};

/**
 * What THIS actor's own memory says about the end of this commitment. A null
 * answer means it has no terminal evidence, so for it the promise is still
 * alive; the engine row may be terminal and that must not be visible here.
 */
function ownTerminalKind(runtime: R8Runtime, actorId: string,
  commitment: Commitment): string | null {
  const records = runtime.session.memories.get(actorId)?.toJSON().records ?? [];
  const record = [...records].reverse().find(entry => entry.observerId === actorId
    && TERMINAL_KINDS.includes(entry.kind)
    && String((entry.payload as Record<string, unknown>).commitmentId) === commitment.commitmentId);
  return record ? record.kind : null;
}

export function createCommitmentBridge(runtime: R8Runtime, play: GameplayLoop): CommitmentGoalBridge {
  if (runtime.session !== play.session) throw new Error('commitment bridge requires one shared session');

  /** The actor's own view of its commitments, derived from its records only. */
  const rows = (actorId: string) => play.commitments.all()
    .filter(row => row.promisorId === actorId
      && ['deliver-meal', 'supply-warehouse'].includes(row.goal))
    .map(row => ({ row, terminal: ownTerminalKind(runtime, actorId, row) }))
    .sort((a, b) => a.row.createdAt - b.row.createdAt
      || a.row.commitmentId.localeCompare(b.row.commitmentId));

  const binding = (actorId: string, candidate: Candidate) => {
    const p = candidate.parameters;
    const commitment = play.commitments.find(String(p.commitmentId ?? ''));
    const task = play.board.find(String(p.legacyTaskId ?? ''));
    if (!commitment || !task || commitment.status !== 'active' || task.status !== 'active'
      || commitment.promisorId !== actorId || task.actorId !== actorId
      || task.commitmentId !== commitment.commitmentId || commitment.taskId !== task.taskId
      || commitment.revision !== p.commitmentRevision || task.kind !== commitment.goal)
      return null;
    return { commitment, task };
  };

  const proposeShortage = (commitment: Commitment, eventIds: string[]) => {
    // One source proposal per commitment, ever: a rejected proposal is the
    // beneficiary's explicit answer ("按原约定"), not an invitation to re-ask.
    if (commitment.status !== 'active' || commitment.goal !== 'deliver-meal'
      || commitment.changes.some(change => change.kind === 'alt-source')) return;
    const result = play.commitments.proposeChange(commitment.commitmentId, {
      kind: 'alt-source', reason: 'warehouse-empty',
      terms: { source: 'gather', reason: '亲见仓库缺货，我采集后补仓，再把饭送来' },
      at: runtime.world.simTime, evidenceEventIds: eventIds });
    runtime.session.ingestCommitmentEvent(result.event);
  };

  /**
   * Apply one committed receipt to the commitment/task ledger. Deterministic
   * from (commitmentId, revision, receiptId), so replay after a restore is
   * safe; the memory write is de-duplicated by its own event id.
   */
  const applyReceipt = (claim: NonNullable<ActionIntent['projections'][number]>,
    intent: Pick<ActionIntent, 'actorId' | 'candidate'> & { commitmentRevision?: number | null;
      intentId?: string }): boolean => {
    const commitment = play.commitments.find(claim.id);
    if (!commitment) return false;
    const task = commitment.taskId ? play.board.find(commitment.taskId) : undefined;
    const receipt = runtime.committedEvent(claim.receiptId);
    if (!receipt || receipt.actorId !== intent.actorId) return false;
    // Record the real action in the actor's own memory, carrying provenance.
    runtime.session.memories.get(intent.actorId)?.append({
      eventId: `bridge:${commitment.commitmentId}:r${intent.commitmentRevision ?? commitment.revision}`
        + `:${receipt.eventId}`,
      observerId: intent.actorId, occurredAt: receipt.simTime, observedAt: runtime.world.simTime,
      kind: 'commitment_action_committed', source: 'engine', authority: 'engine',
      subjectIds: [intent.actorId, commitment.beneficiaryId],
      sourceEventIds: [receipt.eventId],
      relatedRequestId: commitment.commitmentId,
      payload: { commitmentId: commitment.commitmentId,
        revision: intent.commitmentRevision ?? commitment.revision,
        legacyTaskId: task?.taskId ?? null, action: intent.candidate.parameters.action } });
    const shortage = receipt.type === 'out_of_stock'
      || (receipt.type === 'warehouse_stock_observed' && Number(receipt.payload.remaining) === 0);
    if (shortage) proposeShortage(commitment, [receipt.eventId]);
    const receiptType = commitment.goal === 'deliver-meal' ? 'meal_delivered' : 'stock_deposited';
    const matches = receipt.type === receiptType
      && Number.isFinite(Number(receipt.payload.amount)) && Number(receipt.payload.amount) >= 1
      && (receiptType === 'meal_delivered' ? receipt.payload.to === 'kitchen'
        : receipt.payload.place === 'warehouse');
    if (!matches || task === undefined) return false;
    // A withdrawn authorisation keeps the world's answer: no fulfilment.
    if (commitment.status !== 'active') return false;
    const result = play.commitments.fulfil(commitment.commitmentId, {
      eventId: receipt.eventId, commandId: receipt.eventId.split(`:${receipt.type}:`)[0],
      at: runtime.world.simTime, amount: Number(receipt.payload.amount),
      inputId: `bridge-fulfil:${receipt.eventId}` });
    if (result.commitment.status !== 'fulfilled'
      || !result.commitment.evidenceEventIds.includes(receipt.eventId)) return false;
    play.board.complete(task.taskId);
    runtime.session.ingestCommitmentEvent(result.event);
    return true;
  };

  // Authorisation: the world withdraws it on cancel/timeout/revision change;
  // the promisor's belief is a separate, own-record question handled in `view`.
  runtime.registerIntentGuard(intent => {
    if (!intent.commitmentId) return null;
    const commitment = play.commitments.find(intent.commitmentId);
    if (!commitment) return 'commitment_missing';
    if (isTerminal(commitment.status)) return `commitment_${commitment.status}`;
    if (intent.commitmentRevision !== null && commitment.revision !== intent.commitmentRevision)
      return 'commitment_revision_changed';
    return null;
  });
  runtime.registerIntentProjector((claim, intent) =>
    claim.kind === 'commitment' ? applyReceipt(claim, intent) : false);
  // A new process restores the intent queue; replay what the ledger still owes.
  runtime.replayPendingProjections();
  play.onCommitmentCancelled(commitmentId => runtime.cancelForCommitment(commitmentId,
    'commitment_cancelled'));

  return {
    view(actorId) {
      const npc = runtime.world.npcs[actorId];
      const goals: unknown[] = [], candidates: Candidate[] = [];
      for (const { row: commitment, terminal } of rows(actorId)) {
        const task = commitment.taskId ? play.board.find(commitment.taskId) : undefined;
        // While a change is pending the promisor is NOT working under the new
        // terms: only the originally agreed path may be offered.
        const pendingChange = commitment.status === 'pending-change';
        // The actor's own status: what its records establish, nothing more.
        const heardStatus = terminal ? TERMINAL_STATUS[terminal] ?? 'active' : 'active';
        // An actor that has not heard the end still believes the promise is
        // alive, so its task stays usable for it; a heard terminal stops it.
        const taskUsable = !terminal && task !== undefined;
        const ready = Boolean(npc?.alive && taskUsable
          && (terminal === null) && resumeReady(npc, commitment));
        goals.push({ source: 'legacy-commitment', taskId: commitment.taskId,
          legacyTaskId: commitment.taskId, commitmentId: commitment.commitmentId,
          revision: commitment.revision, type: commitment.goal === 'deliver-meal' ? 'DELIVER_MEAL' : 'SUPPLY_WAREHOUSE',
          status: heardStatus, ready,
          conditions: [...commitment.conditions], deadline: commitment.deadline,
          beneficiaryId: commitment.beneficiaryId });
        if (!ready || !task || !npc) continue;
        const make = (action: string, description: string, parameters: Record<string, unknown> = {},
          preconditions: string[] = []) => option(commitment, task, action, description, parameters,
          ['alive', 'accepted commitment revision unchanged', ...preconditions]);
        const atWarehouse = npc.location === 'warehouse', atKitchen = npc.location === 'kitchen';
        const carry = runtime.world.spatial?.carry[actorId]?.meals ?? 0;
        const stock = personalStock(runtime, actorId);
        if (commitment.goal === 'supply-warehouse') {
          if (runtime.world.resources.food < 1) {
            // Gathering happens at the village site: walk there first.
            candidates.push(npc.location === 'village'
              ? make('gather', '为已接受的补仓承诺采集食物', { resource: 'food', amount: 2, bridgeStep: 'gather' })
              : make('move', '去村里为补仓承诺采集食物', { to: 'village', purpose: 'travel', bridgeStep: 'to-village-alt' }));
            continue;
          }
          candidates.push(!atWarehouse
            ? make('move', '前往仓库履行补仓承诺', { to: 'warehouse', purpose: 'travel', bridgeStep: 'to-warehouse' })
            : make('deposit', '将一份公共食物实际交存仓库', { place: 'warehouse', amount: 1, bridgeStep: 'deposit' }, ['public food >= 1']));
          continue;
        }
        if (carry >= 1) {
          candidates.push(atKitchen
            ? make('deliver', '把携带的饭送达厨房，完成这份送饭承诺', { to: 'kitchen', amount: 1, bridgeStep: 'deliver' }, ['carrying meals >= 1'])
            : make('move', '携带饭前往厨房履约', { to: 'kitchen', purpose: 'travel', bridgeStep: 'to-kitchen' }));
          continue;
        }
        const alternative = commitment.changes.some(change => change.kind === 'alt-source'
          && change.status === 'accepted' && change.terms.source === 'gather');
        const rejectedAlternative = commitment.changes.some(change =>
          change.kind === 'alt-source' && change.status === 'rejected');
        if (stock === 0 && !alternative) {
          if (pendingChange) {
            // The proposal is already open and unanswered: never act on the
            // un-agreed source, and never re-run the withdraw that just failed
            // (a second identical out_of_stock is a repeated invalid action).
            candidates.push(make('report-delay', '改源答复未到，说明现状并等待，不再空取',
              { note: 'await-change-answer', bridgeStep: 'await-answer' }));
            continue;
          }
          if (rejectedAlternative) {
            // The beneficiary refused the new source: stay on the original
            // terms, report the shortage, and do not spend another attempt on
            // a withdrawal that is known to fail.
            candidates.push(make('report-delay', '按原约定等待补货，并说明当前无法取餐',
              { note: 'rejected-source-shortage', bridgeStep: 'rejected-source-shortage' }));
            continue;
          }
          candidates.push(make('report-delay', '说明亲见缺货，提议改为采集后送饭，等待玩家同意',
            { note: 'warehouse-empty', bridgeStep: 'propose-alt-source' }));
          continue;
        }
        if (alternative && !pendingChange) {
          const last = progressEvents(runtime, commitment).filter(event =>
            ['gathered', 'stock_deposited', 'stock_withdrawn', 'out_of_stock'].includes(event!.type)).at(-1);
          if (!last || !['gathered', 'stock_deposited'].includes(last.type)) {
            // The agreed new source is gathered at its real site; the walk is a
            // real action, not an instant teleport inside the work step.
            candidates.push(npc.location === 'village'
              ? make('gather', '按已同意的新来源采集食物',
                { resource: 'food', amount: 2, bridgeStep: 'gather' })
              : make('move', '按已同意的新来源去村里采集食物',
                { to: 'village', purpose: 'travel', bridgeStep: 'to-village-alt' }));
            continue;
          }
          if (last.type === 'gathered') {
            candidates.push(!atWarehouse
              ? make('move', '带着采集成果前往仓库交存', { to: 'warehouse', purpose: 'travel', bridgeStep: 'to-warehouse' })
              : make('deposit', '把采集成果交存仓库，准备取餐送达',
                { place: 'warehouse', amount: 1, bridgeStep: 'deposit' }, ['public food >= 1']));
            continue;
          }
        }
        candidates.push(atWarehouse
          ? make('withdraw', '从仓库取一份饭用于当前送饭承诺', { place: 'warehouse', amount: 1, bridgeStep: 'withdraw' })
          : make('move', '去仓库亲自核实并领取承诺要送的饭',
            { to: 'warehouse', purpose: 'verify-stock', bridgeStep: 'to-warehouse' }));
      }
      return { goals, candidates };
    },

    /** Instant (zero-duration) actions still report their own receipt here. */
    afterCommit(actorId, candidate, eventIds) {
      const bound = binding(actorId, candidate);
      if (!bound) return;
      const { commitment } = bound;
      if (candidate.parameters.bridgeStep === 'propose-alt-source'
        && personalStock(runtime, actorId) === 0) {
        proposeShortage(commitment, []);
        return;
      }
      const events = eventIds.map(id => runtime.committedEvent(id))
        .filter(event => event !== null && event.actorId === actorId);
      // Shortage first: a real out_of_stock is what opens the source change.
      const shortage = events.find(event => event!.type === 'out_of_stock'
        || (event!.type === 'warehouse_stock_observed'
          && Number(event!.payload.remaining) === 0));
      const fulfilment = events.find(event => event!.type === (commitment.goal === 'deliver-meal'
        ? 'meal_delivered' : 'stock_deposited'));
      for (const receipt of [shortage, fulfilment]) {
        if (!receipt) continue;
        applyReceipt({ kind: 'commitment', id: commitment.commitmentId,
          revision: commitment.revision, receiptId: receipt.eventId, applied: false,
          appliedAt: null }, { intentId: `instant:${receipt.eventId}`, actorId,
          commitmentRevision: commitment.revision, candidate });
      }
    },
  };
}
