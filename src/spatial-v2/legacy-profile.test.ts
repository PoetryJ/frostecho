import test from 'node:test';
import assert from 'node:assert/strict';
import { MAPS, cellKey, isWalkable } from './map';
import { LEGACY_MAP_DATA } from './legacy-map-data';
import { LEGACY_MAP_IDS, createLegacyMapRegistry, findLegacyRoute, makeLegacyPosition,
  moveLegacyPosition, transitionLegacyDoor, serializeLegacyPosition, parseLegacyPosition } from './legacy-profile';

test('explicit original profile retains default three maps and all 2,560 original collision cells', () => {
  assert.deepEqual(Object.keys(MAPS), ['village', 'warehouse', 'kitchen']);
  const registry = createLegacyMapRegistry();
  let checked = 0;
  for (const id of LEGACY_MAP_IDS) {
    const map = registry.maps[id];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
      assert.equal(isWalkable(map, { x, y }, new Set()), LEGACY_MAP_DATA.maps[id].blockedRows[y][x] === '.',
        `${id}/${x},${y}`);
      checked++;
    }
  }
  assert.equal(checked, 2560);
  assert.equal(Object.keys(registry.sourceHashes).length, 17);
});

for (const id of LEGACY_MAP_IDS.filter(value => value !== 'village')) {
  test(`real village route, ${id} door conversion, interior path and coordinate save restore`, () => {
    const registry = createLegacyMapRegistry(), map = registry.maps[id];
    const door = registry.maps.village.triggers.find(trigger => trigger.target === id)!;
    const route = findLegacyRoute('village', { x: 25, y: 22 }, door, new Set(), registry);
    assert.ok(route.path && route.path.length > 1);
    let position = makeLegacyPosition('village', route.path![0], registry);
    for (const next of route.path!.slice(1)) position = moveLegacyPosition(position, next, new Set(), registry);
    const entering = transitionLegacyDoor(position, registry);
    assert.ok(entering);
    assert.equal(entering!.to.mapId, id);
    assert.deepEqual(entering!.to.cell, map.entrySpawn);
    assert.deepEqual(parseLegacyPosition(serializeLegacyPosition(entering!.to, registry), registry), entering!.to);
    for (const exit of Object.values(map.doors)) {
      const inside = findLegacyRoute(id, entering!.to.cell, exit, new Set(), registry);
      assert.ok(inside.path, `entry-to-exit route ${id}/${cellKey(exit)}`);
      let walker = entering!.to;
      for (const next of inside.path!.slice(1)) walker = moveLegacyPosition(walker, next, new Set(), registry);
      const leaving = transitionLegacyDoor(walker, registry);
      assert.equal(leaving?.to.mapId, 'village');
      assert.deepEqual(leaving?.to.cell, map.exitSpawn);
    }
    assert.equal(transitionLegacyDoor(makeLegacyPosition(id, map.entrySpawn!, registry), registry), null);
  });
}

test('original village walls/furnace/decorations and indoor furniture cannot be crossed', () => {
  const registry = createLegacyMapRegistry();
  for (const goal of [{ x: 11, y: 20 }, { x: 25, y: 20 }, { x: 1, y: 1 }, { x: 13, y: 11 }]) {
    assert.equal(findLegacyRoute('village', { x: 25, y: 22 }, goal, new Set(), registry).path, null);
    assert.throws(() => makeLegacyPosition('village', goal, registry), /blocked/);
  }
  assert.equal(findLegacyRoute('warehouse', { x: 5, y: 6 }, { x: 1, y: 1 }, new Set(), registry).path, null);
  const position = makeLegacyPosition('warehouse', { x: 5, y: 6 }, registry);
  assert.throws(() => moveLegacyPosition(position, { x: 1, y: 1 }, new Set(), registry), /not_adjacent/);
});

test('closed original gates cut outdoor resources off while internal buildings remain reachable', () => {
  const open = createLegacyMapRegistry(), closed = createLegacyMapRegistry({ gatesClosed: true });
  const start = { x: 25, y: 22 }, goal = open.maps.village.interests.lumber_camp;
  assert.ok(findLegacyRoute('village', start, goal, new Set(), open).path);
  assert.equal(findLegacyRoute('village', start, goal, new Set(), closed).path, null);
  assert.ok(findLegacyRoute('village', start, { x: 16, y: 15 }, new Set(), closed).path);
  assert.deepEqual(closed.maps.workshop.exitSpawn, { x: 24, y: 30 });
});

test('closed door and malformed save cannot teleport through wall or invent a profile', () => {
  const registry = createLegacyMapRegistry();
  const block = new Set(['4,7', '5,7']);
  assert.equal(findLegacyRoute('warehouse', { x: 5, y: 6 }, { x: 4, y: 7 }, block, registry).path, null);
  const position = makeLegacyPosition('warehouse', { x: 5, y: 6 }, registry);
  assert.throws(() => moveLegacyPosition(position, { x: 5, y: 7 }, block, registry), /blocked/);
  assert.throws(() => parseLegacyPosition({ ...position, cell: { x: 1, y: 1 } }, registry), /blocked/);
  assert.throws(() => parseLegacyPosition({ ...position, cell: { x: 5.5, y: 6 } }, registry), /position/);
  assert.throws(() => parseLegacyPosition({ ...position, profileId: 'made-up' }, registry), /profile/);
});

test('source defects and missing command indoor art are explicit, registry instances are isolated', () => {
  const a = createLegacyMapRegistry(), b = createLegacyMapRegistry();
  assert.equal(a.maps.command.assetFile, null);
  assert.equal(a.maps.command.furniture.length, 4);
  assert.deepEqual(a.corrections.map(value => `${value.mapId}:${value.field}`),
    ['command:entrySpawn', 'dorm_a:entrySpawn', 'kitchen:exitSpawn']);
  a.maps.warehouse.entrySpawn!.x = -99;
  assert.equal(b.maps.warehouse.entrySpawn!.x, 5);
  assert.equal(LEGACY_MAP_DATA.maps.warehouse.referenceEntry.x, 5);
});
