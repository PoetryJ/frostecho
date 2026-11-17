import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { R8Runtime } from './runtime';
import { REFERENCE_PROFILE } from '../contracts';
import { createLegacyMapRegistry } from '../../spatial-v2/legacy-profile';
import { LEGACY_TILE_MINUTES } from './spatial';
import { DEFAULT_WAREHOUSE_FOOD, TRAVEL_STAMINA_PER_TILE } from '../../survival/world-v2';

const projection = (runtime: R8Runtime) => ({ world: runtime.world, states: runtime.states,
  committed: runtime.committedEvents(), knowledge: runtime.session.knowledge(),
  journal: runtime.journal, ended: runtime.ended, endingKind: runtime.endingKind });

test('original spatial profile is explicit; reference profile refuses it without changing state', () => {
  const legacy = R8Runtime.create({ profile: REFERENCE_PROFILE });
  assert.equal(legacy.legacyPosition('npc_01'), null);
  const before = JSON.stringify(projection(legacy));
  assert.throws(() => legacy.enableLegacySpatial(), /requires_gospel/);
  assert.equal(JSON.stringify(projection(legacy)), before);
  const current = R8Runtime.create();
  assert.equal(current.legacyPosition('npc_01'), null);
  const first = current.enableLegacySpatial();
  assert.equal(first.status, 'applied');
  const version = current.world.version;
  assert.equal(current.enableLegacySpatial().status, 'duplicate');
  assert.equal(current.world.version, version);
});

test('one adjacent cell commits coordinate/location and charges one world minute plus original effort once', () => {
  const walked = R8Runtime.create({ seed: 'spatial-clock' });
  const waited = R8Runtime.create({ seed: 'spatial-clock' });
  walked.enableLegacySpatial(); waited.enableLegacySpatial();
  const before = walked.world.simTime, stamina = waited.world.npcs.npc_01.stamina;
  const result = walked.moveLegacy('npc_01', { x: 5, y: 6 }, 'single-step');
  waited.advanceWorld(before + LEGACY_TILE_MINUTES);
  assert.equal(result.status, 'applied');
  assert.equal(result.elapsedMinutes, 1);
  assert.equal(walked.world.simTime, waited.world.simTime);
  assert.deepEqual(walked.world.resources, waited.world.resources);
  assert.deepEqual(walked.world.furnace, waited.world.furnace);
  assert.deepEqual(walked.world.npcs.npc_02, waited.world.npcs.npc_02);
  assert.ok(Math.abs(waited.world.npcs.npc_01.stamina - walked.world.npcs.npc_01.stamina - TRAVEL_STAMINA_PER_TILE) < 1e-9);
  assert.ok(walked.world.npcs.npc_01.stamina < stamina);
  assert.equal(walked.world.npcs.npc_01.location, 'dorm-a');
  assert.deepEqual(walked.legacyPosition('npc_01')!.cell, { x: 5, y: 6 });
  assert.ok(result.eventIds.every(id => walked.committedEvent(id)));
});

test('wall, remote door, invalid actor and unsupported old travel have zero authoritative effects', () => {
  const runtime = R8Runtime.create(); runtime.enableLegacySpatial();
  const before = JSON.stringify(projection(runtime));
  assert.equal(runtime.walkLegacy('npc_01', { x: 0, y: 0 }).status, 'rejected');
  assert.equal(runtime.transitionLegacy('npc_01').reason, 'actor_not_at_original_door');
  assert.equal(runtime.moveLegacy('missing', { x: 5, y: 6 }).reason, 'actor_not_alive');
  const old = runtime.session.submitWorldCommand({ commandId: 'old-travel', actorId: 'npc_01',
    type: 'travel', route: [{ x: 16, y: 23 }, { x: 16, y: 24 }], minutesPerTile: 1 });
  assert.equal(old.status, 'rejected');
  assert.match(old.reason!, /requires_walkLegacy/);
  assert.equal(JSON.stringify(projection(runtime)), before);
});

