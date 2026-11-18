/**
 * E: the adapter contract that does not need a browser or a running CLI.
 * These are the negative controls for the parts that can silently lie:
 * rewinding the picture, plotting indoor cells as village metres, or letting
 * an actor's private memory reach the graphics snapshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPrivateMemory, buildVisualSnapshot, toWorld, VisualVersionGate,
  VISUAL_SCHEMA, type BridgeState, type Catalog, type VisualSnapshot } from './snapshot';

const catalog: Catalog = {
  npcs: [{ id: 'npc_01', name: '李婶' }, { id: 'npc_02', name: '赵铁柱' }],
  buildings: [
    { id: 'dorm-a', x: 13, y: 18, w: 7, h: 5, door: { x: 16, y: 23 } },
    { id: 'warehouse', x: 13, y: 11, w: 6, h: 4, door: { x: 16, y: 15 } },
  ],
};

const bridge: BridgeState = {
  active: true, sessionId: '1000-abcdef', profile: 'gospel-5.8.19', mode: 'reference',
  observation: {
    day: 1, simTime: 480, resources: { food: 130, firewood: 30, power: 30, medicine: 3 },
    furnace: { lit: true, fuel: 6, warmth: 18 },
    npcs: [
      { id: 'npc_01', location: 'dorm-a', hunger: 70, stamina: 80, health: 100, san: 80, alive: true },
      { id: 'npc_02', location: 'village', hunger: 60, stamina: 70, health: 100, san: 75, alive: true },
    ],
  },
  status: {
    tasks: [{ taskId: 'task-1', type: 'PREPARE_WARMTH', assigneeId: 'npc_01', status: 'active',
      revision: 2 }],
    r8: { work: [{ intentId: 'npc_01-r8-1', actorId: 'npc_01', kind: 'refuel',
      startedAt: 480, endsAt: 505, status: 'running' }],
    states: { production: { machines: { generator: 'absent' }, buildRemaining: {},
      buildWorker: {} } },
    committed: [
      { eventId: 'v7:actor:survival:npc_01:span:495', type: 'r8_actor', actorId: 'npc_01',
        simTime: 480, payload: {} },
      { eventId: 'v7:resource:production:heating:wood:495', type: 'r8_resource',
        actorId: 'system', simTime: 480,
        payload: { resource: 'firewood', delta: -0.25, intentId: 'production:heating:wood:495' } },
    ] },
  },
  positions: {
    npc_01: { npcId: 'npc_01', location: 'dorm-a', legacyPosition: { mapId: 'dorm_a',
      cell: { x: 6, y: 6 } }, cell: { x: 16, y: 23 }, alive: true },
    npc_02: { npcId: 'npc_02', location: 'village', legacyPosition: { mapId: 'village',
      cell: { x: 20, y: 30 } }, cell: { x: 20, y: 30 }, alive: true },
  },
  records: [{
    command: 'game-step',
    records: [{ actorId: 'npc_01', executionStatus: 'working', reason: 'until 505',
      worldVersion: 7 }],
  }],
};

test('toWorld matches the vendored display formula', () => {
  assert.deepEqual(toWorld(25, 20), { x: 0, y: 0, z: 0 });
  assert.deepEqual(toWorld(16, 23), { x: -18, y: 0, z: 6 });
});

test('an indoor actor stands at the real door, never at indoor metres', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  assert.equal(snapshot.schema, VISUAL_SCHEMA);
  const indoor = snapshot.actors.find(actor => actor.id === 'npc_01')!;
  assert.equal(indoor.mapId, 'dorm_a');
  assert.equal(indoor.placement, 'building-door');
  assert.equal(indoor.doorOf, 'dorm-a');
  assert.deepEqual(indoor.world, toWorld(16, 23));
  // The authority's indoor cell is still reported, just not plotted as metres.
  assert.deepEqual(indoor.cell, { x: 6, y: 6 });
  assert.equal(indoor.action.phase, 'working');
  assert.equal(indoor.action.dueAt, 505);

  const outdoor = snapshot.actors.find(actor => actor.id === 'npc_02')!;
  assert.equal(outdoor.placement, 'village');
  assert.deepEqual(outdoor.world, toWorld(20, 30));
});

test('version and clock come from the authority, and the gate refuses a rewind', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  assert.equal(snapshot.worldVersion, 7);
  assert.equal(snapshot.simTime, 480);
  assert.equal(snapshot.lastCommittedOrdinal, 1);

  const gate = new VisualVersionGate();
  assert.equal(gate.accept(snapshot).verdict, 'accepted');
  assert.equal(gate.accept({ ...snapshot, worldVersion: 6, simTime: 470 }).verdict, 'stale');
  assert.equal(gate.accept({ ...snapshot, sessionId: 'other' }).verdict, 'resync-required');
});

test('private memory and prompt text cannot ride into the graphics snapshot', () => {
  const { snapshot } = buildVisualSnapshot(bridge, catalog);
  assert.doesNotThrow(() => assertNoPrivateMemory(snapshot));
  const leaked = { ...snapshot,
    actors: [{ ...snapshot.actors[0], name: '李婶 记忆: secret' }] } as VisualSnapshot;
  assert.throws(() => assertNoPrivateMemory(leaked), /private_memory_leaked/);
});

test('a missing `where` record is counted, not invented', () => {
  const partial: BridgeState = { ...bridge, positions: { npc_02: bridge.positions.npc_02 } };
  const { snapshot, rejected } = buildVisualSnapshot(partial, catalog);
  assert.equal(rejected, 1);
  assert.deepEqual(snapshot.actors.map(actor => actor.id), ['npc_02']);
});
