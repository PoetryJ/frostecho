/**
 * WorldV2 survival core (F). Authority lives here: every change goes through a
 * command -> event -> new state, all randomness is derived from a recorded
 * seed, and snapshots carry the rule version so migration is explicit.
 *
 * Naming warning from the handoff: `hunger` is satiety in the legacy game --
 * larger means fuller. Eating increases it. Do not invert it again (G05).
 */

export const WORLD_V2_SCHEMA = 'frostecho.world-v2/2';
export const RULES_VERSION = 'survival-rules/2';
export const MINUTES_PER_HOUR = 60;

import { createHash } from 'node:crypto';
import { BUILDINGS, MAPS, cellKey, isWalkable, type Cell } from '../spatial-v2/map';
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** Documented default for the lazily-created warehouse stock (R3, P). */
export const DEFAULT_WAREHOUSE_FOOD = 4;
/** R4: documented extra stamina a traveller pays per tile (charged once). */
export const TRAVEL_STAMINA_PER_TILE = 0.08;

export type Weather = 'clear' | 'snow' | 'storm' | 'cold-snap';
export type LocationId = 'dorm-a' | 'dorm-b' | 'kitchen' | 'warehouse' | 'workshop' | 'medical' | 'command' | 'village';

export interface NpcState {
  id: string;
  location: LocationId;
  /** satiety 0..100; larger = fuller */
  hunger: number;
  stamina: number;
  health: number;
  san: number;
  alive: boolean;
}

export interface WorldV2 {
  schema: string;
  rulesVersion: string;
  day: number;
  simTime: number;
  version: number;
  rngSeed: string;
  weather: Weather;
  npcs: Record<string, NpcState>;
  resources: { food: number; firewood: number; power: number; medicine: number };
  furnace: { lit: boolean; fuel: number; warmth: number };
  commandLog: string[];
  /**
   * R2 frozen receipt ledger (owner). Keyed by commandId; records the command
   * digest plus the FIRST authoritative outcome. A duplicate submit with the
   * same digest replays this receipt; a different digest is an explicit
   * conflict. Optional so pre-R2 snapshots load unchanged.
   */
  receipts?: Record<string, { digest: string; eventIds: string[]; postStateVersion: number }>;
  /**
   * R3 spatial extension (P). Optional: absent while no spatial command has
   * run, so pre-R3 snapshots and the frozen matrix flows stay byte-identical.
   * Lazily initialized with the documented defaults on first use.
   */
  spatial?: SpatialState;
  dead: string[];
  ending: 'none' | 'survived' | 'all-dead';
  /** Scenario length in real days; the ending is decided by elapsed simTime. */
  scenarioDays: number;
}

/** R3 spatial bookkeeping: grid positions, place stocks, carried meals, closed cells. */
export interface SpatialState {
  /** Actor cell on the village grid; untracked actors resolve to their door. */
  positions: Record<string, Cell>;
  stocks: { warehouse: { food: number } };
  carry: Record<string, { meals: number }>;
  closedCells: string[];
  deliveredMeals: number;
}

export type Command =
  | { commandId: string; type: 'advance'; minutes: number; recovery?: boolean }
  | { commandId: string; type: 'gather'; actorId: string; resource: 'food' | 'firewood'; amount: number }
  | { commandId: string; type: 'eat'; actorId: string; amount: number }
  | { commandId: string; type: 'rest'; actorId: string; minutes: number }
  | { commandId: string; type: 'work'; actorId: string; minutes: number }
  | { commandId: string; type: 'refuel'; actorId: string; amount: number }
  | { commandId: string; type: 'medical'; actorId: string; targetId: string; amount: number }
  | { commandId: string; type: 'move'; actorId: string; to: LocationId }
  | { commandId: string; type: 'reserve'; actorId: string; forId: string; amount: number }
  | { commandId: string; type: 'travel'; actorId: string; route: Array<{ x: number; y: number }>; minutesPerTile: number }
  | { commandId: string; type: 'withdraw'; actorId: string; place: 'warehouse'; resource: 'food'; amount: number }
  | { commandId: string; type: 'deposit'; actorId: string; place: 'warehouse'; resource: 'food'; amount: number }
  | { commandId: string; type: 'restock'; place: 'warehouse'; resource: 'food'; amount: number; source: string }
  | { commandId: string; type: 'deliver'; actorId: string; to: 'kitchen'; amount: number }
  | { commandId: string; type: 'close-road'; cells: Array<{ x: number; y: number }> }
  | { commandId: string; type: 'open-road'; cells: Array<{ x: number; y: number }> };

