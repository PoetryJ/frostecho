/** Existing commitment/task ledgers become goals of the one R8 choice loop.
 * This adapter has no queue and never chooses or executes a world action.
 */
import { canonicalJson, sha256Hex, type Candidate } from '../../decision/contracts';
import type { GameplayLoop } from '../../gameplay-v2/loop';
import { isTerminal, type Commitment } from '../../gameplay-v2/commitments';
import { resumeReady } from '../../gameplay-v2/negotiation';
import type { GameplayTask } from '../../gameplay-v2/tasks';
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

export function createCommitmentBridge(runtime: R8Runtime, play: GameplayLoop): CommitmentGoalBridge {
  if (runtime.session !== play.session) throw new Error('commitment bridge requires one shared session');
  const rows = (actorId: string) => play.commitments.all()
    .filter(row => row.promisorId === actorId
      && ['deliver-meal', 'supply-warehouse'].includes(row.goal) && !isTerminal(row.status))
    .sort((a, b) => a.createdAt - b.createdAt || a.commitmentId.localeCompare(b.commitmentId));

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
    if (commitment.status !== 'active' || commitment.goal !== 'deliver-meal'
      || commitment.changes.some(change => change.kind === 'alt-source' && change.status !== 'rejected')) return;
    const result = play.commitments.proposeChange(commitment.commitmentId, {
      kind: 'alt-source', reason: 'warehouse-empty',
      terms: { source: 'gather', reason: '亲见仓库缺货，我采集后补仓，再把饭送来' },
      at: runtime.world.simTime, evidenceEventIds: eventIds });
    runtime.session.ingestCommitmentEvent(result.event);
  };

  return {
    view(actorId) {
      const npc = runtime.world.npcs[actorId];
      const goals: unknown[] = [], candidates: Candidate[] = [];
      for (const commitment of rows(actorId)) {
        const task = commitment.taskId ? play.board.find(commitment.taskId) : undefined;
        const ready = Boolean(npc?.alive && task?.status === 'active'
          && task.commitmentId === commitment.commitmentId && task.actorId === actorId
          && commitment.status === 'active' && resumeReady(npc, commitment));
        goals.push({ source: 'legacy-commitment', taskId: commitment.taskId,
          legacyTaskId: commitment.taskId, commitmentId: commitment.commitmentId,
          revision: commitment.revision, type: commitment.goal === 'deliver-meal' ? 'DELIVER_MEAL' : 'SUPPLY_WAREHOUSE',
          status: commitment.status, taskStatus: task?.status ?? 'missing', ready,
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
          candidates.push(runtime.world.resources.food < 1
            ? make('gather', '为已接受的补仓承诺采集食物', { resource: 'food', amount: 2, bridgeStep: 'gather' })
            : !atWarehouse ? make('move', '前往仓库履行补仓承诺', { to: 'warehouse', purpose: 'travel', bridgeStep: 'to-warehouse' })
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
        if (stock === 0 && !alternative) {
          candidates.push(make('report-delay', '说明亲见缺货，提议改为采集后送饭，等待玩家同意',
            { note: 'warehouse-empty', bridgeStep: 'propose-alt-source' }));
          continue;
        }
        if (alternative) {
          const last = progressEvents(runtime, commitment).filter(event =>
            ['gathered', 'stock_deposited', 'stock_withdrawn', 'out_of_stock'].includes(event!.type)).at(-1);
          if (!last || !['gathered', 'stock_deposited'].includes(last.type)) {
            candidates.push(make('gather', '按已同意的新来源采集食物',
              { resource: 'food', amount: 2, bridgeStep: 'gather' }));
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

    afterCommit(actorId, candidate, eventIds) {
      const bound = binding(actorId, candidate);
      if (!bound) return;
      const { commitment, task } = bound;
      const events = eventIds.map(id => runtime.committedEvent(id))
        .filter(event => event !== null && event.actorId === actorId);
      if (candidate.parameters.bridgeStep === 'propose-alt-source' && personalStock(runtime, actorId) === 0) {
        proposeShortage(commitment, []);
        return;
      }
      if (!events.length) return;
      const at = runtime.world.simTime;
      // Provenance, not a separate plan/state machine: replay the real receipts
      // to discover whether the agreed gather/deposit phase already happened.
      runtime.session.memories.get(actorId)!.append({
        eventId: `bridge:${commitment.commitmentId}:r${commitment.revision}:${events[0]!.eventId}`,
        observerId: actorId, occurredAt: at, observedAt: at,
        kind: 'commitment_action_committed', source: 'engine', authority: 'engine',
        subjectIds: [actorId, commitment.beneficiaryId], sourceEventIds: events.map(event => event!.eventId),
        relatedRequestId: commitment.commitmentId,
        payload: { commitmentId: commitment.commitmentId, revision: commitment.revision,
          legacyTaskId: task.taskId, action: candidate.parameters.action } });
      const shortage = events.find(event => event!.type === 'out_of_stock'
        || (event!.type === 'warehouse_stock_observed' && Number(event!.payload.remaining) === 0));
      if (shortage) proposeShortage(commitment, [shortage.eventId]);
      const receiptType = commitment.goal === 'deliver-meal' ? 'meal_delivered' : 'stock_deposited';
      const receipt = events.find(event => event!.type === receiptType
        && Number.isFinite(event!.payload.amount) && Number(event!.payload.amount) >= 1
        && (receiptType === 'meal_delivered' ? event!.payload.to === 'kitchen' : event!.payload.place === 'warehouse'));
      if (!receipt || commitment.status !== 'active') return;
      const result = play.commitments.fulfil(commitment.commitmentId, {
        eventId: receipt.eventId, commandId: receipt.eventId.split(`:${receipt.type}:`)[0],
        at, amount: Number(receipt.payload.amount), inputId: `bridge-fulfil:${receipt.eventId}` });
      if (result.commitment.status !== 'fulfilled' || !result.commitment.evidenceEventIds.includes(receipt.eventId)) return;
      play.board.complete(task.taskId);
      runtime.session.ingestCommitmentEvent(result.event);
    },
  };
}
