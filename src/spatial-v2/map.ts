/**
 * Spatial layer v2 (R3, P). Grids, obstacles and A* pathfinding ported from
 * the sealed legacy reference (village-map.js / indoor maps / pathfinding.js):
 * the 50x40 village with 7 buildings whose walls are solid except their door
 * cells, the 10x8 warehouse and 8x8 kitchen interiors with furniture zones.
 *
 * This module is pure geometry: it knows nothing about world state or
 * commands. WorldV2 stays the single authority — travel commands are
 * validated against these helpers and recorded as world events.
 */
export type Cell = { x: number; y: number };

export interface Building {
  id: string;
  x: number; y: number; w: number; h: number;
  door: Cell;
}

export interface IndoorFurniture {
  x: number; y: number; w: number; h: number;
  label: string;
}

export type MapId = 'village' | 'warehouse' | 'kitchen';

export interface GridMap {
  id: MapId;
  w: number;
  h: number;
  /** Solid rectangles (building footprints in the village, furniture indoors). */
  solids: Array<{ x: number; y: number; w: number; h: number }>;
  /** Walkable door cells inside solid rectangles (village buildings). */
  doors: Record<string, Cell>;
  /** Interest cells (village: resource areas use a representative cell). */
  interests: Record<string, Cell>;
}

export const BUILDINGS: Building[] = [
  { id: 'warehouse', x: 13, y: 11, w: 6, h: 4, door: { x: 16, y: 15 } },
  { id: 'medical', x: 30, y: 11, w: 6, h: 4, door: { x: 33, y: 15 } },
  { id: 'dorm-a', x: 13, y: 18, w: 7, h: 5, door: { x: 16, y: 23 } },
  { id: 'dorm-b', x: 30, y: 18, w: 7, h: 5, door: { x: 33, y: 23 } },
  { id: 'kitchen', x: 13, y: 26, w: 5, h: 4, door: { x: 15, y: 30 } },
  { id: 'workshop', x: 21, y: 26, w: 7, h: 4, door: { x: 24, y: 30 } },
  { id: 'command', x: 33, y: 26, w: 4, h: 3, door: { x: 35, y: 29 } },
];

export const RESOURCE_AREAS: Array<{ id: string; cell: Cell }> = [
  { id: 'lumber_camp', cell: { x: 5, y: 5 } },
  { id: 'frozen_lake', cell: { x: 5, y: 35 } },
  { id: 'ruins_site', cell: { x: 43, y: 5 } },
  { id: 'ore_pile', cell: { x: 43, y: 35 } },
];

/** Legacy spawns: where an npc stands right after leaving each building. */
export const EXIT_SPAWNS: Record<string, Cell> = {
  kitchen: { x: 15, y: 31 },
  warehouse: { x: 16, y: 16 },
};

function villageMap(): GridMap {
  const doors: Record<string, Cell> = {};
  const solids: GridMap['solids'] = [];
  for (const building of BUILDINGS) {
    solids.push({ x: building.x, y: building.y, w: building.w, h: building.h });
    doors[building.id] = building.door;
  }
  const interests: Record<string, Cell> = {};
  for (const area of RESOURCE_AREAS) interests[area.id] = area.cell;
  return { id: 'village', w: 50, h: 40, solids, doors, interests };
}

/** Warehouse interior: 10x8, walls with a south door, four furniture zones. */
function warehouseMap(): GridMap {
  const w = 10, h = 8;
  const doorX = Math.floor(w / 2) - 1;
  const solids: GridMap['solids'] = [];
  for (let x = 0; x < w; x += 1) {
    if (x !== doorX && x !== doorX + 1) solids.push({ x, y: h - 1, w: 1, h: 1 });
  }
  for (let y = 0; y < h; y += 1) solids.push({ x: 0, y, w: 1, h: 1 }, { x: w - 1, y, w: 1, h: 1 });
  for (let x = 0; x < w; x += 1) solids.push({ x, y: 0, w: 1, h: 1 });
  return {
    id: 'warehouse', w, h, solids,
    doors: { exit: { x: doorX, y: h - 1 } },
    interests: { food: { x: 7, y: 3 }, wood: { x: 2, y: 3 } },
  };
}