export interface WorldEvent {
  eventId: string;
  type: string;
  simTime: number;
  actorId?: string;
  payload: Record<string, number | string | boolean>;
}

export class SurvivalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SurvivalError';
    this.code = code;
  }
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Deterministic PRNG: same seed and same counter produce the same draw. */
export function hashUnit(seed: string, counter: number, channel: string): number {
  let state = 2166136261;
  const text = `${seed}|${counter}|${channel}`;
  for (let index = 0; index < text.length; index += 1) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 16777619) >>> 0;
  }
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 4294967296;
}

export function createWorldV2(input: {
  npcIds: string[];
  days?: number;
  weather?: Weather;
  resources?: Partial<WorldV2['resources']>;
  rngSeed?: string;
}): WorldV2 {
  const npcs: Record<string, NpcState> = {};
  input.npcIds.forEach((id, index) => {
    npcs[id] = {
      id,
      location: index % 2 === 0 ? 'dorm-a' : 'dorm-b',
      hunger: 70,
      stamina: 80,
      health: 100,
      san: 80,
      alive: true,
    };
  });
  return {
    schema: WORLD_V2_SCHEMA,
    rulesVersion: RULES_VERSION,
    day: 1,
    simTime: 0,
    version: 0,
    rngSeed: input.rngSeed ?? 'seed-1116',
    weather: input.weather ?? 'snow',
    npcs,
    resources: { food: 24, firewood: 20, power: 40, medicine: 2, ...input.resources },
    furnace: { lit: true, fuel: 6, warmth: 18 },
    commandLog: [],
    dead: [],
    ending: 'none',
    scenarioDays: input.days ?? 4,
  };
}

function bump(state: WorldV2, event: WorldEvent): WorldV2 {
  return { ...state, version: state.version + 1 };
}

function event(state: WorldV2, command: Command, type: string, payload: WorldEvent['payload'] = {}): WorldEvent {
  return { eventId: `${command.commandId}:${type}:${state.version}`, type, simTime: state.simTime,
    ...('actorId' in command && command.actorId ? { actorId: command.actorId } : {}), payload };
}

function needNpc(state: WorldV2, actorId: string): NpcState {
  const npc = state.npcs[actorId];
  if (!npc) throw new SurvivalError('unknown_actor', `unknown actor ${actorId}`);
  if (!npc.alive) throw new SurvivalError('dead_actor', `${actorId} is dead`);
  return npc;
}

/** Deep copy (or documented default) so spatial commands never alias old state. */
function cloneSpatial(state: WorldV2): SpatialState {
  if (!state.spatial) {
    return { positions: {}, stocks: { warehouse: { food: DEFAULT_WAREHOUSE_FOOD } },
      carry: {}, closedCells: [], deliveredMeals: 0 };
  }
  const source = state.spatial;
  const positions: SpatialState['positions'] = {};
  for (const [id, cell] of Object.entries(source.positions)) positions[id] = { ...cell };
  const carry: SpatialState['carry'] = {};
  for (const [id, entry] of Object.entries(source.carry)) carry[id] = { meals: entry.meals };
  return { positions, carry, closedCells: [...source.closedCells],
    stocks: { warehouse: { food: source.stocks.warehouse.food } },
    deliveredMeals: source.deliveredMeals };
}