test('macro candidate move traverses the real map; all seven interiors remain accessible', () => {
  const runtime = R8Runtime.create(); runtime.enableLegacySpatial();
  const candidate = { id: 'real-move', kind: 'action', description: 'visit warehouse',
    parameters: { action: 'move', to: 'warehouse' }, preconditions: [], expectedEffects: {}, utilityComponents: {} };
  const start = runtime.world.simTime;
  const result = runtime.session.executeCandidate('npc_01', candidate, 'candidate-warehouse');
  assert.equal(result.status, 'applied');
  assert.equal(runtime.legacyPosition('npc_01')!.mapId, 'warehouse');
  assert.ok(runtime.world.simTime > start + 1);
  assert.ok(result.events!.some(event => event.type === 'legacy_door_crossed'));
  for (const mapId of ['medical', 'kitchen', 'workshop', 'command', 'dorm-b', 'dorm-a']) {
    // A real rest command between trips prevents an unrelated exhaustion stop.
    runtime.session.submitWorldCommand({ commandId: `rest-${mapId}`, type: 'rest', actorId: 'npc_01', minutes: 120 });
    const trip = runtime.travelLegacyTo('npc_01', mapId, `visit-${mapId}`);
    assert.equal(trip.status, 'applied', JSON.stringify(trip));
    assert.equal(runtime.world.npcs.npc_01.location, mapId);
    assert.equal(runtime.legacyPosition('npc_01')!.mapId, mapId.replace('-', '_'));
  }
});

test('same command replay is exact, conflicting content does not walk or advance time', () => {
  const runtime = R8Runtime.create(); runtime.enableLegacySpatial();
  const first = runtime.moveLegacy('npc_01', { x: 5, y: 6 }, 'movement-id');
  const before = JSON.stringify(projection(runtime));
  const repeated = runtime.moveLegacy('npc_01', { x: 5, y: 6 }, 'movement-id');
  assert.equal(repeated.status, 'duplicate');
  assert.deepEqual(repeated.eventIds, first.eventIds);
  assert.equal(runtime.moveLegacy('npc_01', { x: 6, y: 7 }, 'movement-id').reason, 'command_id_conflict');
  assert.equal(JSON.stringify(projection(runtime)), before);
});

test('warehouse entrance observes real stock only for the arriving actor; remote observation is rejected', () => {
  const runtime = R8Runtime.create(); runtime.enableLegacySpatial();
  const before = JSON.stringify(projection(runtime));
  assert.equal(runtime.observeLegacyStock('npc_01').reason, 'warehouse_stock_not_visible');
  assert.equal(JSON.stringify(projection(runtime)), before);
  const trip = runtime.travelLegacyTo('npc_01', 'warehouse', 'stock-arrival');
  assert.equal(trip.status, 'applied');
  const observed = runtime.session.memories.get('npc_01')!.toJSON().records
    .filter(record => record.kind === 'warehouse_stock_observed');
  assert.equal(observed.length, 1);
  assert.equal((observed[0].payload as { remaining: number }).remaining, DEFAULT_WAREHOUSE_FOOD);
  assert.ok(runtime.committedEvent(observed[0].sourceEventIds[0]));
  assert.equal(runtime.session.memories.get('npc_02')!.toJSON().records
    .filter(record => record.kind === 'warehouse_stock_observed').length, 0);
  runtime.session.submitWorldCommand({ commandId: 'real-stock-change', type: 'restock',
    place: 'warehouse', resource: 'food', amount: 3, source: 'test-authorized-restock' });
  const inspection = runtime.observeLegacyStock('npc_01', 'new-inspection');
  assert.equal(inspection.status, 'applied');
  const event = inspection.eventIds.map(id => runtime.committedEvent(id))
    .find(value => value?.type === 'warehouse_stock_observed')!;
  assert.equal(event.payload.remaining, runtime.world.spatial!.stocks.warehouse.food);
  assert.equal(event.payload.remaining, DEFAULT_WAREHOUSE_FOOD + 3);
});

