/**
 * R11 (H) metrics, recomputed from the complete append-only evidence:
 *   decisions-*.jsonl  every choice actually scored/executed
 *   work-*.json        runtime.workLog (every intent that reached a terminal state)
 *   receipts-*.json    every committed event (the only fulfilment evidence)
 *   memories-*.json    what each actor actually observed (heard/unheard)
 *   interference.json  when each story was offered and to whom
 *
 * Nothing is read from a truncated `runtime.intents` window alone. Missing
 * evidence is `null`, never 0.
 */

export const METRIC_SPEC = {
  schema: 'frostecho.r11.metric-spec/1',
  primary: {
    id: 'verified_fulfilment_rate_per_instance',
    numerator: 'commitment instances with >=1 authoritative receipt of the goal type, actor and place, within their own revision',
    denominator: 'all commitment instances created in the game (initial + checkpoint/follow-up delegations)',
    nullPolicy: 'if a game has 0 instances -> null (not 0)',
  },
  secondary: [
    'overdue_rate_per_instance', 'authorised_exit_rate_per_instance',
    'post_cancel_late_physical_effects', 'post_cancel_unauthorised_attempts',
    'unagreed_source_actions', 'duplicate_receipts', 'settlement_failures_by_reason',
    'contention_resolved_with_receipt', 'restock_witnessed_then_fulfilled',
    'work_hours_per_instance', 'survivors', 'ending',
    'final_inventory_hours', 'four_day_resource_gap_hours',
  ],
  exposure: {
    notExposed: 'null / not_exposed when the pre-registered story precondition never'
      + ' coexisted with an active instance (legal early completion included)',
  },
  rates: {
    foodPerHour: 7.2,
    firewoodPerHour: 0.4,
    powerPerHour: 2,
    note: 'food: 8 NPCs x 0.9 hunger/h, 1 food == 1 hunger in survival-rules/2; '
      + 'firewood: furnace burn 0.4/h in evolveSpan; power: heating reserve denominator (2/h) '
      + 'used by the R10 coverage report, not a physical drain.',
  },
  gap: {
    definition: 'hours in [start,end) where the authoritative level is <= 0, '
      + 'integrating the sampled timeline with the left-hand value',
  },
  tolerance: 'no statistical claim from 2 seeds; report per-seed pairs and their difference',
};

const GOAL_RECEIPT = { 'deliver-meal': 'meal_delivered', 'supply-warehouse': 'stock_deposited' };
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const round = (value, digits = 3) => value === null ? null : Number(value.toFixed(digits));

function receiptMatches(row, receipt) {
  if (!receipt) return false;
  const type = GOAL_RECEIPT[row.goal];
  if (!type || receipt.type !== type) return false;
  if (receipt.actorId !== row.promisorId) return false;
  if (Number(receipt.payload?.amount ?? 0) < 1) return false;
  if (row.goal === 'deliver-meal') return receipt.payload?.to === 'kitchen';
  return receipt.payload?.place === 'warehouse';
}

/** intentId -> {commitmentId, revision, candidate} from the decisions log. */
export function intentBindings(decisions) {
  const out = new Map();
  for (const record of decisions) {
    if (typeof record.worldVersion !== 'number' || !record.actorId) continue;
    const intentId = `${record.actorId}-r8-${record.worldVersion}`;
    const selected = (record.candidates ?? []).find(candidate => candidate.id === record.selectedId);
    const parameters = selected?.parameters ?? {};
    out.set(intentId, {
      commitmentId: typeof parameters.commitmentId === 'string' ? parameters.commitmentId : null,
      commitmentRevision: typeof parameters.commitmentRevision === 'number'
        ? parameters.commitmentRevision : null,
      action: String(parameters.action ?? selected?.kind ?? record.reason ?? ''),
      bridgeStep: typeof parameters.bridgeStep === 'string' ? parameters.bridgeStep : null,
      candidateId: record.selectedId ?? null,
      requestId: record.requestId ?? null,
      phase: record.phase ?? null,
    });
  }
  return out;
}

function terminalWork(workLog, finalIntents) {
  const rows = new Map();
  for (const row of workLog ?? []) rows.set(row.intentId, { ...row, source: 'workLog' });
  for (const intent of finalIntents ?? []) {
    if (rows.has(intent.intentId)) continue;
    rows.set(intent.intentId, { intentId: intent.intentId, actorId: intent.actorId,
      kind: String(intent.candidate?.parameters?.action ?? ''), startedAt: intent.startedAt,
      endsAt: intent.dueAt, settledAt: intent.settledAt ?? null, status: intent.status,
      eventIds: [...(intent.receiptIds ?? [])], failureReason: intent.failureReason ?? null,
      source: 'intent' });
  }
  return [...rows.values()];
}