/** An actor that never traveled stands at its building's door (village centre fallback). */
function positionOf(space: SpatialState, npc: NpcState): Cell {
  const existing = space.positions[npc.id];
  if (existing) return existing;
  const building = BUILDINGS.find(entry => entry.id === npc.location);
  return building ? { ...building.door } : { x: 25, y: 8 };
}

/**
 * R4 (G3): the single world-clock rule. Every span of simulated time — an
 * explicit advance, a travel leg, a rest-like command — evolves the SAME
 * things in the SAME order: furnace fuel, every NPC's needs/damage/death,
 * calendar day and ending. Callers own only the command-specific extras.
 * Returns the ids that died during the span.
 */
function evolveSpan(state: WorldV2, minutes: number, options: {
  recovery?: boolean;
  travelerId?: string;
  extraStamina?: number;
} = {}): string[] {
  const hours = minutes / MINUTES_PER_HOUR;
  // Furnace fuel is a world resource: burn it once per span, not per npc.
  const wanted = 0.4 * hours;
  const burned = state.furnace.lit ? Math.min(state.furnace.fuel, wanted) : 0;
  state.furnace.fuel = clamp(state.furnace.fuel - burned, 0, 100);
  if (state.furnace.fuel <= 0) state.furnace.lit = false;
  const coldHours = state.furnace.lit ? 0 : hours;
  const deaths: string[] = [];
  for (const npc of Object.values(state.npcs)) {
    if (!npc.alive) continue;
    const decay = 0.9 * hours + (state.weather === 'cold-snap' ? 0.4 * hours : 0);
    const staminaDrain = 1.5 * hours;
    npc.hunger = clamp(npc.hunger - decay, 0, 100);
    // `recovery` marks an overnight span: the npc sleeps through it.
    npc.stamina = clamp(npc.stamina + (options.recovery ? 8 * hours : -staminaDrain), 0, 100);
    if (options.recovery) npc.san = clamp(npc.san + 2 * hours, 0, 100);
    if (npc.hunger <= 0) npc.health = clamp(npc.health - 4 * hours, 0, 100);
    if (coldHours > 0 && state.weather !== 'clear') {
      npc.health = clamp(npc.health - 1.2 * coldHours, 0, 100);
    }
    npc.san = clamp(npc.san - (npc.hunger < 20 ? 1.4 * hours : 0.2 * hours), 0, 100);
    // The traveller's extra cost is explicit and charged exactly once.
    if (options.travelerId === npc.id && options.extraStamina) {
      npc.stamina = clamp(npc.stamina - options.extraStamina, 0, 100);
    }
    if (npc.health <= 0 && npc.alive) {
      npc.alive = false;
      state.dead = [...state.dead, npc.id];
      deaths.push(npc.id);
    }
  }
  state.simTime += minutes;
  state.day = Math.floor(state.simTime / MINUTES_PER_DAY) + 1;
  if (state.dead.length === Object.keys(state.npcs).length) state.ending = 'all-dead';
  else if (state.ending === 'none'
    && state.simTime >= state.scenarioDays * MINUTES_PER_DAY) state.ending = 'survived';
  return deaths;
}

