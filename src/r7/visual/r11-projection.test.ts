/**
 * E (R11): the display fields the player actually uses — stock receipts, the
 * route that was really walked, B's projection summary — and the negative
 * controls that keep them from becoming a second simulation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPrivateMemory, buildVisualSnapshot, type BridgeState, type Catalog } from './snapshot';

const catalog: Catalog = {
  npcs: [{ id: 'npc_01', name: '李婶' }, { id: 'npc_03', name: '王策' }],
  buildings: [{ id: 'warehouse', x: 12, y: 11, w: 6, h: 4, door: { x: 16, y: 15 } }],
};

const committed = [
  { eventId: 'legacy-step:1', type: 'legacy_cell_moved', actorId: 'npc_03', simTime: 510,
    payload: { fromMap: 'village', toMap: 'village', fromX: 16, fromY: 15, x: 15, y: 15,
      minutes: 1, commandId: 'in-4-travel:part:2:step:0' } },
  { eventId: 'legacy-step:2', type: 'legacy_door_crossed', actorId: 'npc_03', simTime: 511,
    payload: { fromMap: 'village', toMap: 'warehouse', fromX: 15, fromY: 15, x: 5, y: 6,
      minutes: 1, commandId: 'in-4-travel:part:3' } },
  { eventId: 'legacy-observation:1', type: 'warehouse_stock_observed', actorId: 'npc_03',
    simTime: 511, payload: { place: 'warehouse', resource: 'food', remaining: 0,
      commandId: 'in-4-travel:part:3:inspect' } },
  { eventId: 'npc_03-r8-1:gathered:570', type: 'gathered', actorId: 'npc_03', simTime: 570,
    payload: { resource: 'food', amount: 4 } },
  { eventId: 'npc_03-r8-2:stock_deposited:602', type: 'stock_deposited', actorId: 'npc_03',
    simTime: 602, payload: { place: 'warehouse', amount: 1, publicFood: 133, total: 1 } },
  { eventId: 'npc_03-r8-3:stock_withdrawn:602', type: 'stock_withdrawn', actorId: 'npc_03',
    simTime: 602, payload: { place: 'warehouse', amount: 1, remaining: 0, carried: 1 } },
  { eventId: 'npc_03-r8-4:meal_delivered:657', type: 'meal_delivered', actorId: 'npc_03',
    simTime: 657, payload: { to: 'kitchen', amount: 1, totalDelivered: 1 } },
];

const bridge: BridgeState = {
  active: true, sessionId: '1000-abcdef', profile: 'gospel-5.8.19', mode: 'reference',
  savedAt: '2026-11-20T05:00:00.000Z', canContinue: true,
  observation: {
    day: 2, simTime: 1440, resources: { food: 133, firewood: 22, power: 30, medicine: 3 },
    furnace: { lit: true, fuel: 6, warmth: 18 },
    npcs: [{ id: 'npc_03', location: 'warehouse', hunger: 47, stamina: 64, health: 100,
      san: 70, alive: true, bodyTemp: 36.2 }],
  },
  status: {
    ending: 'none',
    scorer: { scorerId: 'reference-rule/1', mode: 'reference', rendererId: 'agency-options/1',
      experimental: false, countsAsAdmitted: false },
    tasks: [{ taskId: 'task-001-deliver-meal', type: 'deliver-meal', assigneeId: 'npc_03',
      status: 'active', commitmentId: 'cm-1' }],
    commitments: [{ commitmentId: 'cm-1', taskId: 'task-001-deliver-meal', promisorId: 'npc_03',
      beneficiaryId: 'player', goal: 'deliver-meal', status: 'pending-change', revision: 1,
      deadline: null, createdAt: 501, updatedAt: 522, evidenceEventIds: [],
      changes: [{ changeId: 'chg-1', kind: 'alt-source', status: 'open', proposedAt: 522,
        terms: { source: 'gather' }, reason: 'warehouse-empty' }] }],
    r8: {
      work: [{ intentId: 'npc_03-r8-9', actorId: 'npc_03', kind: 'deposit',
        taskId: 'task-001-deliver-meal', commitmentId: 'cm-1', startedAt: 587, endsAt: 602 }],
      states: { production: { machines: {}, buildRemaining: {}, buildWorker: {} },
        crises: { active: [{ crisisId: 'crisis-1', kind: 'day4_warning',
          startedAtMinute: 4320, detail: 'final day lockdown' }], history: [] } },
      committed,
    },
  },
  positions: {
    npc_03: { npcId: 'npc_03', location: 'warehouse', legacyPosition: { mapId: 'warehouse',
      cell: { x: 5, y: 6 } }, cell: { x: 16, y: 15 }, alive: true },
  },
  records: [{
    command: 'r8-step',
    records: [{ actorId: 'npc_03', executionStatus: 'working', reason: 'until 602',
      worldVersion: 12, memorySelection: 'obligation-first', memoryCounterId: 'utf8-bytes/3-ceil/1',
      memoryBudget: 640, memoryTokens: 601, memoryKept: 8, memoryDropped: 221,
      memoryNoteSuppressed: 1, requestId: 'r8-score:12',
      memoryNotes: [{ noteId: 'note-shortage-npc_03', lesson: 'delay-should-be-reported',
        sourceEventIds: ['legacy-observation:1'], observedAt: 511 }],
      observationText: 'private prompt text that must never be shipped',
      jointText: '记忆: private' }],
  }],
};

test('stock comes from the last authoritative receipt, not a local counter', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  assert.equal(snapshot.stock.warehouse.remaining, 0);
  assert.equal(snapshot.stock.warehouse.source, 'stock_withdrawn');
  assert.equal(snapshot.stock.warehouse.eventId, 'npc_03-r8-3:stock_withdrawn:602');
  // The last carry receipt is the delivery: the one meal left the hands there.
  assert.equal(snapshot.stock.carry.meals, 0);
  assert.match(snapshot.stock.carry.eventId ?? '', /meal_delivered/);
  assert.equal(snapshot.stock.public.food, 133);
});

test('the route is the committed legs, door included, in order', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  const route = snapshot.routes.find(row => row.actorId === 'npc_03')!;
  assert.equal(route.summary.tiles, 1);
  assert.equal(route.summary.doors, 1);
  assert.equal(route.summary.minutes, 2);
  assert.deepEqual(route.summary.from, { x: 16, y: 15 });
  assert.deepEqual(route.summary.to, { x: 5, y: 6 });
  assert.equal(route.legs[1].type, 'door');
  assert.equal(route.legs[1].toMap, 'warehouse');
});

test('B projection is summarised without prompt text or lesson copy', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  const projection = snapshot.projections.npc_03!;
  assert.equal(projection.counterId, 'utf8-bytes/3-ceil/1');
  assert.equal(projection.budget, 640);
  assert.equal(projection.tokens, 601);
  assert.equal(projection.kept, 8);
  assert.equal(projection.dropped, 221);
  assert.deepEqual(projection.noteIds, ['note-shortage-npc_03']);
  assert.doesNotThrow(() => assertNoPrivateMemory(snapshot));
  assert.ok(!JSON.stringify(snapshot.projections).includes('delay-should-be-reported'));
});

test('promise progress receipts are exposed in order, display-safe', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  const types = snapshot.progress.map(row => row.type);
  assert.ok(types.includes('warehouse_stock_observed'));
  assert.ok(types.includes('gathered'));
  assert.ok(types.includes('stock_deposited'));
  assert.ok(types.includes('stock_withdrawn'));
  assert.ok(types.includes('meal_delivered'));
  assert.doesNotThrow(() => assertNoPrivateMemory(snapshot));
});

test('the change, the pending work and the scorer identity are visible', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  const row = snapshot.obligations[0];
  assert.equal(row.status, 'pending-change');
  assert.equal(row.changes[0].source, 'gather');
  assert.equal(snapshot.work[0].endsAt, 602);
  assert.equal(snapshot.scorer.scorerId, 'reference-rule/1');
  assert.equal(snapshot.save.canContinue, true);
  assert.equal(snapshot.crises.active[0].kind, 'day4_warning');
  assert.equal(snapshot.tasks[0].commitmentId, 'cm-1');
});

test('a private prompt inside the transport records cannot reach the page', () => {
  // The raw step record contains observationText/jointText. The snapshot only
  // keeps counts, so the gate passes; injecting the text into a display field
  // must fail instead of silently shipping it.
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  const leaked = structuredClone(snapshot);
  leaked.actors[0].action.reason = '记忆: secret';
  assert.throws(() => assertNoPrivateMemory(leaked), /private_memory_leaked/);
});
