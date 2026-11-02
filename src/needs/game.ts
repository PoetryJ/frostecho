/**
 * G05 workstream B — the needs-loop game wrapper.
 *
 * Thin factory over createReactiveGame with G05 defaults: the g05 record
 * schema, the event wake policy, and a world builder that starts at simTime 0
 * with a controllable kitchen. The world entrypoints (restock / advance_time)
 * stay on the underlying game so ledgers stay single-sourced.
 */
import { createReactiveGame } from '../reactive/game';
import {
  type GameMode, type NeedPolicy, type ReactiveGame, type ReactiveGameOptions, REACTIVE_ACTOR_IDS,
} from '../reactive/contracts';
import type { WorldState } from '../types';

export interface NeedsGameWorldOptions {
  /** Autonomous rotation order; a permutation of npc_a/npc_c. */
  actorIds?: readonly string[];
  /** Kitchen food at t=0 (T1=4, T2=2, T3=0). Dorm food is always 0. */
  kitchenFood?: number;
  /** Starting satiety override per NPC; the frozen matrix starts everyone at 70. */
  hunger?: Partial<Record<string, number>>;
}

export function buildNeedsWorld(options: NeedsGameWorldOptions = {}): WorldState {
  // G05-R1 frozen matrix initial state: A/C/B all in the kitchen at satiety 70,
  // simTime 0, dorm food 0. npc_b is the passive player: it decays with time
  // but is never scheduled as an actor.
  const npcs: WorldState['npcs'] = {};
  for (const id of ['npc_a', 'npc_b', 'npc_c']) {
    npcs[id] = { id, location: 'kitchen', hunger: options.hunger?.[id] ?? 70 };
  }
  return {
    tick: 0,
    simTime: 0,
    npcs,
    food: { kitchen: options.kitchenFood ?? 0, dorm: 0 },
  };
}

export interface NeedsGameOptions {
  episodeId: string;
  initialState?: WorldState;
  actorIds?: readonly string[];
  providerFor: ReactiveGameOptions['providerFor'];
  mode: GameMode;
  thinking?: boolean;
  needPolicy: NeedPolicy;
  timeoutMs?: number;
  /** Live model name recorded even when a trajectory makes zero requests. */
  requestModel?: string;
  now?: () => number;
  scheduleTimeout?: ReactiveGameOptions['scheduleTimeout'];
  onDeciding?: ReactiveGameOptions['onDeciding'];
}

export type NeedsGame = ReactiveGame & ReturnType<typeof createReactiveGame>;

export function createNeedsGame(options: NeedsGameOptions): NeedsGame {
  const actorIds = options.actorIds ?? REACTIVE_ACTOR_IDS;
  const game = createReactiveGame({
    episodeId: options.episodeId,
    initialState: options.initialState ?? buildNeedsWorld({ actorIds }),
    actorIds,
    providerFor: options.providerFor,
    mode: options.mode,
    thinking: options.thinking ?? true,
    wakePolicy: 'event',
    needPolicy: options.needPolicy,
    schemaVersion: 'frostecho.g05.game/2',
    timeoutMs: options.timeoutMs,
    requestModel: options.requestModel,
    now: options.now,
    scheduleTimeout: options.scheduleTimeout,
    onDeciding: options.onDeciding,
  });
  return game;
}
