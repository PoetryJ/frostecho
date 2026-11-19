/**
 * VisualSnapshot/1 — the only thing the 3D display is allowed to read.
 *
 * Ownership (E): this file and `adapter.ts` are the display adapter. They never
 * advance the clock, never move an NPC, never settle work and never write a save.
 * Every field below is copied from a record the authoritative CLI already emitted
 * (`observe` / `task-status` / `where`, plus the transport's own command records).
 *
 * Protocol notes from docs/r9-audit/WEBGPU-BRIDGE.md:
 *  - monotonic `worldVersion`; out-of-order snapshots are rejected;
 *  - 1 grid cell = 2 m, X = (gridX - 25) * 2, Z = (gridY - 20) * 2;
 *  - indoor legacy maps must NOT be plotted as village coordinates. An actor
 *    inside `dorm_a` is drawn at the building door and flagged `indoor`; the
 *    display shows where the authority says it is, not an invented interior;
 *  - NPC private memory must never enter the graphics snapshot.
 */
import { BUILDINGS } from '../../spatial-v2/map';

export const VISUAL_SCHEMA = 'frostecho.visual/1';
/** One grid cell is two metres (upstream FrostEcho-WebGPU world.js:TILE). */
export const TILE_METERS = 2;
/** Village grid origin used by the original map (upstream `toWorld`). */
export const MAP_ORIGIN = { x: 25, y: 20 } as const;

export interface Cell { x: number; y: number }
export interface WorldPoint { x: number; y: number; z: number }

/** grid -> metres, identical to FrostEcho-WebGPU `toWorld(x, y)` at f77bf54. */
export function toWorld(gridX: number, gridY: number): WorldPoint {
  return { x: (gridX - MAP_ORIGIN.x) * TILE_METERS, y: 0,
    z: (gridY - MAP_ORIGIN.y) * TILE_METERS };
}

export type ActionPhase = 'idle' | 'working' | 'blocked' | 'dead';

export interface VisualActor {
  id: string;
  name: string;
  alive: boolean;
  /** Village building the authority says the actor stands in. */
  location: string;
  /** Legacy map id from `where` (village | dorm_a | kitchen | ...). */
  mapId: string;
  /** Cell inside `mapId`. Only meaningful as village metres when mapId==='village'. */
  cell: Cell;
  /** Where the display may draw it. */
  placement: 'village' | 'building-door';
  world: WorldPoint;
  /** Building id when the actor is indoors and mapped to its door. */
  doorOf: string | null;
  action: {
    phase: ActionPhase;
    kind: string | null;
    intentId: string | null;
    startedAt: number | null;
    dueAt: number | null;
    status: string | null;
    reason: string | null;
  };
  vitals: { hunger: number | null; stamina: number | null; health: number | null;
    san: number | null; bodyTemp: number | null };
}

export interface VisualEvent {
  /** Position in the authoritative committed log; monotonic for one session. */
  ordinal: number;
  eventId: string;
  type: string;
  actorId: string;
  simTime: number;
  /** A flat, display-safe summary. Free text payloads stay in the engine. */
  detail: Record<string, string | number | boolean | null>;
}

export interface VisualSnapshot {
  schema: typeof VISUAL_SCHEMA;
  sessionId: string | null;
  profile: string;
  mode: string;
  /** Authoritative world version. Never increased by this module. */
  worldVersion: number;
  simTime: number;
  day: number;
  source: { observe: boolean; taskStatus: boolean; where: number };
  map: {
    id: 'village'; w: number; h: number; tileMeters: number; origin: Cell;
    buildings: Array<{ id: string; cell: Cell; size: Cell; door: Cell; doorWorld: WorldPoint }>;
  };
  actors: VisualActor[];
  resources: Record<string, number>;
  furnace: { lit: boolean; fuel: number; warmth: number; heatingStrength: number | null };
  production: { machines: Record<string, string>; buildRemaining: Record<string, number>;
    buildWorker: Record<string, string> };
  tasks: Array<{ taskId: string; type: string; assigneeId: string | null;
    status: string; revision: number | null }>;
  obligations: Array<{ commitmentId: string; beneficiaryId: string | null;
    status: string; dueAt: number | null }>;
  recentEvents: VisualEvent[];
  lastCommittedOrdinal: number;
}

