/**
 * The single commit point for R8 domain intents.
 *
 * Domains never mutate the world. They return typed intents with
 * preconditions; this module validates every precondition against the
 * authoritative snapshot, applies the accepted intents in one version bump and
 * records the observable rejections. There is no other writer.
 */
import { clamp, type MachineId, type MachineState, type NpcState,
  type R8WorldState, type WorldEvent, type WorldV2 } from '../../survival/world-v2';
import {
  absoluteMinute, dayOf, elapsedMinutes, minuteOfDayOf,
  type DomainActorView, type DomainSnapshot, type LocationId,
  type Precondition, type Rejection, type ResourceId, type TimeProfile,
  type WorldIntent,
} from '../contracts';

export const DEFAULT_BODY_TEMP = 36.5;

export function ensureR8(world: WorldV2): R8WorldState {
  if (!world.r8) {
    world.r8 = {
      machines: { generator: 'absent', lumberMill: 'absent', foodCollector: 'absent' },
      machineProgress: {},
      facts: {},
    };
  }
  return world.r8;
}

/** Read-only authoritative view; deep-frozen so a domain cannot mutate it. */
export function snapshotOf(world: WorldV2, profile: TimeProfile,
  weatherOverride?: string): DomainSnapshot {
  const r8 = ensureR8(world);
  const abs = world.simTime;
  const npcs: Record<string, DomainActorView> = {};
  for (const [id, npc] of Object.entries(world.npcs)) {
    npcs[id] = {
      id,
      location: npc.location as LocationId,
      alive: npc.alive,
      hunger: npc.hunger,
      stamina: npc.stamina,
      health: npc.health,
      san: npc.san,
      bodyTemp: npc.bodyTemp ?? DEFAULT_BODY_TEMP,
      promises: [],
    };
  }
  const snapshot: DomainSnapshot = {
    worldVersion: world.version,
    profile,
    absoluteMinute: abs,
    day: dayOf(profile, abs),
    minuteOfDay: minuteOfDayOf(profile, abs),
    elapsed: elapsedMinutes(profile, dayOf(profile, abs), minuteOfDayOf(profile, abs)),
    resources: { ...world.resources },
    furnace: { ...world.furnace },
    machines: { ...r8.machines },
    weather: weatherOverride ?? world.weather,
    npcs,
    facts: { ...r8.facts },
  };
  return Object.freeze(snapshot);
}

export interface CommitOutcome {
  applied: string[];
  rejected: Rejection[];
  events: WorldEvent[];
}

export interface CommitOptions {
  profile: TimeProfile;
  /** Event types the watchers can see; default everyone. */
  observedBy?: (intent: WorldIntent) => 'all' | string[];
}

function reject(intent: WorldIntent, code: string, reason: string): Rejection {
  return { intentId: intent.id, code, reason };
}

function resourcePrecondition(world: WorldV2, pre: Extract<Precondition,
  { kind: 'resource_at_least' }>): string | null {
  const held = world.resources[pre.resource];
  if (typeof held !== 'number') return `unknown resource ${pre.resource}`;
  return held >= pre.amount ? null : `${pre.resource} ${held} < ${pre.amount}`;
}

function actorPrecondition(world: WorldV2, actorId: string): NpcState | string {
  const npc = world.npcs[actorId];
  if (!npc) return `unknown actor ${actorId}`;
  if (!npc.alive) return `actor ${actorId} is not alive`;
  return npc;
}

export function checkPrecondition(world: WorldV2, pre: Precondition,
  profile: TimeProfile): string | null {
  switch (pre.kind) {
    case 'resource_at_least': return resourcePrecondition(world, pre);
    case 'actor_alive': {
      const npc = actorPrecondition(world, pre.actorId);
      return typeof npc === 'string' ? npc : null;
    }
    case 'actor_at': {
      const npc = world.npcs[pre.actorId];
      if (!npc) return `unknown actor ${pre.actorId}`;
      return npc.location === pre.location ? null : `actor at ${npc.location}`;
    }
    case 'machine_state': {
      const state = ensureR8(world).machines[pre.machine];
      return pre.states.includes(state) ? null : `machine ${pre.machine} is ${state}`;
    }
    case 'time_before': {
      const abs = absoluteMinute(profile, dayOf(profile, pre.absoluteMinute),
        minuteOfDayOf(profile, pre.absoluteMinute));
      return world.simTime < abs ? null : 'too late';
    }
    default: return 'unknown precondition';
  }
}

