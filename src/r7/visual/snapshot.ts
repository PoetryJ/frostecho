/**
 * VisualSnapshot/1 — the only thing the 3D and 2D displays are allowed to read.
 *
 * Ownership (E): this file and `adapter.ts` are the display adapter. They never
 * advance the clock, never move an NPC, never settle work and never write a save.
 * Every field below is copied from a record the authoritative CLI already emitted
 * (`observe` / `task-status` / `where` / committed receipts), never recomputed.
 *
 * Protocol notes from docs/r9-audit/WEBGPU-BRIDGE.md:
 *  - monotonic `worldVersion`; out-of-order snapshots are rejected;
 *  - 1 grid cell = 2 m, X = (gridX - 25) * 2, Z = (gridY - 20) * 2;
 *  - indoor legacy maps must NOT be plotted as village coordinates. An actor
 *    inside `dorm_a` is drawn at the building door and flagged `indoor`; the
 *    display shows where the authority says it is, not an invented interior;
 *  - NPC private memory must never enter the graphics snapshot. R11 adds a
 *    display-safe *projection summary* (counts/counter/ids only) so the player
 *    can see what B's bounded memory did without reading the prompt text.
 */
import { BUILDINGS } from '../../spatial-v2/map';

export const VISUAL_SCHEMA = 'frostecho.visual/1';
/** One grid cell is two metres (upstream FrostEcho-WebGPU world.js:TILE). */
export const TILE_METERS = 2;
/** Village grid origin used by the original map (upstream `toWorld`). */
export const MAP_ORIGIN = { x: 25, y: 20 } as const;
/** The runner the display is attached to. Never a second one. */
export const VISUAL_RUNNER = 'dist/scripts/play-sprint.js';

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

/** One committed original-map move. The route is what was actually walked. */
export interface VisualLeg {
  eventId: string;
  type: 'cell' | 'door';
  actorId: string;
  simTime: number;
  commandId: string;
  fromMap: string;
  toMap: string;
  from: Cell;
  to: Cell;
  minutes: number;
}

export interface VisualRoute {
  actorId: string;
  legs: VisualLeg[];
  summary: { tiles: number; doors: number; minutes: number;
    fromMap: string | null; from: Cell | null; toMap: string | null; to: Cell | null };
}

export interface VisualStock {
  /** Last authoritative warehouse food observation/receipt, not a live guess. */
  warehouse: { remaining: number | null; eventId: string | null; simTime: number | null;
    source: string | null; commandId: string | null };
  /** Last stock movement that carried meals (withdraw/deliver). */
  carry: { meals: number | null; eventId: string | null; simTime: number | null };
  /** Public resource pool, straight from `observe`. */
  public: Record<string, number>;
}

export interface VisualTask {
  taskId: string;
  type: string;
  assigneeId: string | null;
  status: string;
  revision: number | null;
  commitmentId: string | null;
  source: 'board' | 'domain';
}

export interface VisualChange {
  changeId: string;
  kind: string;
  status: string;
  proposedAt: number | null;
  source: string | null;
  reason: string | null;
}

export interface VisualObligation {
  commitmentId: string;
  taskId: string | null;
  promisorId: string | null;
  beneficiaryId: string | null;
  goal: string;
  status: string;
  revision: number | null;
  dueAt: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  changes: VisualChange[];
  /** Receipt ids only; the page links them to the receipt list. */
  evidenceEventIds: string[];
}

/** B's bounded-memory projection, reduced to numbers and opaque ids. */
export interface VisualProjection {
  selection: string | null;
  counterId: string | null;
  budget: number | null;
  tokens: number | null;
  kept: number | null;
  dropped: number | null;
  /** Records that left the raw window because an applicable note owned them. */
  suppressed: number | null;
  noteIds: string[];
  requestId: string | null;
  worldVersion: number | null;
  /** Optional fields from B's r11 window; only present when the CLI emits them. */
  truncated: number | null;
  bytes: number | null;
  blockSha256: string | null;
  segmentSha256: string | null;
  encoderTokens: number | null;
}

/** One receipt that moves a promise forward; the page never recomputes it. */
export interface VisualProgress {
  eventId: string;
  type: string;
  actorId: string;
  simTime: number;
  detail: Record<string, string | number | boolean | null>;
}

export interface VisualWork {
  intentId: string;
  actorId: string;
  kind: string;
  taskId: string | null;
  commitmentId: string | null;
  startedAt: number | null;
  endsAt: number | null;
}