/** Pure reducer. Same state + command always yields the same state + events. */
export function applyCommand(state: WorldV2, command: Command): { state: WorldV2; events: WorldEvent[] } {
  if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
    throw new SurvivalError('bad_command_id', 'commandId must be a non-empty string');
  }
  if (state.commandLog.includes(command.commandId)) {
    throw new SurvivalError('duplicate_command', `command ${command.commandId} already applied`);
  }
  const events: WorldEvent[] = [];
  let next: WorldV2 = { ...state, commandLog: [...state.commandLog, command.commandId] };
  // Deep-copy every mutable nested object: a returned snapshot must never be
  // mutated by a later command, and the input state must stay byte-identical.
  const npcs: Record<string, NpcState> = {};
  for (const [id, npc] of Object.entries(next.npcs)) npcs[id] = { ...npc };
  const resources = { ...next.resources };
  const furnace = { ...next.furnace };

  switch (command.type) {
    case 'advance': {
      if (!Number.isFinite(command.minutes) || command.minutes < 0) {
        throw new SurvivalError('bad_minutes', 'advance minutes must be non-negative');
      }
      // evolveSpan mutates state.npcs/furnace/resources in place: point them at
      // the command-local copies so the input snapshot stays byte-identical.
      next.npcs = npcs;
      next.furnace = furnace;
      next.resources = resources;
      const deaths = evolveSpan(next, command.minutes, { recovery: command.recovery });
      for (const deadId of deaths) {
        events.push(event(next, command, 'npc_died', { npcId: deadId }));
      }
      events.push(event(next, command, 'time_advanced', { minutes: command.minutes }));
      break;
    }
    case 'gather': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'gather amount must be positive');
      }
      const yieldFactor = 0.8 + hashUnit(next.rngSeed, next.version, `gather:${command.resource}`) * 0.4;
      // A gathering trip brings back roughly two units per requested unit.
      const gained = Math.round(command.amount * 2 * yieldFactor);
      if (command.resource === 'food') resources.food += gained;
      else resources.firewood += gained;
      npcs[npc.id] = { ...npc, stamina: clamp(npc.stamina - command.amount * 0.6, 0, 100),
        hunger: clamp(npc.hunger - command.amount * 0.2, 0, 100) };
      events.push(event(next, command, 'gathered', { resource: command.resource, amount: gained }));
      break;
    }
    case 'eat': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'eat amount must be a positive finite number');
      }
      if (resources.food < command.amount) throw new SurvivalError('insufficient_food', 'no food left');
      resources.food -= command.amount;
      // Satiety goes UP. This is the G05 inversion guard.
      npcs[npc.id] = { ...npc, hunger: clamp(npc.hunger + command.amount * 9, 0, 100),
        stamina: clamp(npc.stamina + command.amount * 0.5, 0, 100) };
      events.push(event(next, command, 'ate', { amount: command.amount }));
      break;
    }
    case 'rest': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.minutes) || command.minutes < 0) {
        throw new SurvivalError('bad_minutes', 'rest minutes must be a non-negative finite number');
      }
      const hours = command.minutes / MINUTES_PER_HOUR;
      npcs[npc.id] = { ...npc, stamina: clamp(npc.stamina + 12 * hours, 0, 100),
        health: clamp(npc.health + 1.5 * hours, 0, 100),
        san: clamp(npc.san + 3 * hours, 0, 100) };
      events.push(event(next, command, 'rested', { minutes: command.minutes }));
      break;
    }
    case 'work': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.minutes) || command.minutes < 0) {
        throw new SurvivalError('bad_minutes', 'work minutes must be a non-negative finite number');
      }
      const hours = command.minutes / MINUTES_PER_HOUR;
      if (npc.stamina < 5) throw new SurvivalError('too_tired', `${npc.id} has no stamina to work`);
      const produced = Math.max(1, Math.round(hours * 2));
      resources.power = clamp(resources.power + produced, 0, 1000);
      npcs[npc.id] = { ...npc, stamina: clamp(npc.stamina - 14 * hours, 0, 100),
        hunger: clamp(npc.hunger - 4 * hours, 0, 100) };
      events.push(event(next, command, 'worked', { minutes: command.minutes, power: produced }));
      break;
    }
    case 'refuel': {
      needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'refuel amount must be a positive finite number');
      }
      if (resources.firewood < command.amount) throw new SurvivalError('insufficient_firewood', 'no firewood');
      resources.firewood -= command.amount;
      furnace.fuel = clamp(furnace.fuel + command.amount * 2, 0, 100);
      furnace.lit = true;
      events.push(event(next, command, 'refuelled', { amount: command.amount }));
      break;
    }
    case 'medical': {
      needNpc(next, command.actorId);
      const target = needNpc(next, command.targetId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'medical amount must be a positive finite number');
      }
      if (resources.medicine < command.amount) throw new SurvivalError('insufficient_medicine', 'no medicine');
      resources.medicine -= command.amount;
      npcs[target.id] = { ...target, health: clamp(target.health + command.amount * 25, 0, 100) };
      events.push(event(next, command, 'treated', { targetId: target.id, amount: command.amount }));
      break;
    }
    case 'move': {
      const npc = needNpc(next, command.actorId);
      if (!LOCATIONS.includes(command.to)) {
        throw new SurvivalError('bad_location', `unknown location ${String(command.to)}`);
      }
      npcs[npc.id] = { ...npc, location: command.to, stamina: clamp(npc.stamina - 3, 0, 100) };
      events.push(event(next, command, 'moved', { to: command.to }));
      break;
    }
    case 'reserve': {
      needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'reserve amount must be a positive finite number');
      }
      if (resources.food < command.amount) throw new SurvivalError('insufficient_food', 'no food to reserve');
      resources.food -= command.amount;
      events.push(event(next, command, 'food_reserved', { forId: command.forId, amount: command.amount }));
      break;
    }
    case 'travel': {
      const npc = needNpc(next, command.actorId);
      if (!Array.isArray(command.route) || command.route.length === 0) {
        throw new SurvivalError('bad_route', 'travel route must be a non-empty cell array');
      }
      if (!Number.isFinite(command.minutesPerTile) || command.minutesPerTile <= 0) {
        throw new SurvivalError('bad_minutes', 'travel minutesPerTile must be a positive finite number');
      }
      const space = cloneSpatial(next);
      const closed = new Set(space.closedCells);
      const village = MAPS.village;
      const start = positionOf(space, npc);
      const firstCell = command.route[0];
      if (firstCell.x !== start.x || firstCell.y !== start.y) {
        throw new SurvivalError('bad_route',
          `route must start at ${npc.id}'s current cell ${start.x},${start.y}`);
      }
      for (let index = 0; index < command.route.length; index += 1) {
        const cell = command.route[index];
        if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)) {
          throw new SurvivalError('bad_route', 'route cells must be finite integers');
        }
        if (!isWalkable(village, cell, closed)) {
          throw new SurvivalError('road_blocked', `route cell ${cell.x},${cell.y} is not walkable`);
        }
        if (index > 0) {
          const previous = command.route[index - 1];
          if (Math.abs(cell.x - previous.x) + Math.abs(cell.y - previous.y) !== 1) {
            throw new SurvivalError('bad_route', 'route cells must be 4-adjacent steps');
          }
        }
      }
      const tiles = command.route.length - 1;
      const minutes = tiles * command.minutesPerTile;
      const end = command.route[command.route.length - 1];
      const building = BUILDINGS.find(entry => entry.door.x === end.x && entry.door.y === end.y);
      space.positions[npc.id] = { x: end.x, y: end.y };
      npcs[npc.id] = { ...npc, location: building ? building.id as LocationId : npc.location };
      next.npcs = npcs;
      next.furnace = furnace;
      next.resources = resources;
      next.spatial = space;
      // R4 (G3): a travel leg advances the SAME world clock as advance: furnace,
      // every NPC's needs/damage/death, calendar and ending all participate.
      // The traveller's extra stamina is explicit and charged exactly once.
      const deaths = evolveSpan(next, minutes, { travelerId: npc.id,
        extraStamina: tiles * TRAVEL_STAMINA_PER_TILE });
      for (const deadId of deaths) {
        events.push(event(next, command, 'npc_died', { npcId: deadId }));
      }
      events.push(event(next, command, 'traveled', { tiles, minutes,
        ...(building ? { arrivedAt: building.id } : {}) }));
      break;
    }
    case 'deposit': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'deposit amount must be a positive finite number');
      }
      if (npc.location !== command.place) {
        throw new SurvivalError('bad_location', `deposit requires standing at ${command.place}`);
      }
      const space = cloneSpatial(next);
      const publicFood = resources.food;
      if (publicFood < command.amount) {
        throw new SurvivalError('insufficient_food', 'no gathered food to deposit');
      }
      // One transfer, one source decrement and one target increment.
      resources.food -= command.amount;
      space.stocks.warehouse.food += command.amount;
      next.spatial = space;
      events.push(event(next, command, 'stock_deposited', { place: command.place,
        amount: command.amount, publicFood: publicFood - command.amount,
        total: space.stocks.warehouse.food }));
      break;
    }
    case 'withdraw': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'withdraw amount must be a positive finite number');
      }
      if (npc.location !== command.place) {
        throw new SurvivalError('bad_location', `withdraw requires standing at ${command.place}`);
      }
      const space = cloneSpatial(next);
      const available = space.stocks.warehouse.food;
      if (available < command.amount) {
        // Observable authoritative failure, not a crash: the promise stays.
        events.push(event(next, command, 'out_of_stock',
          { place: command.place, available, wanted: command.amount }));
        break;
      }
      space.stocks.warehouse.food = available - command.amount;
      const carried = space.carry[npc.id]?.meals ?? 0;
      space.carry[npc.id] = { meals: carried + command.amount };
      next.spatial = space;
      events.push(event(next, command, 'stock_withdrawn',
        { place: command.place, amount: command.amount, remaining: available - command.amount,
          carried: carried + command.amount }));
      break;
    }
    case 'restock': {
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'restock amount must be a positive finite number');
      }
      const space = cloneSpatial(next);
      const total = space.stocks.warehouse.food + command.amount;
      space.stocks.warehouse.food = total;
      next.spatial = space;
      events.push(event(next, command, 'stock_restocked',
        { place: command.place, amount: command.amount, source: command.source, total }));
      break;
    }
    case 'deliver': {
      const npc = needNpc(next, command.actorId);
      if (!Number.isFinite(command.amount) || command.amount <= 0) {
        throw new SurvivalError('bad_amount', 'deliver amount must be a positive finite number');
      }
      if (npc.location !== command.to) {
        throw new SurvivalError('bad_location', `deliver requires standing at ${command.to}`);
      }
      const space = cloneSpatial(next);
      const carried = space.carry[npc.id]?.meals ?? 0;
      if (carried < command.amount) {
        events.push(event(next, command, 'delivery_shortfall', { wanted: command.amount, carried }));
        break;
      }
      space.carry[npc.id] = { meals: carried - command.amount };
      space.deliveredMeals += command.amount;
      next.spatial = space;
      events.push(event(next, command, 'meal_delivered',
        { to: command.to, amount: command.amount, totalDelivered: space.deliveredMeals }));
      break;
    }
    case 'close-road': {
      if (!Array.isArray(command.cells) || command.cells.length === 0) {
        throw new SurvivalError('bad_cells', 'close-road needs at least one cell');
      }
      const village = MAPS.village;
      const space = cloneSpatial(next);
      let added = 0;
      for (const cell of command.cells) {
        if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y)
          || cell.x < 0 || cell.y < 0 || cell.x >= village.w || cell.y >= village.h) {
          throw new SurvivalError('bad_cells',
            `cell ${String(cell.x)},${String(cell.y)} is outside the village grid`);
        }
        const key = cellKey(cell);
        if (!space.closedCells.includes(key)) {
          space.closedCells = [...space.closedCells, key];
          added += 1;
        }
      }
      next.spatial = space;
      events.push(event(next, command, 'road_closed',
        { cells: command.cells.length, added, detail: command.cells.map(cellKey).join(';') }));
      break;
    }
    case 'open-road': {
      if (!Array.isArray(command.cells) || command.cells.length === 0) {
        throw new SurvivalError('bad_cells', 'open-road needs at least one cell');
      }
      const space = cloneSpatial(next);
      let removed = 0;
      for (const cell of command.cells) {
        const key = cellKey(cell);
        if (space.closedCells.includes(key)) {
          space.closedCells = space.closedCells.filter(entry => entry !== key);
          removed += 1;
        }
      }
      next.spatial = space;
      events.push(event(next, command, 'road_reopened',
        { cells: command.cells.length, removed, detail: command.cells.map(cellKey).join(';') }));
      break;
    }
    default:
      throw new SurvivalError('unknown_command', `unknown command ${(command as { type: string }).type}`);
  }

  next = bump({ ...next, npcs, resources, furnace }, events[0] ?? event(next, command, 'noop'));
  if (!next.ending || next.ending === 'none') {
    if (next.dead.length === Object.keys(next.npcs).length && next.dead.length > 0) next.ending = 'all-dead';
    else if (next.simTime >= next.scenarioDays * MINUTES_PER_DAY) next.ending = 'survived';
  }
  // Immutable receipt: written once, never overwritten by later submissions.
  next = { ...next, receipts: { ...(next.receipts ?? {}),
    [command.commandId]: { digest: commandDigest(command),
      eventIds: events.map(entry => entry.eventId), postStateVersion: next.version } } };
  return { state: next, events };
}

