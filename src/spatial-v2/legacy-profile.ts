/** Explicit full-original map profile. Existing MAPS keeps its three-map default. */
import { cellKey, findPath, isWalkable, type Cell, type GridMap, type PathResult } from './map';
import { LEGACY_MAP_DATA } from './legacy-map-data';

export const LEGACY_MAP_PROFILE_ID = 'gospel-5.8.19-maps/1' as const;
export const LEGACY_MAP_IDS = ['village', 'command', 'dorm_a', 'dorm_b', 'kitchen',
  'warehouse', 'workshop', 'medical'] as const;
export type LegacyMapId = typeof LEGACY_MAP_IDS[number];
export interface LegacyTrigger { x: number; y: number; w: number; h: number;
  target: string; name: string; spawnX: number; spawnY: number }
export interface LegacyMap extends GridMap<LegacyMapId> {
  name: string; blockedRows: string[]; triggers: LegacyTrigger[];
  furniture: { x: number; y: number; w: number; h: number; name: string; color: string }[];
  assetKey: string | null; assetFile: string | null; assetSha256: string | null;
  assetSize: number[] | null; entrySpawn: Cell | null; exitSpawn: Cell | null;
  referenceEntry: Cell | null; referenceExitSpawn: Cell | null;
  seats: { x: number; y: number; name: string }[];
  buildings: unknown[]; resourceAreas: unknown[]; decorations: unknown[];
}
export interface LegacyRegistry {
  profileId: typeof LEGACY_MAP_PROFILE_ID; r8Profile: 'gospel-5.8.19'; tilePixels: number;
  gatesClosed: boolean; maps: Record<LegacyMapId, LegacyMap>;
  sourceHashes: Record<string, string>; corrections: { mapId: LegacyMapId; field: string;
    original: Cell | null; actual: Cell; reason: string }[];
}
const cell = (value: Cell): Cell => ({ x: value.x, y: value.y });
const integerCell = (value: Cell): boolean => Number.isInteger(value?.x) && Number.isInteger(value?.y);
export function isLegacyMapId(value: unknown): value is LegacyMapId {
  return typeof value === 'string' && (LEGACY_MAP_IDS as readonly string[]).includes(value);
}
export function createLegacyMapRegistry(options: { gatesClosed?: boolean } = {}): LegacyRegistry {
  const maps = {} as Record<LegacyMapId, LegacyMap>;
  const corrections: LegacyRegistry['corrections'] = [];
  for (const id of LEGACY_MAP_IDS) {
    const raw = structuredClone(LEGACY_MAP_DATA.maps[id]);
    const solids: GridMap['solids'] = [];
    raw.blockedRows.forEach((row, y) => [...row].forEach((value, x) => {
      if (value === '#') solids.push({ x, y, w: 1, h: 1 });
    }));
    if (id === 'village' && options.gatesClosed) {
      for (const gate of raw.gates) for (let dx = 0; dx < gate.w; dx++)
        solids.push({ x: gate.x + dx, y: gate.y, w: 1, h: 1 });
    }
    const doors: Record<string, Cell> = {};
    for (const trigger of raw.triggers) for (let dx = 0; dx < trigger.w; dx++)
      doors[`${trigger.target}:${dx}`] = { x: trigger.x + dx, y: trigger.y };
    maps[id] = { ...raw, id, solids, doors, entrySpawn: null, exitSpawn: null } as LegacyMap;
  }
  for (const id of LEGACY_MAP_IDS.filter(id => id !== 'village')) {
    const map = maps[id], raw = LEGACY_MAP_DATA.maps[id];
    const entry = raw.referenceEntry;
    const threshold = { x: Math.floor(map.w / 2), y: map.h - 2 };
    map.entrySpawn = entry && isWalkable(map, entry, new Set()) ? cell(entry) : threshold;
    if (!isWalkable(map, map.entrySpawn, new Set())) throw new Error(`No valid original entry for ${id}`);
    if (!entry || !isWalkable(map, entry, new Set())) corrections.push({ mapId: id,
      field: 'entrySpawn', original: entry, actual: map.entrySpawn,
      reason: 'No walkable original schedule entry; use the interior side of the original south door.' });
    const originalExit = raw.referenceExitSpawn;
    const scheduleDoor = raw.scheduleDoor;
    const villageDoor = maps.village.triggers.find(trigger => trigger.target === id);
    const fallback = scheduleDoor ?? villageDoor;
    map.exitSpawn = originalExit && isWalkable(maps.village, originalExit, new Set())
      ? cell(originalExit) : fallback ? cell(fallback) : null;
    if (!map.exitSpawn || !isWalkable(maps.village, map.exitSpawn, new Set()))
      throw new Error(`No valid original exit for ${id}`);
    if (!originalExit || !isWalkable(maps.village, originalExit, new Set())) corrections.push({
      mapId: id, field: 'exitSpawn', original: originalExit, actual: map.exitSpawn,
      reason: 'Original exit spawn intersects village wall or closed gate; use original schedule/building door.' });
  }
  return { profileId: LEGACY_MAP_PROFILE_ID, r8Profile: 'gospel-5.8.19',
    tilePixels: LEGACY_MAP_DATA.tilePixels, gatesClosed: options.gatesClosed ?? false,
    maps, sourceHashes: { ...LEGACY_MAP_DATA.sources }, corrections };
}