export interface VisualSnapshot {
  schema: typeof VISUAL_SCHEMA;
  sessionId: string | null;
  profile: string;
  mode: string;
  runner: string;
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
  tasks: VisualTask[];
  obligations: VisualObligation[];
  work: VisualWork[];
  /** Last receipts that can move a promise forward, newest last. */
  progress: VisualProgress[];
  stock: VisualStock;
  routes: VisualRoute[];
  projections: Record<string, VisualProjection>;
  scorer: { scorerId: string | null; mode: string | null; rendererId: string | null;
    experimental: boolean | null; countsAsAdmitted: boolean | null };
  save: { savedAt: string | null; canContinue: boolean };
  ending: string;
  crises: { active: Array<{ crisisId: string; kind: string; startedAtMinute: number | null;
    detail: string | null }>; resolved: number };
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
  savedAt?: string | null;
  canContinue?: boolean;
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
  'receipt', 'receiptType', 'strength', 'kind', 'status', 'reason', 'to', 'mapId',
  'remaining', 'place', 'carried', 'total', 'totalDelivered'];

function summariseEvent(event: Record<string, any>, ordinal: number): VisualEvent {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const detail: Record<string, string | number | boolean | null> = {};
  for (const key of EVENT_DETAIL_KEYS) {
    const value = payload[key];
    if (value === undefined) continue;
    detail[key] = typeof value === 'number' || typeof value === 'boolean'
      ? value : typeof value === 'string' ? value : String(value);
  }
  return { ordinal: ordinal, eventId: String(event?.eventId ?? ''), type: String(event?.type ?? ''),
    actorId: String(event?.actorId ?? ''), simTime: numberOrNull(event?.simTime) ?? 0, detail };
}

interface ReceiptRow { event: Record<string, any>; order: number }

/**
 * One merged, de-duplicated receipt stream.
 *
 * `r8.committed` is the runtime ledger; the transport records carry the raw
 * WorldEvents of direct commands (`withdraw`, `deposit`, `travel`, `advance`).
 * A stock movement committed by `withdraw` is NOT in the runtime ledger, so the
 * display would otherwise keep an older observation and claim the warehouse is
 * full. Ties at one world minute go to the later record, which is the command
 * order the CLI actually executed.
 */
function mergedEvents(bridge: BridgeState, committed: Record<string, any>[]): ReceiptRow[] {
  const seen = new Map<string, ReceiptRow>();
  let order = 0;
  const add = (event: Record<string, any>): void => {
    const id = String(event?.eventId ?? '');
    if (!id || seen.has(id)) return;
    seen.set(id, { event, order: order++ });
  };
  for (const event of committed) add(event);
  for (const row of Array.isArray(bridge.records) ? bridge.records : []) {
    for (const event of Array.isArray(row?.events) ? row.events : []) add(event);
  }
  return [...seen.values()];
}

/**
 * The committed original-map legs. Only receipts the authority already wrote are
 * shown: a planned route would be a promise, not a road actually walked.
 */
function collectRoutes(rows: ReceiptRow[]): VisualRoute[] {
  const byActor = new Map<string, VisualLeg[]>();
  for (const { event } of rows) {
    const type = String(event?.type ?? '');
    if (type !== 'legacy_cell_moved' && type !== 'legacy_door_crossed') continue;
    const payload = event?.payload ?? {};
    const actorId = String(event?.actorId ?? '');
    if (!actorId) continue;
    const cell = (x: unknown, y: unknown): Cell => ({ x: Number(x ?? 0), y: Number(y ?? 0) });
    const legs = byActor.get(actorId) ?? [];
    legs.push({
      eventId: String(event?.eventId ?? ''),
      type: type === 'legacy_door_crossed' ? 'door' : 'cell',
      actorId,
      simTime: numberOrNull(event?.simTime) ?? 0,
      commandId: String(payload.commandId ?? ''),
      fromMap: String(payload.fromMap ?? ''),
      toMap: String(payload.toMap ?? ''),
      from: cell(payload.fromX, payload.fromY),
      to: cell(payload.x, payload.y),
      minutes: numberOrNull(payload.minutes) ?? 1,
    });
    byActor.set(actorId, legs);
  }
  return [...byActor.entries()].map(([actorId, all]) => {
    const legs = all.slice(-64);
    const first = legs[0], last = legs.at(-1);
    return {
      actorId,
      legs,
      summary: {
        tiles: legs.filter(leg => leg.type === 'cell').length,
        doors: legs.filter(leg => leg.type === 'door').length,
        minutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
        fromMap: first?.fromMap ?? null,
        from: first?.from ?? null,
        toMap: last?.toMap ?? null,
        to: last?.to ?? null,
      },
    };
  });
}

/**
 * The last authoritative warehouse/carry receipt. The value is what the engine
 * committed, never a locally decremented counter; a stock that was never looked
 * at stays null and the HUD says so.
 */
