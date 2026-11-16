/**
 * P3 crisis domain: food conflict, frostbite (day 2), rescue, extinction and
 * the day-4 special broadcast.
 *
 * Source: `src/systems/event-system.js:82-108` dispatch, `:113` food conflict
 * (food<8, 3600 s cooldown), `:341` frostbite (day 2 only), `:370-401` rescue of
 * severe hypothermic NPCs, `:451-457` extinction at <=2 survivors, `:405-441`
 * day-4 warnings.
 *
 * `_checkFurnaceScramble` (`:158-195`) is NOT ported: it tests
 * `furnaces.length >= 2`, which the original removed and now always returns
 * false (`furnace-system.js:9-14,209-217`). Porting it would invent the second
 * furnace back into the game.
 */
import type { DomainCommand, DomainModule, DomainResult } from '../../contracts';
import { emptyResult } from '../../contracts';

export type CrisisKind = 'food_conflict' | 'frostbite' | 'rescue' | 'extinction'
  | 'day4_warning';

export interface CrisisRecord {
  crisisId: string;
  kind: CrisisKind;
  startedAtMinute: number;
  resolvedAtMinute: number | null;
  subjectIds: string[];
  detail: string;
}

export interface CrisesState {
  active: CrisisRecord[];
  history: CrisisRecord[];
  seq: number;
  lastFoodConflictMinute: number;
  /** `event-system.js:113` 3600 game-second cooldown == 60 game minutes. */
  foodConflictCooldownMinutes: number;
}

export const FOOD_CONFLICT_THRESHOLD = 8;
export const FOOD_CONFLICT_COOLDOWN = 60;
export const EXTINCTION_THRESHOLD = 2;