/** Stable content digest used to distinguish a retry from an ID conflict. */
export function commandDigest(command: Command): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

export const LOCATIONS: readonly LocationId[] = ['dorm-a', 'dorm-b', 'kitchen', 'warehouse',
  'workshop', 'medical', 'command', 'village'];

export interface CommandResult {
  commandId: string;
  status: 'applied' | 'rejected' | 'duplicate' | 'unknown';
  reason: string | null;
  events: WorldEvent[];
  eventIds: string[];
  postStateVersion: number;
  state: WorldV2;
  /** Present only on `duplicate`: the first authoritative receipt, replayed. */
  firstReceipt?: { digest: string; eventIds: string[]; postStateVersion: number };
}

/**
 * Submission port for G/C. Illegal input is rejected without touching state;
 * a repeated commandId is reported as duplicate and never applies twice.
 */
export function submitCommand(state: WorldV2, command: Command): CommandResult {
  if (typeof command.commandId !== 'string' || command.commandId.length === 0) {
    return { commandId: String(command.commandId), status: 'rejected',
      reason: 'bad_command_id', events: [], eventIds: [], postStateVersion: state.version, state };
  }
  if (state.commandLog.includes(command.commandId)) {
    const first = state.receipts?.[command.commandId];
    if (first && first.digest !== commandDigest(command)) {
      return { commandId: command.commandId, status: 'rejected',
        reason: 'command_id_conflict', events: [], eventIds: [],
        postStateVersion: state.version, state };
    }
    return { commandId: command.commandId, status: 'duplicate', reason: 'command_id already applied',
      events: [], eventIds: first?.eventIds ?? [], postStateVersion: first?.postStateVersion ?? state.version,
      state, ...(first ? { firstReceipt: first } : {}) };
  }
  try {
    const { state: next, events } = applyCommand(state, command);
    return { commandId: command.commandId, status: 'applied', reason: null, events,
      eventIds: events.map(entry => entry.eventId), postStateVersion: next.version, state: next };
  } catch (error) {
    if (error instanceof SurvivalError) {
      return { commandId: command.commandId, status: 'rejected', reason: error.code,
        events: [], eventIds: [], postStateVersion: state.version, state };
    }
    throw error;
  }
}