function collectStock(rows: ReceiptRow[], resources: Record<string, number>): VisualStock {
  const stock: VisualStock = {
    warehouse: { remaining: null, eventId: null, simTime: null, source: null, commandId: null },
    carry: { meals: null, eventId: null, simTime: null },
    public: { ...resources },
  };
  const observationTypes = new Set(['warehouse_stock_observed', 'stock_withdrawn', 'stock_deposited',
    'out_of_stock', 'stock_restocked']);
  const ordered = [...rows].sort((a, b) => (numberOrNull(a.event?.simTime) ?? 0)
    - (numberOrNull(b.event?.simTime) ?? 0) || a.order - b.order);
  for (const { event } of ordered) {
    const type = String(event?.type ?? '');
    if (type === 'stock_withdrawn') {
      const carried = numberOrNull(event?.payload?.carried ?? event?.payload?.amount);
      if (carried !== null) stock.carry = { meals: carried, eventId: String(event?.eventId ?? ''),
        simTime: numberOrNull(event?.simTime) };
    }
    if (type === 'meal_delivered') {
      stock.carry = { meals: 0, eventId: String(event?.eventId ?? ''),
        simTime: numberOrNull(event?.simTime) };
    }
    if (!observationTypes.has(type)) continue;
    const payload = event?.payload ?? {};
    const raw = type === 'stock_deposited' ? payload.total
      : type === 'out_of_stock' ? 0 : payload.remaining;
    const remaining = numberOrNull(raw);
    if (remaining === null) continue;
    stock.warehouse = { remaining, eventId: String(event?.eventId ?? ''),
      simTime: numberOrNull(event?.simTime), source: type,
      commandId: payload.commandId ? String(payload.commandId) : null };
  }
  return stock;
}