export const crisesDomain: DomainModule<CrisesState> = {
  id: 'crises',
  initial(): CrisesState {
    return { active: [], history: [], seq: 0, lastFoodConflictMinute: -Infinity,
      foodConflictCooldownMinutes: FOOD_CONFLICT_COOLDOWN };
  },

  reduce(state, command: DomainCommand, context): DomainResult<CrisesState> {
    const next: CrisesState = {
      active: state.active.map(crisis => ({ ...crisis })),
      history: state.history.map(crisis => ({ ...crisis })),
      seq: state.seq,
      lastFoodConflictMinute: state.lastFoodConflictMinute,
      foodConflictCooldownMinutes: state.foodConflictCooldownMinutes,
    };
    const result = emptyResult(next);
    if (command.type !== 'rescue') {
      result.rejections.push({ intentId: `crises:${command.type}`, code: 'unknown_command',
        reason: `crises does not handle ${command.type}` });
      return result;
    }
    const victimId = String(command.payload?.victimId ?? '');
    const victim = context.snapshot.npcs[victimId];
    if (!victim?.alive) {
      result.rejections.push({ intentId: `crises:rescue`, code: 'no_victim',
        reason: `victim ${victimId} is not alive` });
      return result;
    }
    const crisis = next.active.find(entry => entry.kind === 'rescue'
      && entry.subjectIds.includes(victimId));
    if (!crisis) {
      result.rejections.push({ intentId: `crises:rescue`, code: 'not_in_danger',
        reason: `${victimId} is not in a rescue crisis` });
      return result;
    }
    result.intents.push({ id: `crises:${victimId}:rescue:move`, kind: 'spatial',
      actorId: victimId, to: 'medical', source: 'crises.rescue',
      preconditions: [{ kind: 'actor_alive', actorId: victimId }] });
    result.intents.push({ id: `crises:${victimId}:rescue:warm`, kind: 'actor',
      actorId: victimId, delta: { bodyTemp: 3, health: 10, stamina: 5 },
      source: 'crises.rescue',
      preconditions: [{ kind: 'actor_alive', actorId: victimId }] });
    victim.location = 'medical';
    crisis.resolvedAtMinute = context.snapshot.elapsed;
    next.active = next.active.filter(entry => entry.crisisId !== crisis.crisisId);
    next.history.push({ ...crisis });
    result.events.push({ proposalId: `crises:${crisis.crisisId}:rescued`,
      type: 'crisis_resolved', actorId: command.actorId, observedBy: 'all',
      payload: { crisisId: crisis.crisisId, kind: crisis.kind, victimId } });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute, context): DomainResult<CrisesState> {
    const next: CrisesState = {
      active: state.active.map(crisis => ({ ...crisis })),
      history: state.history.map(crisis => ({ ...crisis })),
      seq: state.seq,
      lastFoodConflictMinute: state.lastFoodConflictMinute,
      foodConflictCooldownMinutes: state.foodConflictCooldownMinutes,
    };
    const result = emptyResult(next);
    const now = context.snapshot.elapsed;
    if (toMinute <= fromMinute) return result;
    const snapshot = context.snapshot;
    const alive = Object.values(snapshot.npcs).filter(npc => npc.alive);

    const open = (kind: CrisisKind, detail: string, subjectIds: string[]): CrisisRecord => {
      next.seq += 1;
      return { crisisId: `crisis-${next.seq}`, kind, startedAtMinute: now,
        resolvedAtMinute: null, subjectIds, detail };
    };

    // food conflict
    const foodCrisis = next.active.find(entry => entry.kind === 'food_conflict');
    if (snapshot.resources.food < FOOD_CONFLICT_THRESHOLD) {
      if (!foodCrisis
        && now - next.lastFoodConflictMinute >= next.foodConflictCooldownMinutes) {
        const crisis = open('food_conflict',
          `food ${snapshot.resources.food} < ${FOOD_CONFLICT_THRESHOLD}`, []);
        next.active.push(crisis);
        next.lastFoodConflictMinute = now;
        result.events.push({ proposalId: `crises:${crisis.crisisId}:food_conflict`,
          type: 'crisis_started', actorId: 'system', observedBy: 'all',
          payload: { crisisId: crisis.crisisId, kind: 'food_conflict',
            food: snapshot.resources.food } });
      }
    } else if (foodCrisis) {
      next.active = next.active.filter(entry => entry.crisisId !== foodCrisis.crisisId);
      foodCrisis.resolvedAtMinute = now;
      next.history.push({ ...foodCrisis });
      result.events.push({ proposalId: `crises:${foodCrisis.crisisId}:resolved`,
        type: 'crisis_resolved', actorId: 'system', observedBy: 'all',
        payload: { crisisId: foodCrisis.crisisId, kind: 'food_conflict' } });
    }

    // frostbite: day 2 only
    if (snapshot.day === 2) {
      for (const npc of alive) {
        const freezing = npc.bodyTemp < 34.5;
        const existing = next.active.find(entry => entry.kind === 'frostbite'
          && entry.subjectIds.includes(npc.id));
        if (freezing && !existing) {
          const crisis = open('frostbite', `bodyTemp ${npc.bodyTemp.toFixed(1)}`, [npc.id]);
          next.active.push(crisis);
          result.events.push({ proposalId: `crises:${crisis.crisisId}:frostbite`,
            type: 'crisis_started', actorId: npc.id, observedBy: 'all',
            payload: { crisisId: crisis.crisisId, kind: 'frostbite', actorId: npc.id } });
        } else if (!freezing && existing) {
          next.active = next.active.filter(entry => entry.crisisId !== existing.crisisId);
          existing.resolvedAtMinute = now;
          next.history.push({ ...existing });
          result.events.push({ proposalId: `crises:${existing.crisisId}:resolved`,
            type: 'crisis_resolved', actorId: npc.id, observedBy: 'all',
            payload: { crisisId: existing.crisisId, kind: 'frostbite' } });
        }
      }
    }

    // rescue: severe hypothermia, exactly the original `isSevereHypothermic`
    for (const npc of alive) {
      const severe = npc.bodyTemp < 33;
      const existing = next.active.find(entry => entry.kind === 'rescue'
        && entry.subjectIds.includes(npc.id));
      if (severe && !existing) {
        const crisis = open('rescue', `severe hypothermia ${npc.bodyTemp.toFixed(1)}`, [npc.id]);
        next.active.push(crisis);
        result.events.push({ proposalId: `crises:${crisis.crisisId}:rescue`,
          type: 'rescue_needed', actorId: npc.id, observedBy: 'all',
          payload: { crisisId: crisis.crisisId, actorId: npc.id } });
      } else if (!severe && existing) {
        next.active = next.active.filter(entry => entry.crisisId !== existing.crisisId);
        existing.resolvedAtMinute = now;
        next.history.push({ ...existing });
        result.events.push({ proposalId: `crises:${existing.crisisId}:recovered`,
          type: 'crisis_resolved', actorId: npc.id, observedBy: 'all',
          payload: { crisisId: existing.crisisId, kind: 'rescue' } });
      }
    }

    // extinction broadcast
    const extinction = next.active.find(entry => entry.kind === 'extinction');
    if (alive.length <= EXTINCTION_THRESHOLD && !extinction) {
      const crisis = open('extinction', `${alive.length} survivors`, alive.map(npc => npc.id));
      next.active.push(crisis);
      result.events.push({ proposalId: `crises:${crisis.crisisId}:extinction`,
        type: 'crisis_started', actorId: 'system', observedBy: 'all',
        payload: { crisisId: crisis.crisisId, kind: 'extinction', alive: alive.length } });
    }

    // day-4 warning
    if (snapshot.day === 4) {
      const warned = next.active.find(entry => entry.kind === 'day4_warning');
      if (!warned) {
        const crisis = open('day4_warning', 'final day lockdown', []);
        next.active.push(crisis);
        result.events.push({ proposalId: `crises:${crisis.crisisId}:day4`,
          type: 'crisis_started', actorId: 'system', observedBy: 'all',
          payload: { crisisId: crisis.crisisId, kind: 'day4_warning',
            outdoor: snapshot.weather } });
      }
    }
    return result;
  },
};