export interface SnapshotV1 {
  schema: 'frostecho.world-v2/0';
  simTime: number;
  weather: Weather;
  npcs: Record<string, { id: string; location: LocationId; hunger: number; health: number; alive: boolean }>;
  resources: WorldV2['resources'];
  furnace: WorldV2['furnace'];
}

/** Explicit, versioned migration; defaults are documented, not guessed silently. */
export function migrateSnapshot(raw: unknown): WorldV2 {
  const rawSchema = (raw as { schema?: string } | null)?.schema;
  if (rawSchema === WORLD_V2_SCHEMA) {
    const state = raw as WorldV2;
    if (state.rulesVersion !== RULES_VERSION) {
      throw new SurvivalError('rules_version', `snapshot rules ${state.rulesVersion} != ${RULES_VERSION}`);
    }
    return state;
  }
  if (rawSchema !== 'frostecho.world-v2/0') {
    throw new SurvivalError('unknown_snapshot', `cannot migrate schema ${String(rawSchema)}`);
  }
  const value = raw as Partial<SnapshotV1>;
  const npcs: Record<string, NpcState> = {};
  for (const [id, npc] of Object.entries(value.npcs ?? {})) {
    npcs[id] = { id: npc.id, location: npc.location, hunger: npc.hunger, health: npc.health,
      alive: npc.alive,
      // v1 had no stamina/SAN: documented defaults, 80/80, not back-filled data.
      stamina: 80, san: 80 };
  }
  return {
    schema: WORLD_V2_SCHEMA,
    rulesVersion: RULES_VERSION,
    day: Math.floor((value.simTime ?? 0) / MINUTES_PER_DAY) + 1,
    simTime: value.simTime ?? 0,
    version: 0,
    rngSeed: 'migrated',
    weather: value.weather ?? 'snow',
    npcs,
    resources: value.resources ?? { food: 0, firewood: 0, power: 0, medicine: 0 },
    furnace: value.furnace ?? { lit: false, fuel: 0, warmth: 0 },
    commandLog: [],
    dead: Object.values(npcs).filter(npc => !npc.alive).map(npc => npc.id),
    ending: 'none',
    scenarioDays: 4,
  };
}