/** Kitchen interior: 8x8, south door, stove / pantry / table. */
function kitchenMap(): GridMap {
  const w = 8, h = 8;
  const doorX = Math.floor(w / 2) - 1;
  const solids: GridMap['solids'] = [];
  for (let x = 0; x < w; x += 1) {
    if (x !== doorX && x !== doorX + 1) solids.push({ x, y: h - 1, w: 1, h: 1 });
  }
  for (let y = 0; y < h; y += 1) solids.push({ x: 0, y, w: 1, h: 1 }, { x: w - 1, y, w: 1, h: 1 });
  for (let x = 0; x < w; x += 1) solids.push({ x, y: 0, w: 1, h: 1 });
  solids.push({ x: 1, y: 1, w: 3, h: 1 }, { x: 5, y: 1, w: 2, h: 2 }, { x: 2, y: 4, w: 4, h: 2 });
  return {
    id: 'kitchen', w, h, solids,
    doors: { exit: { x: doorX, y: h - 1 } },
    interests: { pantry: { x: 5, y: 2 }, stove: { x: 2, y: 1 }, table: { x: 3, y: 5 } },
  };
}

export const MAPS: Record<MapId, GridMap> = {
  village: villageMap(),
  warehouse: warehouseMap(),
  kitchen: kitchenMap(),
};

export function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

export function parseCellKey(key: string): Cell {
  const [x, y] = key.split(',').map(part => Number.parseInt(part, 10));
  return { x, y };
}

export function inBounds(map: GridMap, cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < map.w && cell.y < map.h;
}

export function isWalkable(map: GridMap, cell: Cell, closedCells: ReadonlySet<string>): boolean {
  if (!inBounds(map, cell)) return false;
  const key = cellKey(cell);
  if (closedCells.has(key)) return false;
  for (const solid of map.solids) {
    const hit = cell.x >= solid.x && cell.x < solid.x + solid.w
      && cell.y >= solid.y && cell.y < solid.y + solid.h;
    if (!hit) continue;
    // Door cells stay walkable even inside the building footprint.
    const isDoor = Object.values(map.doors).some(door => door.x === cell.x && door.y === cell.y);
    if (!isDoor) return false;
  }
  return true;
}

function neighbours(map: GridMap, cell: Cell): Cell[] {
  return [{ x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 }];
}

function manhattan(from: Cell, to: Cell): number {
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
}

/** Nearest walkable cell to a goal (legacy goal-correction behaviour). */
export function nearestWalkable(map: GridMap, goal: Cell,
  closedCells: ReadonlySet<string>): Cell | null {
  if (isWalkable(map, goal, closedCells)) return goal;
  for (let radius = 1; radius < Math.max(map.w, map.h); radius += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const candidate = { x: goal.x + dx, y: goal.y + dy };
        if (isWalkable(map, candidate, closedCells)) return candidate;
      }
    }
  }
  return null;
}

export interface PathResult {
  path: Cell[] | null;
  blockedBy: 'unreachable' | 'no-goal' | null;
  /** Cells on the straight-ish corridor the path depends on. */
  corridor: string[];
}

/**
 * A* over 4-neighbour tiles (legacy pathfinding.js): Manhattan heuristic,
 * deterministic tie-breaking by (f, x, y). Returns the full cell path
 * including the start cell, or null with a reason when closed roads make the
 * goal unreachable.
 */
export function findPath(map: GridMap, from: Cell, to: Cell,
  closedCells: ReadonlySet<string> = new Set()): PathResult {
  const goal = nearestWalkable(map, to, closedCells);
  if (!goal) return { path: null, blockedBy: 'no-goal', corridor: [] };
  const startKey = cellKey(from);
  const goalKey = cellKey(goal);
  const open: Array<{ key: string; cell: Cell; f: number; g: number }> = [
    { key: startKey, cell: from, f: manhattan(from, goal), g: 0 }];
  const cameFrom = new Map<string, string>();
  const bestG = new Map<string, number>([[startKey, 0]]);
  const closed = new Set<string>();
  while (open.length > 0) {
    open.sort((left, right) => left.f - right.f || left.cell.x - right.cell.x
      || left.cell.y - right.cell.y);
    const current = open.shift()!;
    if (current.key === goalKey) {
      const path: Cell[] = [];
      let walk: string | undefined = current.key;
      while (walk !== undefined) {
        path.unshift(parseCellKey(walk));
        walk = cameFrom.get(walk);
      }
      return { path, blockedBy: null, corridor: path.map(cellKey) };
    }
    closed.add(current.key);
    for (const next of neighbours(map, current.cell)) {
      const key = cellKey(next);
      if (closed.has(key)) continue;
      if (!isWalkable(map, next, closedCells)) continue;
      const g = current.g + 1;
      if (g < (bestG.get(key) ?? Number.POSITIVE_INFINITY)) {
        bestG.set(key, g);
        cameFrom.set(key, current.key);
        open.push({ key, cell: next, f: g + manhattan(next, goal), g });
      }
    }
  }
  return { path: null, blockedBy: 'unreachable', corridor: [] };
}