test('runtime number encoding preserves live domain state and reads pre-encoding v1 sidecars', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frostecho-runtime-number-'));
  const path = join(directory, 'save.json');
  try {
    const runtime = R8Runtime.create({ seed: 'number-save' });
    runtime.save(path);
    assert.equal(runtime.states.crises.lastFoodConflictMinute, -Infinity);
    assert.deepEqual(R8Runtime.load(path).states, runtime.states);
    const raw = JSON.parse(readFileSync(`${path}.r8.json`, 'utf8'));
    assert.equal(raw.numberEncoding, 'frostecho.nonfinite-number/1');
    raw.states.crises.lastFoodConflictMinute = null;
    delete raw.numberEncoding;
    writeFileSync(`${path}.r8.json`, JSON.stringify(raw));
    assert.deepEqual(R8Runtime.load(path).states, runtime.states);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('D2 save restored in a new process preserves all authority and door receipts through three-room return', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frostecho-original-spatial-'));
  const save = join(directory, 'day2.json'), expectedPath = join(directory, 'expected.json');
  try {
    const runtime = R8Runtime.create({ seed: 'd2-original-maps' }); runtime.enableLegacySpatial();
    assert.equal(runtime.travelLegacyTo('npc_01', 'medical', 'first-medical').status, 'applied');
    runtime.advanceWorld(1440 + 480);
    runtime.save(save);
    for (const target of ['kitchen', 'warehouse', 'dorm-a']) {
      runtime.session.submitWorldCommand({ commandId: `recover-${target}`, type: 'rest', actorId: 'npc_01', minutes: 120 });
      runtime.advanceWorld(runtime.world.simTime + 120);
      assert.equal(runtime.travelLegacyTo('npc_01', target, `after-save-${target}`).status, 'applied');
    }
    writeFileSync(expectedPath, JSON.stringify(projection(runtime), (_key, value) =>
      value === -Infinity ? { $frostechoNumber: '-Infinity' } : value));
    const child = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict'),fs=require('node:fs');
      const {R8Runtime}=require(process.argv[1]); const r=R8Runtime.load(process.argv[2]);
      assert.equal(r.states.crises.lastFoodConflictMinute,-Infinity);
      const snapshot=JSON.stringify(r.world);
      assert.equal(r.travelLegacyTo('npc_01','medical','first-medical').status,'duplicate');
      assert.equal(JSON.stringify(r.world),snapshot);
      for(const target of ['kitchen','warehouse','dorm-a']) {
        r.session.submitWorldCommand({commandId:'recover-'+target,type:'rest',actorId:'npc_01',minutes:120});
        r.advanceWorld(r.world.simTime+120);
        assert.equal(r.travelLegacyTo('npc_01',target,'after-save-'+target).status,'applied');
      }
      const actual={world:r.world,states:r.states,committed:r.committedEvents(),knowledge:r.session.knowledge(),
        journal:r.journal,ended:r.ended,endingKind:r.endingKind};
      const expected=JSON.parse(fs.readFileSync(process.argv[3],'utf8'),
        (_key,value)=>value&&value.$frostechoNumber==='-Infinity'?-Infinity:value);
      assert.deepEqual(actual,expected);
      console.log(JSON.stringify({ok:true,day:r.world.day,time:r.world.simTime,position:r.legacyPosition('npc_01'),
        events:r.committedEvents().filter(x=>x.type==='legacy_cell_moved'||x.type==='legacy_door_crossed').length}));
    `, resolve(__dirname, 'runtime.js'), save, expectedPath], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).ok, true);
    assert.equal(JSON.parse(child.stdout).position.mapId, 'dorm_a');
    const doc = JSON.parse(readFileSync(save, 'utf8'));
    assert.equal(doc.world.r8.facts['legacySpatial.enabled'], 1);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('road closure blocks the real original village route, and rescue cannot silently teleport', () => {
  const runtime = R8Runtime.create(); runtime.enableLegacySpatial();
  runtime.travelLegacyTo('npc_01', 'village');
  const registry = createLegacyMapRegistry();
  const goal = registry.maps.village.triggers.find(trigger => trigger.target === 'medical')!;
  runtime.session.submitWorldCommand({ commandId: 'close-medical', type: 'close-road',
    cells: [{ x: goal.x, y: goal.y }] });
  const before = JSON.stringify(runtime.world);
  assert.equal(runtime.travelLegacyTo('npc_01', 'medical').status, 'rejected');
  assert.equal(JSON.stringify(runtime.world), before);
  assert.equal(runtime.dispatch('crises', 'rescue', 'npc_02', { victimId: 'npc_01' }).rejected[0].code,
    'original_map_requires_routed_rescue');
  assert.equal(JSON.stringify(runtime.world), before);
});