export interface ReadOnlyView {
  day: number;
  simTime: number;
  version: number;
  weather: Weather;
  npcs: NpcState[];
  resources: WorldV2['resources'];
  furnace: WorldV2['furnace'];
}

/** What G may read. It cannot mutate the authoritative state through this view. */
export function viewOf(state: WorldV2): ReadOnlyView {
  return Object.freeze({
    day: state.day,
    simTime: state.simTime,
    version: state.version,
    weather: state.weather,
    npcs: Object.freeze(Object.values(state.npcs).map(npc => Object.freeze({ ...npc }))) as NpcState[],
    resources: Object.freeze({ ...state.resources }),
    furnace: Object.freeze({ ...state.furnace }),
  });
}

/** Four-day scripted 8-NPC loop used by the offline fixture. */
export function runEightNpcDay(state: WorldV2, day: number): { state: WorldV2; events: WorldEvent[] } {
  const ids = Object.keys(state.npcs);
  let current = state;
  const events: WorldEvent[] = [];
  const step = (command: Command) => {
    const result = applyCommand(current, command);
    current = result.state;
    events.push(...result.events);
  };
  step({ commandId: `d${day}-wake`, type: 'advance', minutes: 8 * 60 });
  ids.forEach((id, index) => {
    if (!current.npcs[id].alive) return;
    if (current.npcs[id].hunger < 55 && current.resources.food >= 3) {
      step({ commandId: `d${day}-eat-${id}`, type: 'eat', actorId: id, amount: 3 });
    }
    if (current.npcs[id].hunger < 25 && current.resources.food >= 1) {
      step({ commandId: `d${day}-eat2-${id}`, type: 'eat', actorId: id, amount: 1 });
    }
    const role = index % 4;
    if (role === 0 || role === 1) {
      step({ commandId: `d${day}-gather-${id}`, type: 'gather', actorId: id, resource: 'food', amount: 3 });
    } else if (role === 2) {
      step({ commandId: `d${day}-wood-${id}`, type: 'gather', actorId: id, resource: 'firewood', amount: 3 });
    } else {
      step({ commandId: `d${day}-work-${id}`, type: 'work', actorId: id, minutes: 60 });
    }
  });
  const refueller = ids.find(id => current.npcs[id].alive);
  // 24h needs 9.6 fuel at 0.4/h; five wood gives ten fuel.
  if (refueller && current.resources.firewood >= 5) {
    step({ commandId: `d${day}-refuel`, type: 'refuel', actorId: refueller, amount: 5 });
  }
  // Exactly 24h per day: 8h morning + 16h overnight.
  step({ commandId: `d${day}-night`, type: 'advance', minutes: 16 * 60, recovery: true });
  return { state: current, events };
}