/** B's projection reduced to numbers: no prompt text, no lesson copy. */
function projectionOf(step: Record<string, any> | undefined): VisualProjection | null {
  if (!step) return null;
  const notes = Array.isArray(step.memoryNotes) ? step.memoryNotes : [];
  return {
    selection: step.memorySelection ? String(step.memorySelection) : null,
    counterId: step.memoryCounterId ? String(step.memoryCounterId) : null,
    budget: numberOrNull(step.memoryBudget),
    tokens: numberOrNull(step.memoryTokens),
    kept: numberOrNull(step.memoryKept),
    dropped: numberOrNull(step.memoryDropped),
    suppressed: numberOrNull(step.memoryNoteSuppressed),
    noteIds: notes.map((note: Record<string, any>) => String(note?.noteId ?? '')).filter(Boolean),
    requestId: step.requestId ? String(step.requestId) : null,
    worldVersion: numberOrNull(step.worldVersion),
    truncated: numberOrNull(step.memoryTruncated),
    bytes: numberOrNull(step.memoryBytes),
    blockSha256: step.memoryBlockSha256 ? String(step.memoryBlockSha256) : null,
    segmentSha256: step.memorySegmentSha256 ? String(step.memorySegmentSha256) : null,
    encoderTokens: numberOrNull(step.memoryEncoderTokens),
  };
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
  const rows = mergedEvents(bridge, committed);
  let worldVersion = 0;
  for (const { event } of rows) {
    worldVersion = Math.max(worldVersion, versionFromEventId(event?.eventId));
  }
  for (const step of steps.values()) {
    worldVersion = Math.max(worldVersion, numberOrNull(step?.worldVersion) ?? 0);
  }

  const heating = [...rows].reverse().map(row => row.event)
    .find(event => event?.type === 'heating_settled');
  const tasks = Array.isArray(status.tasks) ? status.tasks : Array.isArray(r8?.states?.tasks?.tasks)
    ? r8.states.tasks.tasks : [];
  const obligations = Array.isArray(status.commitments) ? status.commitments : [];

  const recentEvents = [...rows]
    .sort((a, b) => (numberOrNull(a.event?.simTime) ?? 0) - (numberOrNull(b.event?.simTime) ?? 0)
      || a.order - b.order)
    .filter(row => row.event?.type !== 'r8_actor')
    .slice(-24)
    .map(row => summariseEvent(row.event, row.order));

  const routes = collectRoutes(rows);
  const PROGRESS_TYPES = new Set(['gathered', 'stock_deposited', 'stock_withdrawn',
    'out_of_stock', 'warehouse_stock_observed', 'meal_delivered', 'commitment_proposed',
    'commitment_accepted', 'commitment_change_proposed', 'commitment_change_accepted',
    'commitment_cancelled', 'commitment_fulfilled', 'commitment_withdrawn']);
  const progress: VisualProgress[] = [...rows]
    .sort((a, b) => (numberOrNull(a.event?.simTime) ?? 0) - (numberOrNull(b.event?.simTime) ?? 0)
      || a.order - b.order)
    .filter(row => PROGRESS_TYPES.has(String(row.event?.type ?? '')))
    .slice(-48)
    .map(row => summariseEvent(row.event, row.order))
    .map(event => ({ eventId: event.eventId, type: event.type, actorId: event.actorId,
      simTime: event.simTime, detail: event.detail }));
  const stock = collectStock(rows, observation.resources && typeof observation.resources === 'object'
    ? observation.resources : {});
  const projections: Record<string, VisualProjection> = {};
  for (const [actorId, step] of steps) {
    const projection = projectionOf(step);
    if (projection) projections[actorId] = projection;
  }
  const work: VisualWork[] = [];
  for (const entry of Array.isArray(r8.work) ? r8.work : []) {
    if (!entry || typeof entry !== 'object') continue;
    work.push({ intentId: String(entry.intentId ?? ''), actorId: String(entry.actorId ?? ''),
      kind: String(entry.kind ?? ''), taskId: entry.taskId ? String(entry.taskId) : null,
      commitmentId: entry.commitmentId ? String(entry.commitmentId) : null,
      startedAt: numberOrNull(entry.startedAt), endsAt: numberOrNull(entry.endsAt) });
  }

  const snapshot: VisualSnapshot = {
    schema: VISUAL_SCHEMA,
    sessionId: bridge.sessionId,
    profile: String(bridge.profile ?? ''),
    mode: String(bridge.mode ?? ''),
    runner: VISUAL_RUNNER,
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
      commitmentId: task?.commitmentId ? String(task.commitmentId) : null,
      source: task?.domain === 'r8' ? 'domain' as const : 'board' as const,
    })),
    obligations: obligations.map((row: Record<string, any>) => ({
      commitmentId: String(row?.commitmentId ?? row?.id ?? ''),
      taskId: row?.taskId ? String(row.taskId) : null,
      promisorId: row?.promisorId ? String(row.promisorId) : null,
      beneficiaryId: row?.beneficiaryId ? String(row.beneficiaryId) : null,
      goal: String(row?.goal ?? ''),
      status: String(row?.status ?? ''),
      revision: numberOrNull(row?.revision),
      dueAt: numberOrNull(row?.deadline),
      createdAt: numberOrNull(row?.createdAt),
      updatedAt: numberOrNull(row?.updatedAt),
      changes: (Array.isArray(row?.changes) ? row.changes : []).map((change: Record<string, any>) => ({
        changeId: String(change?.changeId ?? ''),
        kind: String(change?.kind ?? ''),
        status: String(change?.status ?? ''),
        proposedAt: numberOrNull(change?.proposedAt),
        source: change?.terms?.source ? String(change.terms.source) : null,
        reason: change?.reason ? String(change.reason).slice(0, 120) : null,
      })),
      evidenceEventIds: (Array.isArray(row?.evidenceEventIds) ? row.evidenceEventIds : [])
        .map((id: unknown) => String(id)),
    })),
    work,
    progress,
    stock,
    routes,
    projections,
    scorer: {
      scorerId: status.scorer?.scorerId ? String(status.scorer.scorerId) : null,
      mode: status.scorer?.mode ? String(status.scorer.mode) : null,
      rendererId: status.scorer?.rendererId ? String(status.scorer.rendererId) : null,
      experimental: typeof status.scorer?.experimental === 'boolean' ? status.scorer.experimental : null,
      countsAsAdmitted: typeof status.scorer?.countsAsAdmitted === 'boolean'
        ? status.scorer.countsAsAdmitted : null,
    },
    save: { savedAt: bridge.savedAt ?? null, canContinue: Boolean(bridge.canContinue) },
    ending: String(status.ending ?? r8.endingKind ?? 'none'),
    crises: {
      active: (Array.isArray(r8?.states?.crises?.active) ? r8.states.crises.active : [])
        .map((crisis: Record<string, any>) => ({
          crisisId: String(crisis?.crisisId ?? ''),
          kind: String(crisis?.kind ?? ''),
          startedAtMinute: numberOrNull(crisis?.startedAtMinute),
          detail: crisis?.detail ? String(crisis.detail).slice(0, 160) : null,
        })),
      resolved: Array.isArray(r8?.states?.crises?.history) ? r8.states.crises.history.length : 0,
    },
    recentEvents,
    lastCommittedOrdinal: committed.length - 1,
  };
  return { snapshot, rejected };
}

/** Strings that only exist in an actor's private prompt/memory rendering. */
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
