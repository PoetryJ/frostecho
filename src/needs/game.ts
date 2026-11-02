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
  /** Kitchen food at t=0 (both NPCs start in the kitchen, npc_b in the dorm). */
  kitchenFood?: number;
  /** Starting hunger per actor; defaults mirror G04 (npc_a 40, npc_c 20). */
  hunger?: Partial<Record<string, number>>;
}

export function buildNeedsWorld(options: NeedsGameWorldOptions = {}): WorldState {
  const actorIds = options.actorIds ?? REACTIVE_ACTOR_IDS;
  const npcs: WorldState['npcs'] = {
    npc_b: { id: 'npc_b', location: 'dorm', hunger: 0 },
  };
  for (const actorId of actorIds) {
    npcs[actorId] = {
      id: actorId,
      location: 'kitchen',
      hunger: options.hunger?.[actorId] ?? (actorId === 'npc_a' ? 40 : 20),
    };
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
    schemaVersion: 'frostecho.g05.game/1',
    timeoutMs: options.timeoutMs,
    now: options.now,
    scheduleTimeout: options.scheduleTimeout,
    onDeciding: options.onDeciding,
  });
  return game;
}
