import { RULES, WorldState } from '../types';
import { Observation } from './contracts';

/**
 * Pure view of one actor. Reads that actor's id, location, and hunger, food at
 * the current location, and the legal place list. Does not read other places'
 * food, other NPCs, or any log.
 */
export function observe(state: Readonly<WorldState>, actorId: string): Observation {
  if (!Object.hasOwn(state.npcs, actorId)) throw new Error(`unknown actor ${actorId}`);
  const npc = state.npcs[actorId];
  if (!npc || typeof npc !== 'object') throw new Error(`unknown actor ${actorId}`);
  return {
    id: npc.id,
    location: npc.location,
    hunger: npc.hunger,
    foodHere: state.food[npc.location],
    reachable: [...RULES.LOCATIONS],
  };
}