function heardAt(records, commitmentId, kinds) {
  let at = null;
  for (const record of records ?? []) {
    if (!kinds.includes(record.kind)) continue;
    if (String(record.payload?.commitmentId ?? '') !== commitmentId) continue;
    if (at === null || record.observedAt < at) at = record.observedAt;
  }
  return at;
}

function recordAt(records, commitmentId, kind) {
  const hits = (records ?? []).filter(record => record.kind === kind
    && String(record.payload?.commitmentId ?? '') === commitmentId);
  if (hits.length === 0) return null;
  return Math.min(...hits.map(record => record.observedAt));
}

/**
 * @param {object} input
 * @param {object[]} input.initialCommitments rows persisted at D2 (or at start when no D2)
 * @param {object[]} input.finalCommitments
 * @param {object[]} input.decisions
 * @param {object[]} input.workLog
 * @param {object[]} input.finalIntents
 * @param {object[]} input.receipts
 * @param {object} input.memories actorId -> MemoryStore.toJSON()
 * @param {object[]} input.timeline [{at, resources}]
 * @param {object} input.interference
 * @param {object[]} input.delegations [{commitmentId, origin, at}]
 * @param {object} input.clock {start, end}
 */
export function collectInstanceMetrics(input) {
  const rows = input.finalCommitments ?? [];
  const initialById = new Map((input.initialCommitments ?? [])
    .map(row => [row.commitmentId, row]));
  const delegationById = new Map((input.delegations ?? [])
    .map(row => [row.commitmentId, row]));
  const saveActiveIds = new Set(input.saveActiveIds ?? []);
  const bindings = intentBindings(input.decisions ?? []);
  const work = terminalWork(input.workLog, input.finalIntents);
  const receipts = input.receipts ?? [];
  const receiptById = new Map(receipts.map(row => [row.eventId, row]));
  const end = input.clock?.end ?? 0;
  const interference = input.interference ?? { stories: [] };
  const restockStory = (interference.stories ?? []).find(entry => entry.kind === 'restock') ?? null;

  const instances = rows.map(row => {
    const initial = initialById.get(row.commitmentId) ?? null;
    const delegation = delegationById.get(row.commitmentId) ?? null;
    const origin = delegation?.origin ?? initial?.origin ?? (initial ? 'initial' : 'unknown');
    const records = input.memories?.[row.promisorId]?.records ?? [];
    const ownIntents = work.filter(intent => {
      const binding = bindings.get(intent.intentId);
      return binding?.commitmentId === row.commitmentId;
    });
    const byStatus = {};
    for (const intent of ownIntents) byStatus[intent.status] = (byStatus[intent.status] ?? 0) + 1;
    const workMinutes = ownIntents.filter(intent => intent.status === 'applied')
      .reduce((sum, intent) => sum + Math.max(0, intent.endsAt - intent.startedAt), 0);

    const evidence = row.evidenceEventIds ?? [];
    const verified = evidence.map(id => receiptById.get(id)).filter(receipt => receiptMatches(row, receipt));
    const cancelRecords = (records ?? []).filter(record => record.kind === 'commitment_cancelled'
      && String(record.payload?.commitmentId ?? '') === row.commitmentId)
      .sort((a, b) => a.observedAt - b.observedAt);
    const heardCancelAt = cancelRecords.length ? cancelRecords[0].observedAt : null;
    const relayRecord = cancelRecords.find(record => typeof record.payload?.relayedBy === 'string') ?? null;
    const cancelStory = (interference.stories ?? []).filter(entry => entry.kind === 'cancel'
      && entry.target?.commitmentId === row.commitmentId);
    const cancelAt = row.status === 'cancelled' ? row.updatedAt : null;
    const after = cancelAt ?? Infinity;
    const attemptsAfter = ownIntents.filter(intent => intent.startedAt >= after);
    const effectsAfter = ownIntents.filter(intent => intent.status === 'applied'
      && Number(intent.settledAt ?? -1) > after);
    const receiptsAfter = receipts.filter(receipt => receipt.simTime > after
      && receipt.actorId === row.promisorId
      && receiptMatches(row, receipt));
    const change = (row.changes ?? [])[0] ?? null;
    const unagreedFrom = change && change.status !== 'accepted' ? change.proposedAt : Infinity;
    const unagreedActions = ownIntents.filter(intent => {
      if (intent.startedAt < unagreedFrom) return false;
      const binding = bindings.get(intent.intentId);
      if (!binding || binding.commitmentId !== row.commitmentId) return false;
      return ['gather', 'deposit'].includes(binding.action)
        && ['gather', 'to-village-alt'].includes(binding.bridgeStep ?? '');
    });
    const ownReceiptEvents = ownIntents.flatMap(intent => (intent.eventIds ?? [])
      .map(id => receiptById.get(id)).filter(Boolean));
    const shortageReceipts = ownReceiptEvents.filter(receipt => receipt.type === 'out_of_stock')
      .sort((a, b) => a.simTime - b.simTime);
    const restock = (records ?? []).filter(record => record.kind === 'stock_restocked'
      && (restockStory === null || record.observedAt >= restockStory.at))
      .sort((a, b) => a.observedAt - b.observedAt)[0] ?? null;
    const contentionStory = (interference.stories ?? []).find(entry => entry.kind === 'contention'
      && (entry.targets ?? []).some(target => target.commitmentId === row.commitmentId));
    const contentionTarget = contentionStory?.targets
      ?.find(target => target.commitmentId === row.commitmentId) ?? null;

    return {
      commitmentId: row.commitmentId, promisorId: row.promisorId, goal: row.goal,
      origin, taskId: row.taskId,
      createdAt: row.createdAt, deadline: row.deadline, revision: row.revision,
      status: row.status, terminalAt: ['fulfilled', 'cancelled', 'declined', 'withdrawn']
        .includes(row.status) ? row.updatedAt : null,
      exposure: {
        activeAtSave: saveActiveIds.has(row.commitmentId),
        boundWorkAtSave: saveActiveIds.has(row.commitmentId)
          ? (initial?.boundWorkingIntents?.length ?? 0) : 0,
        cancelHeardOpportunity: cancelStory.some(entry => entry.mode === 'heard'),
        cancelUnheardOpportunity: cancelStory.some(entry => entry.mode === 'unheard'),
        cancelHeardAt: heardCancelAt,
        cancelRelayedAt: relayRecord ? relayRecord.observedAt : null,
        changeProposedOpportunity: Boolean(change),
        restockOpportunityAt: restockStory?.appliedAt ?? null,
        restockWitnessedAt: restock ? restock.observedAt : null,
        contentionOpportunityAt: contentionStory?.at ?? null,
      },
      fulfilment: {
        verified: verified.length >= 1, receipts: verified.map(receipt => receipt.eventId),
        at: verified.length ? Math.min(...verified.map(receipt => receipt.simTime)) : null,
        withinDeadline: verified.length && row.deadline !== null
          ? Math.min(...verified.map(receipt => receipt.simTime)) <= row.deadline : null,
        withoutReceipt: row.status === 'fulfilled' && verified.length === 0,
      },
      overdue: row.status !== 'fulfilled' && row.deadline !== null && end > row.deadline,
      authorisedExit: row.status === 'withdrawn',
      exitReason: row.status === 'withdrawn'
        ? (records ?? []).filter(record => record.kind === 'commitment_withdrawn'
          && String(record.payload?.commitmentId ?? '') === row.commitmentId)
          .map(record => record.payload?.reason ?? null).at(-1) ?? null : null,
      cancel: cancelAt === null ? null : {
        at: cancelAt, heardAt: heardCancelAt, relayedAt: relayRecord?.observedAt ?? null,
        heardByPromisor: heardCancelAt !== null,
        boundIntentsCancelled: ownIntents.filter(intent => intent.status === 'cancelled'
          && Number(intent.settledAt ?? -1) >= cancelAt).length,
        attemptsAfter: attemptsAfter.length,
        receiptsAfter: receiptsAfter.length,
        latePhysicalEffects: effectsAfter.length,
        lateReceiptIds: receiptsAfter.map(receipt => receipt.eventId),
      },
      change: change === null ? null : {
        kind: change.kind, status: change.status, proposedAt: change.proposedAt,
        respondedAt: change.respondedAt, proposedRevision: change.proposedRevision,
        revisionAfter: row.revision, accepted: change.status === 'accepted',
        source: change.terms?.source ?? null,
        unagreedSourceActions: unagreedActions.length,
      },
      shortage: { firstObservedAt: shortageReceipts.length ? shortageReceipts[0].simTime : null,
        observationCount: shortageReceipts.length },
      restock: { witnessedAt: restock ? restock.observedAt : null,
        nextWithdrawAt: ownIntents.filter(intent => intent.startedAt > (restock?.observedAt ?? Infinity)
          && intent.kind === 'withdraw' && intent.status === 'applied')
          .map(intent => intent.startedAt).sort((a, b) => a - b)[0] ?? null },
      contention: contentionTarget,
      work: {
        intents: ownIntents.length, byStatus, workHours: round(workMinutes / 60),
        failures: ownIntents.filter(intent => ['rejected', 'unresolved', 'cancelled'].includes(intent.status))
          .map(intent => ({ intentId: intent.intentId, status: intent.status,
            reason: intent.failureReason ?? null, kind: intent.kind })),
      },
    };
  });

  const withOpportunity = instances;
  const fulfilled = instances.filter(row => row.fulfilment.verified);
  const rate = withOpportunity.length === 0 ? null
    : Number((fulfilled.length / withOpportunity.length).toFixed(6));
  const overdue = instances.filter(row => row.overdue);
  const exits = instances.filter(row => row.authorisedExit);
  const cancelled = instances.filter(row => row.status === 'cancelled');
  const lateEffects = instances.reduce((sum, row) => sum + (row.cancel?.latePhysicalEffects ?? 0), 0);
  const lateReceipts = instances.reduce((sum, row) => sum + (row.cancel?.receiptsAfter ?? 0), 0);
  const afterAttempts = instances.reduce((sum, row) => sum + (row.cancel?.attemptsAfter ?? 0), 0);
  const changes = instances.filter(row => row.change);
  const unagreed = instances.reduce((sum, row) => sum + (row.change?.unagreedSourceActions ?? 0), 0);
  const duplicates = fulfilled.filter(row => row.fulfilment.receipts.length > 1);

  const receiptsByIntent = new Map();
  for (const intent of work) {
    for (const id of intent.eventIds ?? []) receiptsByIntent.set(id, (receiptsByIntent.get(id) ?? 0) + 1);
  }
  const duplicateReceiptIds = [...receiptsByIntent.entries()]
    .filter(([, count]) => count > 1).map(([id, count]) => ({ eventId: id, count }));

  const reasons = {};
  for (const intent of work) {
    if (!['rejected', 'unresolved', 'cancelled'].includes(intent.status)) continue;
    const key = String(intent.failureReason ?? 'unknown');
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  const byStatus = {};
  for (const intent of work) byStatus[intent.status] = (byStatus[intent.status] ?? 0) + 1;

  const contentionStory = (interference.stories ?? []).find(entry => entry.kind === 'contention');
  const contention = contentionStory ? {
    at: contentionStory.at,
    targets: contentionStory.targets ?? [],
    resolved: (contentionStory.targets ?? []).filter(target => target.outcome === 'won').length,
  } : null;
  const restockWitnessed = instances.filter(row => row.restock?.witnessedAt !== null
    && row.restock?.witnessedAt !== undefined).length;

  const pendingIntents = (input.finalIntents ?? []).filter(intent => intent.status === 'working');
  const pendingWithinEnd = pendingIntents.filter(intent => intent.dueAt <= end).length;
  const expired = pendingIntents.filter(intent => intent.dueAt > end).length;

  return {
    schema: 'frostecho.r11.metrics/1',
    metricSpec: METRIC_SPEC,
    counts: { instances: instances.length, fulfilled: fulfilled.length,
      overdue: overdue.length, authorisedExit: exits.length, cancelled: cancelled.length,
      changesProposed: changes.length, duplicateReceipts: duplicates.length },
    primary: { id: METRIC_SPEC.primary.id, numerator: fulfilled.length,
      denominator: withOpportunity.length, value: rate },
    obligations: instances,
    exposure: {
      instances: instances.length,
      activeAtSave: instances.filter(row => row.exposure.activeAtSave).length,
      boundWorkAtSave: instances.reduce((sum, row) => sum + (row.exposure.boundWorkAtSave ?? 0), 0),
      cancelHeardOpportunities: instances.filter(row => row.exposure.cancelHeardOpportunity).length,
      cancelUnheardOpportunities: instances.filter(row => row.exposure.cancelUnheardOpportunity).length,
      changeOpportunities: instances.filter(row => row.exposure.changeProposedOpportunity).length,
      restockOpportunityAt: restockStory?.appliedAt ?? null,
      restockWitnessed,
      contentionOpportunities: contention?.targets.length ?? 0,
    },
    postCancel: { cancelledInstances: cancelled.length, attemptsAfter: afterAttempts,
      latePhysicalEffects: lateEffects, lateReceipts, unauthorisedAttempts: afterAttempts - 0 },
    changes: { proposed: changes.length,
      accepted: changes.filter(row => row.change.accepted).length,
      rejected: changes.filter(row => row.change.status === 'rejected').length,
      unagreedSourceActions: unagreed,
      rows: changes.map(row => ({ commitmentId: row.commitmentId, ...row.change })) },
    contention,
    duplicates: { fulfilmentInstancesWithMultipleReceipts: duplicates.length,
      receiptIdsUsedTwice: duplicateReceiptIds },
    settlement: { intents: work.length, byStatus, failureReasons: reasons,
      pendingWithinEnd, expired,
      directRejections: (input.decisions ?? []).filter(record => record.executionStatus === 'rejected'
        || record.executionStatus === 'stale').length,
      busySkips: (input.decisions ?? []).filter(record => record.executionStatus === 'busy').length },
    work: { hours: round(instances.reduce((sum, row) => sum + (row.work.workHours ?? 0), 0), 3) },
    resources: resourceReport(input.timeline, input.clock),
    survivors: input.survivors ?? null,
    ending: input.ending ?? null,
    notExposed: instances.filter(row => row.status === 'proposed' || row.status === 'declined')
      .map(row => ({ commitmentId: row.commitmentId, status: row.status })),
  };
}

/* --------------------------- resources --------------------------- */
export function resourceReport(timeline, clock) {
  const rows = (timeline ?? []).filter(row => row && typeof row.at === 'number'
    && row.resources && typeof row.resources === 'object');
  const keys = ['food', 'firewood', 'power'];
  const out = { samples: rows.length, final: null, inventoryHours: null,
    gapHours: null, zeroWindows: null, firstZeroAt: null };
  if (rows.length === 0) return out;
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const last = sorted.at(-1);
  out.final = Object.fromEntries(keys.map(key => [key, num(last.resources[key])]));
  const rates = { food: METRIC_SPEC.rates.foodPerHour, firewood: METRIC_SPEC.rates.firewoodPerHour,
    power: METRIC_SPEC.rates.powerPerHour };
  out.inventoryHours = Object.fromEntries(keys.map(key => {
    const value = num(last.resources[key]);
    return [key, value === null ? null : round(value / rates[key])];
  }));
  const gap = Object.fromEntries(keys.map(key => [key, 0]));
  const windows = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index].at;
    const to = sorted[index + 1].at;
    if (!(to > from)) continue;
    for (const key of keys) {
      const level = num(sorted[index].resources[key]);
      if (level === null) { gap[key] = null; continue; }
      if (level <= 0) {
        gap[key] = gap[key] === null ? null : gap[key] + (to - from) / 60;
        windows.push({ resource: key, from, to });
      }
    }
  }
  out.gapHours = Object.fromEntries(keys.map(key => [key, gap[key] === null ? null
    : round(gap[key])]));
  out.zeroWindows = windows;
  const firstZero = {};
  for (const key of keys) {
    const hit = sorted.find(row => num(row.resources[key]) !== null && row.resources[key] <= 0);
    firstZero[key] = hit ? hit.at : null;
  }
  out.firstZeroAt = firstZero;
  return out;
}

/** Hand-computed controls for the gap integration (positive and negative). */
export function gapSelfTest() {
  const timeline = [
    { at: 0, resources: { food: 100, firewood: 0, power: 10 } },
    { at: 120, resources: { food: 0, firewood: 0, power: 10 } },
    { at: 240, resources: { food: 0, firewood: 0, power: 0 } },
    { at: 300, resources: { food: 100, firewood: 0, power: 0 } },
  ];
  const report = resourceReport(timeline, { start: 0, end: 300 });
  const positive = report.gapHours.food === 3 && report.gapHours.firewood === 5
    && report.gapHours.power === 1;
  const negative = resourceReport([
    { at: 0, resources: { food: 10, firewood: 10, power: 10 } },
    { at: 60, resources: { food: 9, firewood: 9, power: 9 } },
  ], { start: 0, end: 60 }).gapHours.food === 0;
  const missing = resourceReport([], {}).gapHours === null;
  return { positive, negative, missing,
    expected: { food: 3, firewood: 5, power: 1 }, actual: report.gapHours,
    ok: positive && negative && missing };
}
