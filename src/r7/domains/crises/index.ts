/**
 * P3 crisis domain: food conflict, frostbite (day 2), rescue, extinction and
 * the day-4 special broadcast.
 *
 * Source: `src/systems/event-system.js:82-108` dispatch, `:113` food conflict
 * (food<8, 3600 s cooldown), `:341` frostbite (day 2 only), `:370-401` rescue of
 * severe hypothermic NPCs, `:451-457` extinction at <=2 survivors, `:405-441`
 * day-4 warnings.
 *
 * R10-D: the rescue is now a TWO-STAGE ROUTED rescue instead of a teleport.
 * `event-system.js:370-401` requires a rescuer in the SAME scene with stamina
 * > 30, and gives +0.5 bodyTemp to the victim and -10 stamina to the rescuer.
 * The old implementation wrote `victim.location = 'medical'` and granted
 * +3 bodyTemp / +10 health / +5 stamina for free — an invented teleport that
 * the R10 audit flagged (`runtime.dispatch` refuses it while original-map
 * coordinates are active). Now:
 *   1. `rescue` stage `reach` — the rescuer must ALREADY have walked to the
 *      victim's room (the walk is a real travel leg charged by the driver), and
 *      only the original effects apply;
 *   2. `rescue` stage `escort` — the victim and the rescuer must BOTH have
 *      walked to `medical`; the elapsed minutes between the two stages are the
 *      real escort time and land in the crisis record/event.
 * Neither stage moves anybody: positions only change through real travel.
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

/** `event-system.js:370-401`: a rescuer needs more than this much stamina. */
export const RESCUE_MIN_RESCUER_STAMINA = 30;
/** `event-system.js:388`: one rescue gives the victim +0.5 C. */
export const RESCUE_BODY_TEMP_GAIN = 0.5;
/** `event-system.js:390`: one rescue costs the rescuer 10 stamina. */
export const RESCUE_RESCUER_STAMINA_COST = 10;

export interface CrisisRecord {
  crisisId: string;
  kind: CrisisKind;
  startedAtMinute: number;
  resolvedAtMinute: number | null;
  subjectIds: string[];
  detail: string;
  /** Routed rescue: who reached the victim, when, and how long the escort took. */
  rescuerId?: string;
  stage?: 'reached' | 'escorting';
  reachedAtMinute?: number;
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
    const rescuerId = command.actorId;
    const stage = String(command.payload?.stage ?? 'reach');
    const rescuer = context.snapshot.npcs[rescuerId];
    if (!rescuer?.alive) {
      result.rejections.push({ intentId: `crises:${victimId}:rescue`, code: 'no_rescuer',
        reason: `rescuer ${rescuerId} is not alive` });
      return result;
    }
    if (rescuerId === victimId) {
      result.rejections.push({ intentId: `crises:${victimId}:rescue`, code: 'self_rescue',
        reason: 'the victim cannot rescue itself' });
      return result;
    }

    if (stage === 'escort') {
      // Stage 2: both bodies must already stand in the medical room. The driver
      // walks them there; this domain never moves anybody.
      if (crisis.stage !== 'reached') {
        result.rejections.push({ intentId: `crises:${victimId}:escort`,
          code: 'not_reached', reason: `nobody has reached ${victimId} yet` });
        return result;
      }
      if (rescuer.location !== 'medical' || victim.location !== 'medical') {
        result.rejections.push({ intentId: `crises:${victimId}:escort`,
          code: 'not_at_medical',
          reason: `escort needs both at medical, rescuer is at ${rescuer.location}, `
            + `victim is at ${victim.location}` });
        return result;
      }
      crisis.resolvedAtMinute = context.snapshot.absoluteMinute;
      crisis.stage = 'escorting';
      next.active = next.active.filter(entry => entry.crisisId !== crisis.crisisId);
      next.history.push({ ...crisis });
      result.intents.push({ id: `crises:${victimId}:escort:warm`, kind: 'actor',
        actorId: victimId, delta: { bodyTemp: RESCUE_BODY_TEMP_GAIN },
        source: 'crises.escort',
        preconditions: [{ kind: 'actor_alive', actorId: victimId }] });
      result.events.push({ proposalId: `crises:${crisis.crisisId}:rescued`,
        type: 'crisis_resolved', actorId: rescuerId, observedBy: 'all',
        payload: { crisisId: crisis.crisisId, kind: crisis.kind, victimId, rescuerId,
          at: 'medical',
          escortMinutes: crisis.reachedAtMinute !== undefined
            ? context.snapshot.absoluteMinute - crisis.reachedAtMinute : 0 } });
      return result;
    }

    if (stage !== 'reach') {
      result.rejections.push({ intentId: `crises:${victimId}:rescue`,
        code: 'unknown_stage', reason: `unknown rescue stage ${stage}` });
      return result;
    }
    // Stage 1: the rescuer has to stand in the victim's room. No teleport and
    // no free healing — only the original same-scene rescue applies.
    if (rescuer.location !== victim.location) {
      result.rejections.push({ intentId: `crises:${victimId}:reach`,
        code: 'wrong_location',
        reason: `rescue needs the rescuer at ${victim.location}, actor is at ${rescuer.location}` });
      return result;
    }
    if (rescuer.stamina <= RESCUE_MIN_RESCUER_STAMINA) {
      result.rejections.push({ intentId: `crises:${victimId}:reach`,
        code: 'rescuer_too_tired',
        reason: `rescuer stamina ${rescuer.stamina.toFixed(1)} <= ${RESCUE_MIN_RESCUER_STAMINA}` });
      return result;
    }
    crisis.stage = 'reached';
    crisis.rescuerId = rescuerId;
    crisis.reachedAtMinute = context.snapshot.absoluteMinute;
    result.intents.push({ id: `crises:${victimId}:reach:warm`, kind: 'actor',
      actorId: victimId, delta: { bodyTemp: RESCUE_BODY_TEMP_GAIN },
      source: 'crises.rescue',
      preconditions: [{ kind: 'actor_alive', actorId: victimId }] });
    result.intents.push({ id: `crises:${victimId}:reach:effort`, kind: 'actor',
      actorId: rescuerId, delta: { stamina: -RESCUE_RESCUER_STAMINA_COST },
      source: 'crises.rescue',
      preconditions: [{ kind: 'actor_alive', actorId: rescuerId }] });
    result.events.push({ proposalId: `crises:${crisis.crisisId}:reached`,
      type: 'rescue_reached', actorId: rescuerId, observedBy: 'all',
      payload: { crisisId: crisis.crisisId, victimId, rescuerId,
        place: victim.location, bodyTemp: RESCUE_BODY_TEMP_GAIN,
        staminaCost: RESCUE_RESCUER_STAMINA_COST } });
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
    // R10-D: crisis times live on the WORLD clock (absolute minutes), the same
    // clock every other record uses. The old code wrote `elapsed`, which made a
    // D2 00:00 crisis read "14:20" to anyone comparing it with the journal.
    const now = context.snapshot.absoluteMinute;
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