function applyIntent(world: WorldV2, intent: WorldIntent): string | null {
  switch (intent.kind) {
    case 'resource': {
      const next = world.resources[intent.resource] + intent.delta;
      if (!Number.isFinite(next) || next < 0) {
        return `resource ${intent.resource} would go negative (${next})`;
      }
      world.resources[intent.resource] = Number(next.toFixed(6));
      return null;
    }
    case 'actor': {
      const npc = world.npcs[intent.actorId];
      if (!npc) return `unknown actor ${intent.actorId}`;
      for (const [field, delta] of Object.entries(intent.delta)) {
        if (typeof delta !== 'number' || !Number.isFinite(delta)) return `bad delta ${field}`;
        if (field === 'bodyTemp') {
          npc.bodyTemp = clamp((npc.bodyTemp ?? DEFAULT_BODY_TEMP) + delta, 25, 37);
          continue;
        }
        const key = field as 'hunger' | 'stamina' | 'health' | 'san';
        if (typeof npc[key] !== 'number') return `unknown vital ${field}`;
        npc[key] = clamp(npc[key] + delta, 0, 100);
        if (npc.health <= 0 && npc.alive) {
          npc.alive = false;
          npc.health = 0;
          if (!world.dead.includes(npc.id)) world.dead.push(npc.id);
        }
      }
      return null;
    }
    case 'spatial': {
      const npc = world.npcs[intent.actorId];
      if (!npc) return `unknown actor ${intent.actorId}`;
      npc.location = intent.to as NpcState['location'];
      return null;
    }
    case 'machine': {
      const r8 = ensureR8(world);
      r8.machines[intent.machine] = intent.to;
      if (intent.to === 'absent') delete r8.machineProgress[intent.machine];
      return null;
    }
    case 'intent-note': {
      ensureR8(world).facts[intent.key] = intent.value;
      return null;
    }
    default: return 'unknown intent kind';
  }
}

function machineSlot(intent: WorldIntent): MachineId | null {
  return intent.kind === 'machine' ? intent.machine : null;
}

/**
 * Validate then apply. Accepted intents land in a single version bump; a
 * rejected intent changes nothing and is reported with its reason.
 */
export function commitIntents(world: WorldV2, intents: readonly WorldIntent[],
  options: CommitOptions): { world: WorldV2; outcome: CommitOutcome } {
  const accepted: WorldIntent[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  for (const intent of intents) {
    if (seen.has(intent.id)) {
      rejected.push(reject(intent, 'duplicate_intent', `intent id ${intent.id} repeated`));
      continue;
    }
    seen.add(intent.id);
    if (!Number.isFinite(intent.preconditions.length)) {
      rejected.push(reject(intent, 'bad_intent', 'preconditions must be an array'));
      continue;
    }
    let failure: string | null = null;
    for (const pre of intent.preconditions) {
      failure = checkPrecondition(world, pre, options.profile);
      if (failure) break;
    }
    if (failure) {
      rejected.push(reject(intent, 'precondition_failed', failure));
      continue;
    }
    accepted.push(intent);
  }
  if (accepted.length === 0) return { world, outcome: { applied: [], rejected, events: [] } };

  // Work on a copy so a mid-batch failure cannot leave a half-applied world.
  const next: WorldV2 = {
    ...world,
    npcs: Object.fromEntries(Object.entries(world.npcs).map(([id, npc]) => [id, { ...npc }])),
    resources: { ...world.resources },
    furnace: { ...world.furnace },
    r8: world.r8 ? {
      machines: { ...world.r8.machines },
      machineProgress: { ...world.r8.machineProgress },
      facts: { ...world.r8.facts },
    } : undefined,
  };
  const events: WorldEvent[] = [];
  const applied: string[] = [];
  const version = next.version + 1;
  for (const intent of accepted) {
    const failure = applyIntent(next, intent);
    if (failure) {
      rejected.push(reject(intent, 'apply_failed', failure));
      continue;
    }
    applied.push(intent.id);
    const slot = machineSlot(intent);
    events.push({
      eventId: `v${version}:${intent.kind}:${slot ?? intent.id}`,
      type: `r8_${intent.kind}`,
      simTime: next.simTime,
      actorId: intent.actorId,
      payload: {
        intentId: intent.id,
        source: intent.source,
        ...(intent.kind === 'resource'
          ? { resource: intent.resource, delta: intent.delta } : {}),
        ...(intent.kind === 'actor' ? { delta: JSON.stringify(intent.delta) } : {}),
        ...(intent.kind === 'spatial' ? { to: intent.to } : {}),
        ...(intent.kind === 'machine' ? { machine: intent.machine, state: intent.to } : {}),
        ...(intent.kind === 'intent-note' ? { key: intent.key, value: intent.value } : {}),
      },
    });
  }
  next.version = version;
  // Dying is not a resource: recompute the lived list from the applied state.
  next.dead = Object.values(next.npcs)
    .filter(npc => !npc.alive).map(npc => npc.id).sort();
  return { world: next, outcome: { applied, rejected, events } };
}

/** Deterministic intent id: same source and subject produce the same id. */
export function intentId(source: string, actorId: string, tag: string, seq = 0): string {
  return `${source}:${actorId}:${tag}:${seq}`;
}

export function machineOf(state: R8WorldState, id: MachineId): MachineState {
  return state.machines[id];
}

export type { ResourceId };
