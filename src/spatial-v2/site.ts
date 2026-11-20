/**
 * Which original-map sites an actor counts as standing at.
 *
 * The sealed original accepts a task at `*_door` **or** inside the room
 * (`task-system.js` `targetLocation` + `task-effects.js` `isAtLocation`). The
 * engine used to compare bare room ids, so standing on the warehouse door cell
 * in the 50x40 village did not count as `warehouse` — that is the single cause
 * of six of the nine R10 parity findings (`6 NARROWED`). This module is the one
 * place that decides membership, from the committed original position, and is
 * shared by the candidate layer, the executor gate and the runner.
 *
 * Pure geometry: it never writes the world and never changes the clock.
 */
import { LEGACY_MAP_IDS, createLegacyMapRegistry, type LegacyMapId,
  type LegacyPosition, type LegacyRegistry } from './legacy-profile';

/** `dorm_a` (map id) -> `dorm-a` (the world's LocationId). */
export const SITE_ID: Record<string, string> = {
  dorm_a: 'dorm-a', dorm_b: 'dorm-b',
};

export function siteIdOf(mapId: string): string {
  return SITE_ID[mapId] ?? mapId;
}

export function mapIdOfSite(site: string): LegacyMapId {
  return (site === 'dorm-a' ? 'dorm_a' : site === 'dorm-b' ? 'dorm_b' : site) as LegacyMapId;
}

const inside = (cell: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number }): boolean =>
  cell.x >= rect.x && cell.x < rect.x + rect.w && cell.y >= rect.y && cell.y < rect.y + rect.h;

/**
 * Sites this position satisfies. Inside a room: that room only. On a door cell
 * of the village: the village **and** the room the door belongs to. The village
 * door rect is read from the original trigger table, never re-derived by hand.
 */
export function positionSites(position: LegacyPosition,
  registry: LegacyRegistry = createLegacyMapRegistry()): string[] {
  const sites = new Set<string>([siteIdOf(position.mapId)]);
  if (position.mapId === 'village') {
    sites.add('village');
    for (const trigger of registry.maps.village.triggers) {
      if (inside(position.cell, trigger)) sites.add(siteIdOf(trigger.target));
    }
  }
  return [...sites].sort();
}

/**
 * Door-or-inside membership test used by every place gate.
 * `sites` is optional so a caller that only knows `location` keeps the old,
 * strictly narrower behaviour instead of silently widening it.
 */
export function placeSatisfied(place: string | null | undefined, location: string,
  sites: readonly string[] | null | undefined): boolean {
  if (!place) return true;
  if (location === place) return true;
  if (!sites || sites.length === 0) return false;
  return sites.includes(place);
}

let cachedRegistry: LegacyRegistry | null = null;
/** The registry is immutable for `gatesClosed = false`; build it once per process. */
function defaultRegistry(): LegacyRegistry {
  cachedRegistry ??= createLegacyMapRegistry();
  return cachedRegistry;
}

/**
 * Sites read straight out of the committed per-actor spatial facts, so an
 * authority gate can answer "is this actor at the door of X?" without a second
 * copy of the position. Fails soft: no facts (or a non-original arm) yields the
 * bare location, i.e. the old stricter behaviour.
 *
 * Keep the key format in one place: `src/r7/integration/spatial.ts` writes it.
 */
export function sitesFromFacts(facts: Record<string, number> | undefined,
  actorId: string, location: string): string[] {
  if (!facts) return [location];
  const mapIndex = facts[`legacySpatial.${actorId}.map`];
  if (typeof mapIndex !== 'number' || facts['legacySpatial.enabled'] !== 1) return [location];
  const mapId = LEGACY_MAP_IDS[mapIndex];
  if (!mapId) return [location];
  const x = facts[`legacySpatial.${actorId}.x`];
  const y = facts[`legacySpatial.${actorId}.y`];
  if (typeof x !== 'number' || typeof y !== 'number') return [location];
  try {
    return positionSites({ schema: 'frostecho.legacy-position/1',
      profileId: 'gospel-5.8.19-maps/1', mapId, cell: { x, y } }, defaultRegistry());
  } catch {
    return [location];
  }
}

/** The village resource areas, as the original `GATHER_OUTDOOR_AREAS` names them. */
export const OUTDOOR_SITES: readonly string[] = ['village'];

export function isIndoorSite(site: string): boolean {
  return (LEGACY_MAP_IDS as readonly string[]).includes(mapIdOfSite(site))
    && mapIdOfSite(site) !== 'village';
}
