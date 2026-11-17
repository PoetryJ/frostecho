#!/usr/bin/env node
/** Read the sealed original constructors/collision methods, never approximate furniture. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function extractLegacyMaps(referenceDirectory) {
  const source = resolve(referenceDirectory, 'source/extracted');
  const sources = {};
  const context = vm.createContext({ window: {}, console: { log() {}, warn() {} } });
  const files = ['src/core/constants.js', 'src/map/base-map.js', 'src/map/village-map.js',
    'src/map/village-decorations.js', 'src/map/indoor/indoor-map.js',
    ...['command', 'dorm-a', 'dorm-b', 'kitchen', 'warehouse', 'workshop', 'medical']
      .map(id => `src/map/indoor/${id}.js`), 'data/npc-schedules.js', 'src/map/map-registry.js'];
  // Translation affects labels only. Geometry, TILE, constructors and isSolid
  // come from the original files, executed without DOM/rendering/model access.
  for (const file of files) {
    const bytes = readFileSync(resolve(source, file));
    sources[`source/extracted/${file}`] = sha(bytes);
    vm.runInContext(bytes.toString('utf8'), context, { filename: file, timeout: 1000 });
    if (file === 'src/core/constants.js') context.window.GST.t = key => key;
  }
  for (const file of ['src/utils/pathfinding.js', 'src/npc/npc-movement.js'])
    sources[`source/extracted/${file}`] = sha(readFileSync(resolve(source, file)));
  const manifestBytes = readFileSync(resolve(referenceDirectory, 'assets/asset/sprite-manifest.json'));
  sources['assets/asset/sprite-manifest.json'] = sha(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const gst = context.window.GST;
  const maps = {};
  const copy = value => JSON.parse(JSON.stringify(value));
  for (const [id, original] of Object.entries(gst.MapRegistry.getAll())) {
    const masks = [];
    for (let y = 0; y < original.height; y++) {
      let row = '';
      for (let x = 0; x < original.width; x++) {
        const solid = original.isSolid((x + 0.5) * gst.TILE, (y + 0.5) * gst.TILE)
          || original.circleObstacles.some(o => Math.hypot(x + 0.5 - o.cx, y + 0.5 - o.cy) < o.r + 0.3);
        row += solid ? '#' : '.';
      }
      masks.push(row);
    }
    const assetKey = id === 'village' ? 'village_base' : original.indoorMapKey;
    const asset = assetKey ? manifest.maps[assetKey] : null;
    const assetFile = asset?.file ?? null;
    const assetSha256 = assetFile ? sha(readFileSync(resolve(referenceDirectory, 'assets', assetFile))) : null;
    const interests = Object.fromEntries(Object.entries(gst.SCHEDULE_LOCATIONS)
      .filter(([, value]) => value.scene === id).map(([key, value]) => [key, { x: value.x, y: value.y }]));
    const referenceEntry = gst.SCHEDULE_LOCATIONS[`${id}_inside`] ?? null;
    maps[id] = { id, name: original.name, w: original.width, h: original.height,
      blockedRows: masks, triggers: copy(original.triggers), interests,
      furniture: copy(original.furniture ?? []), buildings: copy(original.buildings ?? []),
      decorations: copy(original.decorations), resourceAreas: copy(original.resourceAreas ?? []),
      furnacePlaza: copy(original.furnacePlaza ?? null),
      beds: copy(original.beds ?? []), seats: copy(gst.INDOOR_SEATS[id] ?? []),
      referenceEntry: referenceEntry ? { x: referenceEntry.x, y: referenceEntry.y } : null,
      referenceExitSpawn: copy(original.exitSpawn ?? null),
      scheduleDoor: copy(gst.SCHEDULE_LOCATIONS[`${id}_door`] ?? null),
      assetKey: assetKey ?? null, assetFile, assetSha256,
      assetSize: asset?.size ?? null,
      gates: id === 'village' ? [copy(original.northGate), copy(original.southGate)] : [],
      wallBounds: copy(original.wallBounds ?? null) };
  }
  return { schema: 'frostecho.legacy-map-extraction/1', tilePixels: gst.TILE,
    collisionSampling: 'original isSolid at tile center plus original pathfinding circle clearance',
    sources, maps };
}
const args = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const get = name => args[args.indexOf(name) + 1];
  const reference = get('--reference');
  if (!args.includes('--reference') || !reference) throw new Error('--reference <reference-extracted> required');
  const data = extractLegacyMaps(reference);
  const text = '/** GENERATED from sealed original map constructors; regenerate with extract-legacy-maps.mjs. */\n'
    + `export const LEGACY_MAP_DATA = ${JSON.stringify(data, null, 2)};\n`;
  if (args.includes('--check')) {
    if (readFileSync(get('--check'), 'utf8') !== text) throw new Error('Original map read-back mismatch');
    console.log(JSON.stringify({ ok: true, maps: Object.keys(data.maps).length,
      cells: Object.values(data.maps).reduce((n, map) => n + map.w * map.h, 0), sources: Object.keys(data.sources).length }));
  } else {
    if (!args.includes('--out')) throw new Error('--out <new.ts> or --check <existing.ts> required');
    writeFileSync(get('--out'), text, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ ok: true, maps: Object.keys(data.maps), sources: Object.keys(data.sources).length }));
  }
}