/** The subset of the game server's `/api/state` this adapter is allowed to read. */
export interface BridgeState {
  active: boolean; sessionId: string | null; profile: string; mode: string;
  observation: Record<string, any> | null;
  status: Record<string, any> | null;
  positions: Record<string, any>;
  records: Record<string, any>[];
  lastError?: string | null;
}

export interface Catalog {
  npcs: Array<{ id: string; name: string; legacyId?: string }>;
  buildings: Array<{ id: string; x: number; y: number; w: number; h: number; door: Cell }>;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `v18:...` (and the older `v1:` form) carries the authoritative world version. */
function versionFromEventId(eventId: unknown): number {
  const match = /^v(\d+):/.exec(String(eventId ?? ''));
  return match ? Number(match[1]) : 0;
}

/** Legacy map id -> the village building that contains it. */
const MAP_TO_BUILDING: Record<string, string> = {
  warehouse: 'warehouse', kitchen: 'kitchen', medical: 'medical',
  workshop: 'workshop', command: 'command',
  dorm_a: 'dorm-a', dorm_b: 'dorm-b',
};

/** `reason` of an accepted intent reads `until 490` (see ACTION-CONTRACT). */
function dueFromReason(reason: unknown): number | null {
  const match = /^until\s+(\d+)/.exec(String(reason ?? ''));
  return match ? Number(match[1]) : null;
}

function phaseOf(executionStatus: unknown, alive: boolean): ActionPhase {
  if (!alive) return 'dead';
  switch (String(executionStatus ?? '')) {
    case 'working': return 'working';
    case 'busy': return 'working';
    case 'rejected': case 'refused': case 'stale': case 'unknown': return 'blocked';
    default: return 'idle';
  }
}

/**
 * The newest per-actor step record the transport has already emitted. This is
 * a read of finished output, not a second decision: nothing here is recomputed.
 */
function lastStepRecords(bridge: BridgeState): Map<string, Record<string, any>> {
  const found = new Map<string, Record<string, any>>();
  const rows = Array.isArray(bridge.records) ? bridge.records : [];
  for (const row of rows) {
    if (!['game-step', 'r8-step', 'step'].includes(String(row?.command))) continue;
    for (const decision of Array.isArray(row.records) ? row.records : []) {
      const actorId = String(decision?.actorId ?? '');
      if (actorId) found.set(actorId, decision);
    }
  }
  return found;
}

function pendingWork(status: Record<string, any> | null): Map<string, Record<string, any>> {
  const found = new Map<string, Record<string, any>>();
  const work = status?.r8?.work;
  if (!Array.isArray(work)) return found;
  for (const entry of work) {
    if (entry && typeof entry === 'object' && entry.actorId) found.set(String(entry.actorId), entry);
  }
  return found;
}

const EVENT_DETAIL_KEYS = ['resource', 'delta', 'amount', 'key', 'value', 'taskId', 'type',
  'receipt', 'receiptType', 'strength', 'kind', 'status', 'reason', 'to', 'mapId'];

function summariseEvent(event: Record<string, any>, ordinal: number): VisualEvent {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const detail: Record<string, string | number | boolean | null> = {};
  for (const key of EVENT_DETAIL_KEYS) {
    const value = payload[key];
    if (value === undefined) continue;
    detail[key] = typeof value === 'number' || typeof value === 'boolean'
      ? value : typeof value === 'string' ? value : String(value);
  }
  return { ordinal, eventId: String(event?.eventId ?? ''), type: String(event?.type ?? ''),
    actorId: String(event?.actorId ?? ''), simTime: numberOrNull(event?.simTime) ?? 0, detail };
}

export function buildVisualSnapshot(bridge: BridgeState,
  catalog: Catalog): { snapshot: VisualSnapshot; rejected: number } {
  const observation = bridge.observation ?? {};
  const status = bridge.status ?? {};
  const r8 = status.r8 ?? {};
  const committed: Record<string, any>[] = Array.isArray(r8.committed) ? r8.committed : [];
  const steps = lastStepRecords(bridge);
  const pending = pendingWork(bridge.status);

  // The map table comes from the authority's own catalog; the display does not
  // keep a second copy of building footprints.
  const buildings = catalog.buildings.map(building => ({
    id: building.id,
    cell: { x: building.x, y: building.y },
    size: { x: building.w, y: building.h },
    door: { ...building.door },
    doorWorld: toWorld(building.door.x, building.door.y),
  }));
  const doorWorldOf = new Map(buildings.map(building => [building.id, building.doorWorld]));

  const names = new Map(catalog.npcs.map(npc => [npc.id, npc.name]));
  const observed = new Map<string, Record<string, any>>();
  for (const npc of Array.isArray(observation.npcs) ? observation.npcs : []) {
    if (npc?.id) observed.set(String(npc.id), npc);
  }

  let rejected = 0;
  const actors: VisualActor[] = [];
  const ids = catalog.npcs.map(npc => npc.id);
  for (const id of ids) {
    const placed = bridge.positions?.[id];
    const npc = observed.get(id);
    const step = steps.get(id);
    const work = pending.get(id);
    // Without a `where` record there is no authoritative position. Drawing the
    // actor from `observe` alone would place it at an invented cell, so it is
    // counted as missing and left out of the picture instead.
    if (!placed) { if (npc) rejected += 1; continue; }

    const legacy = placed?.legacyPosition;
    const mapId = String(legacy?.mapId ?? 'village');
    const cell: Cell = legacy?.cell
      ? { x: Number(legacy.cell.x), y: Number(legacy.cell.y) }
      : { x: Number(placed?.cell?.x ?? 0), y: Number(placed?.cell?.y ?? 0) };
    const buildingId = MAP_TO_BUILDING[mapId] ?? null;
    const indoor = mapId !== 'village' && buildingId !== null && doorWorldOf.has(buildingId);
    const location = String(npc?.location ?? placed?.location ?? 'village');
    const alive = Boolean(npc?.alive ?? placed?.alive ?? true);

    // The pending intent list is the authority on "still working". A step record
    // only describes the moment of its decision: once its due time has passed and
    // no intent is pending, showing it as working would be a stale claim.
    const stepPhase = phaseOf(step?.executionStatus, alive);
    const dueAt = numberOrNull(work?.endsAt)
      ?? (() => {
        const due = dueFromReason(step?.reason);
        const simTime = numberOrNull(observation.simTime) ?? 0;
        return due !== null && due > simTime ? due : null;
      })();
    const phase: ActionPhase = !alive ? 'dead'
      : work ? (stepPhase === 'blocked' ? 'blocked' : 'working')
        : stepPhase === 'blocked' ? 'blocked' : 'idle';
    actors.push({
      id, name: names.get(id) ?? id, alive, location, mapId, cell,
      placement: indoor ? 'building-door' : 'village',
      // Indoor coordinates belong to their own 8x8 map; plotting them as village
      // metres would be a lie, so the actor stands at the real door instead.
      world: indoor ? { ...doorWorldOf.get(buildingId!)! } : toWorld(cell.x, cell.y),
      doorOf: indoor ? buildingId : null,
      action: {
        phase,
        kind: work?.kind ? String(work.kind) : null,
        intentId: work?.intentId ? String(work.intentId) : null,
        startedAt: numberOrNull(work?.startedAt),
        dueAt,
        status: step?.executionStatus ? String(step.executionStatus) : null,
        reason: step?.reason ? String(step.reason).slice(0, 120) : null,
      },
      vitals: {
        hunger: numberOrNull(npc?.hunger), stamina: numberOrNull(npc?.stamina),
        health: numberOrNull(npc?.health), san: numberOrNull(npc?.san),
        bodyTemp: numberOrNull(npc?.bodyTemp),
      },
    });
  }

  // Authoritative version = the widest version witnessed by committed events or
  // by the per-actor step records. This module never adds to it.
  let worldVersion = 0;
  for (const event of committed) {
    worldVersion = Math.max(worldVersion, versionFromEventId(event?.eventId));
  }
  for (const step of steps.values()) {
    worldVersion = Math.max(worldVersion, numberOrNull(step?.worldVersion) ?? 0);
  }

  const heating = [...committed].reverse().find(event => event?.type === 'heating_settled');
  const tasks = Array.isArray(status.tasks) ? status.tasks : Array.isArray(r8?.states?.tasks?.tasks)
    ? r8.states.tasks.tasks : [];
  const obligations = Array.isArray(status.commitments) ? status.commitments : [];

  const recentEvents = committed
    .map((event, ordinal) => ({ event, ordinal }))
    .filter(row => row.event?.type !== 'r8_actor')
    .slice(-24)
    .map(row => summariseEvent(row.event, row.ordinal));

  const snapshot: VisualSnapshot = {
    schema: VISUAL_SCHEMA,
    sessionId: bridge.sessionId,
    profile: String(bridge.profile ?? ''),
    mode: String(bridge.mode ?? ''),
    worldVersion,
    simTime: numberOrNull(observation.simTime) ?? 0,
    day: numberOrNull(observation.day) ?? 0,
    source: { observe: Boolean(bridge.observation), taskStatus: Boolean(bridge.status),
      where: Object.keys(bridge.positions ?? {}).length },
    map: {
      id: 'village', w: 50, h: 40, tileMeters: TILE_METERS,
      origin: { ...MAP_ORIGIN }, buildings,
    },
    actors,
    resources: observation.resources && typeof observation.resources === 'object'
      ? { ...observation.resources } : {},
    furnace: {
      lit: Boolean(observation.furnace?.lit),
      fuel: numberOrNull(observation.furnace?.fuel) ?? 0,
      warmth: numberOrNull(observation.furnace?.warmth) ?? 0,
      heatingStrength: numberOrNull(heating?.payload?.strength),
    },
    production: {
      machines: { ...(r8?.states?.production?.machines ?? {}) },
      buildRemaining: { ...(r8?.states?.production?.buildRemaining ?? {}) },
      buildWorker: { ...(r8?.states?.production?.buildWorker ?? {}) },
    },
    tasks: tasks.map((task: Record<string, any>) => ({
      taskId: String(task?.taskId ?? ''),
      type: String(task?.type ?? task?.kind ?? ''),
      assigneeId: task?.assigneeId ? String(task.assigneeId) : task?.actorId ? String(task.actorId) : null,
      status: String(task?.status ?? ''),
      revision: numberOrNull(task?.revision),
    })),
    obligations: obligations.map((row: Record<string, any>) => ({
      commitmentId: String(row?.commitmentId ?? row?.id ?? ''),
      beneficiaryId: row?.beneficiaryId ? String(row.beneficiaryId) : null,
      status: String(row?.status ?? ''),
      dueAt: numberOrNull(row?.dueAt),
    })),
    recentEvents,
    lastCommittedOrdinal: committed.length - 1,
  };
  return { snapshot, rejected };
}

/** Strings that only exist in an actor's private memory rendering. */
const PRIVATE_MARKERS = ['observationText', 'jointText', '记忆:', 'memoryKept', 'memoryDropped'];

/**
 * Negative control: the graphics snapshot must not carry private memory or the
 * per-actor prompt text. Throws instead of silently shipping it to a browser.
 */
export function assertNoPrivateMemory(snapshot: VisualSnapshot): void {
  const text = JSON.stringify(snapshot);
  for (const marker of PRIVATE_MARKERS) {
    if (text.includes(marker)) throw new Error(`private_memory_leaked:${marker}`);
  }
}

export type GateVerdict = 'accepted' | 'stale' | 'resync-required';

/**
 * Monotonic gate for the display. A snapshot older than the last one shown is
 * dropped (no rewinding, no cross-save interpolation); a different session needs
 * an explicit full refresh.
 */
export class VisualVersionGate {
  private sessionId: string | null = null;
  private version = -1;
  private simTime = -1;

  reset(): void { this.sessionId = null; this.version = -1; this.simTime = -1; }

  accept(next: VisualSnapshot): { verdict: GateVerdict; reason: string } {
    if (this.sessionId !== null && next.sessionId !== this.sessionId) {
      return { verdict: 'resync-required', reason: 'session_changed' };
    }
    if (next.worldVersion < this.version || next.simTime < this.simTime) {
      return { verdict: 'stale', reason: `older_than_shown:v${this.version}@${this.simTime}` };
    }
    this.sessionId = next.sessionId;
    this.version = next.worldVersion;
    this.simTime = next.simTime;
    return { verdict: 'accepted', reason: this.version === next.worldVersion ? 'same_version' : 'advanced' };
  }
}

/** Static source identities the display pins in its HUD. */
export function mapIdentity(catalog: Catalog): string {
  return `village/${catalog.buildings.length}buildings/${BUILDINGS.length}catalog`;
}
