/** EXPERIMENTAL constants — not a reproduction of old-game balance. */
export const RULES = Object.freeze({
  LOCATIONS: Object.freeze(['dorm', 'kitchen'] as const),
  EAT_FOOD_COST: 1,        // food units consumed per eat
  EAT_HUNGER_RESTORE: 30,  // hunger(=satiety) points restored per eat
  HUNGER_MIN: 0,
  HUNGER_MAX: 100,
  /** G05-R1: satiety lost per simulation step, for every NPC incl. the player (floor 0). */
  DECAY_PER_STEP: 10,
  /** G05-R1: single advance_time command may span at most this many steps. */
  TIME_ADVANCE_MAX_STEPS: 10,
});
export type Location = (typeof RULES.LOCATIONS)[number];

export interface NpcState { id: string; location: Location; hunger: number }
/** WorldState: the single authoritative state. */
export interface WorldState {
  tick: number; // logical sequence counter (no wall clock)
  npcs: Record<string, NpcState>;
  food: Record<Location, number>;
  /**
   * G05: simulated steps since episode start. Optional so pre-G05 records (and
   * worlds that never advance time) stay canonically identical: old states read
   * a missing field as 0 without materializing it; G05 initializers set it
   * explicitly to 0 and TimeAdvanced events carry it from there.
   */
  simTime?: number;
}

/** Command: what an actor WANTS to do. Not a fact. */
export type Command =
  | { commandId: string; actorId: string; type: 'move'; payload: { to: string } }
  | { commandId: string; actorId: string; type: 'eat'; payload: Record<string, never> }
  /** G04: experimental environment input. Only the `world` actor may submit it. */
  | { commandId: string; actorId: string; type: 'restock'; payload: { location: Location; amount: number } }
  /** G05: advance simulated time by whole steps. Only the `world` actor may submit it. */
  | { commandId: string; actorId: string; type: 'advance_time'; payload: { steps: number } }
  | { commandId: string; actorId: string; type: string; payload: unknown };

export type RejectReason =
  | 'INVALID_COMMAND' | 'UNKNOWN_ACTOR' | 'UNKNOWN_ACTION' | 'INVALID_PAYLOAD'
  | 'ALREADY_THERE' | 'NOT_IN_KITCHEN' | 'NO_FOOD' | 'COMMAND_ID_CONFLICT'
  /** G04: an actor tried an action it may never perform (NPC restock / world move-eat-stop). */
  | 'FORBIDDEN_ACTION';

/** CommandResult: accepted or rejected, with reason & linked events. */
export interface CommandResult {
  commandId: string;
  seq: number;              // processing order (1-based)
  status: 'accepted' | 'rejected' | 'duplicate';
  reason?: RejectReason;
  detail?: string;
  eventIds: string[];       // events produced (for duplicate: those of the original)
  originalSeq?: number;
}

/** WorldEvent: a state change that HAS happened. Replay applies only these. */
export type WorldEvent =
  | { eventId: string; seq: number; commandId: string; type: 'NpcMoved'; npcId: string; from: Location; to: Location }
  | { eventId: string; seq: number; commandId: string; type: 'FoodConsumed'; location: Location; amount: number; before: number; after: number }
  | { eventId: string; seq: number; commandId: string; type: 'HungerChanged'; npcId: string; before: number; after: number }
  /** G04: world restocked a location. */
  | { eventId: string; seq: number; commandId: string; type: 'FoodRestocked'; location: Location; amount: number; before: number; after: number }
  /** G05: simulated time advanced by an advance_time command; decay may follow. */
  | { eventId: string; seq: number; commandId: string; type: 'TimeAdvanced'; before: number; after: number; steps: number };