export interface LegacyPosition {
  schema: 'frostecho.legacy-position/1'; profileId: typeof LEGACY_MAP_PROFILE_ID;
  mapId: LegacyMapId; cell: Cell;
}
export function makeLegacyPosition(mapId: LegacyMapId, at: Cell,
  registry = createLegacyMapRegistry()): LegacyPosition {
  if (!isLegacyMapId(mapId) || !integerCell(at) || !isWalkable(registry.maps[mapId], at, new Set()))
    throw new Error('invalid_or_blocked_legacy_position');
  return { schema: 'frostecho.legacy-position/1', profileId: LEGACY_MAP_PROFILE_ID,
    mapId, cell: cell(at) };
}
export function parseLegacyPosition(value: unknown,
  registry = createLegacyMapRegistry()): LegacyPosition {
  const raw = (typeof value === 'string' ? JSON.parse(value) : value) as LegacyPosition;
  if (!raw || raw.schema !== 'frostecho.legacy-position/1'
    || raw.profileId !== LEGACY_MAP_PROFILE_ID) throw new Error('unknown_legacy_position_profile');
  return makeLegacyPosition(raw.mapId, raw.cell, registry);
}
export function serializeLegacyPosition(value: LegacyPosition,
  registry = createLegacyMapRegistry()): string {
  return JSON.stringify(parseLegacyPosition(value, registry));
}
/** Strict endpoints: a blocked goal is rejected, never reported as arrival nearby. */
export function findLegacyRoute(mapId: LegacyMapId, from: Cell, to: Cell,
  closedCells: ReadonlySet<string> = new Set(), registry = createLegacyMapRegistry()): PathResult {
  if (!isLegacyMapId(mapId) || !integerCell(from) || !integerCell(to))
    return { path: null, blockedBy: 'no-goal', corridor: [] };
  const map = registry.maps[mapId];
  if (!isWalkable(map, from, closedCells) || !isWalkable(map, to, closedCells))
    return { path: null, blockedBy: 'unreachable', corridor: [] };
  return findPath(map, from, to, closedCells);
}
/** Pure one-tile transition; caller still owns world commit/time and receipts. */
export function moveLegacyPosition(value: LegacyPosition, to: Cell,
  closedCells: ReadonlySet<string> = new Set(), registry = createLegacyMapRegistry()): LegacyPosition {
  const from = parseLegacyPosition(value, registry);
  if (Math.abs(from.cell.x - to.x) + Math.abs(from.cell.y - to.y) !== 1
    || closedCells.has(cellKey(to))) throw new Error('legacy_move_not_adjacent_or_blocked');
  return makeLegacyPosition(from.mapId, to, registry);
}
/** A room switch is available only from a committed door cell. No world mutation. */
export function transitionLegacyDoor(value: LegacyPosition,
  registry = createLegacyMapRegistry()): { from: LegacyPosition; to: LegacyPosition;
    trigger: LegacyTrigger } | null {
  const from = parseLegacyPosition(value, registry);
  const map = registry.maps[from.mapId];
  const trigger = map.triggers.find(entry => from.cell.x >= entry.x
    && from.cell.x < entry.x + entry.w && from.cell.y >= entry.y && from.cell.y < entry.y + entry.h);
  if (!trigger || !isLegacyMapId(trigger.target)) return null;
  const destination = trigger.target === 'village' ? map.exitSpawn : registry.maps[trigger.target].entrySpawn;
  if (!destination) throw new Error('legacy_door_missing_destination');
  return { from, to: makeLegacyPosition(trigger.target, destination, registry), trigger: { ...trigger } };
}
/** JSON-safe catalog: geometry and source provenance for server/UI consumers. */
export function legacyMapCatalog(options: { gatesClosed?: boolean } = {}): LegacyRegistry {
  return createLegacyMapRegistry(options);
}
