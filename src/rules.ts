import { Command, Location, NpcState, RejectReason, RULES, WorldEvent, WorldState } from './types';

/** G04: internal routing marker for experimental environment input. */
export const WORLD_ACTOR_ID = 'world';
const RESTOCK_MIN = 1;
const RESTOCK_MAX = 10;

/**
 * restock is world-only (a network-driven NPC can never grow food), targets an
 * existing location, takes an integer amount in [1,10] and nothing else, and
 * must keep the new total a safe integer.
 */
function decideRestock(state: Readonly<WorldState>, cmd: Command): Decision {
  if (cmd.actorId !== WORLD_ACTOR_ID) {
    return { ok: false, reason: 'FORBIDDEN_ACTION', detail: `only ${WORLD_ACTOR_ID} may restock, not ${cmd.actorId}` };
  }
  const p = cmd.payload as any;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'restock payload must be {location, amount}' };
  }
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'amount,location') return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'restock accepts only {location, amount}' };
  if (!isLoc(p.location)) return { ok: false, reason: 'INVALID_PAYLOAD', detail: `restock.location must be one of ${RULES.LOCATIONS.join('|')}` };
  if (!Number.isSafeInteger(p.amount) || p.amount < RESTOCK_MIN || p.amount > RESTOCK_MAX) {
    return { ok: false, reason: 'INVALID_PAYLOAD', detail: `restock.amount must be an integer in [${RESTOCK_MIN},${RESTOCK_MAX}]` };
  }
  const location = p.location as Location;
  const before = state.food[location];
  const after = before + p.amount;
  if (!Number.isSafeInteger(after)) return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'restock would overflow the food counter' };
  return { ok: true, events: [{ type: 'FoodRestocked', location, amount: p.amount as number, before, after } as any] };
}

export type Decision =
  | { ok: true; events: Omit<WorldEvent, 'eventId' | 'seq' | 'commandId'>[] }
  | { ok: false; reason: RejectReason; detail: string };

const isLoc = (x: unknown): x is Location => typeof x === 'string' && (RULES.LOCATIONS as readonly string[]).includes(x);
const clamp = (n: number) => Math.min(RULES.HUNGER_MAX, Math.max(RULES.HUNGER_MIN, n));

/**
 * Own-property lookup only. Bracket access walks Object.prototype, so actorIds
 * such as "toString" and "constructor" are truthy functions; decide would then
 * emit NpcMoved with a missing id and applyEvent would throw TypeError.
 */
function actorOf(state: Readonly<WorldState>, actorId: string): NpcState | undefined {
  if (!Object.hasOwn(state.npcs, actorId)) return undefined;
  const npc = state.npcs[actorId];
  if (!npc || typeof npc !== 'object') return undefined;
  return npc;
}

/** Pure: validate a command against state and decide events. Never mutates state. */
export function decide(state: Readonly<WorldState>, cmd: Command): Decision {
  if (cmd.type === 'restock') return decideRestock(state, cmd);
  if (cmd.actorId === WORLD_ACTOR_ID) {
    // The world is not an NPC: it may restock, nothing else.
    return { ok: false, reason: 'FORBIDDEN_ACTION', detail: `world may only restock, not ${String(cmd.type)}` };
  }
  const npc = actorOf(state, cmd.actorId);
  if (!npc) return { ok: false, reason: 'UNKNOWN_ACTOR', detail: `actor ${cmd.actorId} not found` };
  switch (cmd.type) {
    case 'move': {
      const p = cmd.payload as any;
      if (!p || typeof p !== 'object' || !isLoc(p.to)) return { ok: false, reason: 'INVALID_PAYLOAD', detail: `move.to must be one of ${RULES.LOCATIONS.join('|')}` };
      if (Object.keys(p).length !== 1) return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'move accepts only {to}' };
      if (npc.location === p.to) return { ok: false, reason: 'ALREADY_THERE', detail: `already at ${p.to}` };
      return { ok: true, events: [{ type: 'NpcMoved', npcId: npc.id, from: npc.location, to: p.to } as any] };
    }
    case 'eat': {
      const p = cmd.payload as any;
      if (p !== undefined && (p === null || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length > 0))
        return { ok: false, reason: 'INVALID_PAYLOAD', detail: 'eat takes empty payload {}' };
      if (npc.location !== 'kitchen') return { ok: false, reason: 'NOT_IN_KITCHEN', detail: `at ${npc.location}` };
      const food = state.food.kitchen;
      if (food < RULES.EAT_FOOD_COST) return { ok: false, reason: 'NO_FOOD', detail: `kitchen food=${food}` };
      return { ok: true, events: [
        { type: 'FoodConsumed', location: 'kitchen', amount: RULES.EAT_FOOD_COST, before: food, after: food - RULES.EAT_FOOD_COST } as any,
        { type: 'HungerChanged', npcId: npc.id, before: npc.hunger, after: clamp(npc.hunger + RULES.EAT_HUNGER_RESTORE) } as any,
      ] };
    }
    default:
      return { ok: false, reason: 'UNKNOWN_ACTION', detail: `unknown type ${String(cmd.type)}` };
  }
}

/** Pure reducer used by BOTH live execution and replay. Returns new state. */
export function applyEvent(state: WorldState, e: WorldEvent): WorldState {
  const s: WorldState = structuredClone(state);
  switch (e.type) {
    case 'NpcMoved': s.npcs[e.npcId].location = e.to; break;
    case 'FoodConsumed': s.food[e.location] = e.after; break;
    case 'HungerChanged': s.npcs[e.npcId].hunger = e.after; break;
    case 'FoodRestocked': s.food[e.location] = e.after; break;
  }
  s.tick = e.seq;
  return s;
}

export function checkInvariants(s: WorldState): string[] {
  const errs: string[] = [];
  for (const [l, n] of Object.entries(s.food)) if (!(n >= 0) || !Number.isInteger(n)) errs.push(`food ${l}=${n}`);
  for (const n of Object.values(s.npcs)) {
    if (!(n.hunger >= RULES.HUNGER_MIN && n.hunger <= RULES.HUNGER_MAX)) errs.push(`hunger ${n.id}=${n.hunger}`);
    if (!isLoc(n.location)) errs.push(`location ${n.id}=${n.location}`);
  }
  return errs;
}
