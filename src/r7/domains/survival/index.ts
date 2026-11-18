/**
 * P1 survival domain: body temperature, outdoor exposure, frostbite and death.
 *
 * Ported from the original:
 *   - `src/npc/npc-body.js:32,36,48,65` outdoor cooling `|temp|*0.00025*dt`
 *     (frostbite x1.5, floor 25C), indoor recovery `+0.00333/s` toward 36.5C;
 *   - `src/npc/npc-body.js:63-80` indoor without heating: `-|indoorTemp|*0.00003`
 *     when the sheltered temperature is below zero, `+0.001` otherwise;
 *   - `src/systems/furnace-system.js:100-140` central heating: strength from the
 *     wood/power reserve hours (65/35, 24 h target), indoor bodyTemp recovery,
 *     stamina `+0.018/s` and health `+0.006/s` scaled by that strength, and the
 *     x1.1 warmth-preparation bonus;
 *   - `src/systems/weather-system.js:244-316` wind chill x1.3 and the three
 *     temperature bands (-50..-20, below -50, above 0);
 *   - `src/systems/weather-system.js:192-199` night temperature drop;
 *   - `src/systems/event-system.js:341` frostbite is a day-2 event.
 *
 * The original clock is 1 real second = 1 game minute (`game.js:42` timeSpeed
 * 60), so a per-second rate is a per-minute rate here. That conversion is the
 * only clock change and is listed in the parity table.
 *
 * R10-D correction: the heating strength produced by the production domain was
 * a write-only note — nothing consumed it, while the legacy furnace fuel
 * (`world-v2` `evolveSpan`) was the only indoor survival channel. The original
 * removed that furnace (`furnace-system.js:9-14`: one central heating model);
 * the heating therefore now has its real effect here, and effective central
 * heating cancels the obsolete "cold building" drain it replaces.
 *
 * Base hunger/stamina/san decay stays in `survival-rules/2` (world-v2) and is
 * NOT re-applied here, so one span never charges a body twice.
 */
import type { ActorDelta, DomainCommand, DomainContext, DomainModule,
  DomainResult } from '../../contracts';
import { emptyResult } from '../../contracts';
import { heatingStrength } from '../production/index';

export interface SurvivalState {
  /** Accumulated outdoor minutes per actor, reset while indoors. */
  outdoorMinutes: Record<string, number>;
  /** Actors currently flagged as severe hypothermic (bodyTemp < 34). */
  hypothermic: string[];
  /** Last simulated minute this domain observed. */
  lastMinute: number;
  /** Actors whose death was already proposed. */
  reportedDeaths: string[];
}

/** Original outdoor bands, per game minute at the band's reference magnitude. */
export const OUTDOOR_BANDS = [
  { maxTemp: -50, stamina: 1.5, health: 1.2, san: 0.4 },
  { maxTemp: -20, stamina: 0.5, health: 0.35, san: 0.25 },
  { maxTemp: 0, stamina: 0.15, health: 0.10, san: 0.08 },
] as const;

export const WIND_CHILL = 1.3;
export const BODY_TEMP_FLOOR = 25;
export const BODY_TEMP_TARGET = 36.5;
export const HYPOTHERMIA_THRESHOLD = 34;
/** Day-2 outdoor limit in the original: 2 game hours (`weather-system.js:29-40`). */
export const OUTDOOR_LIMIT_MINUTES = 120;

/** `furnace-system.js:22-30` central-heating constants. */
export const HEATING_TARGET_RESERVE_HOURS = 24;
export const HEATING_WARM_INDOOR_TEMP = 16;
export const HEATING_PASSIVE_SHELTER_OFFSET = 4;
export const HEATING_MIN_EFFECTIVE_STRENGTH = 0.08;
export const HEATING_BODY_TEMP_RATE = 0.00333;
export const HEATING_STAMINA_RATE = 0.018;
export const HEATING_HEALTH_RATE = 0.006;
export const HEATING_WARMTH_PREP_BONUS = 1.1;
/** `world-v2 evolveSpan`: the legacy cold-building drain this replaces. */
export const LEGACY_COLD_HEALTH_PER_HOUR = 1.2;

/** Outdoor temperature per original day configuration. */
export function outdoorTemperature(day: number, minuteOfDay: number,
  weather: string, difficultyOffset = 0): number {
  const base = day >= 4 ? -60 : day === 2 ? -30 : 0;
  const night = minuteOfDay >= 16 * 60 || minuteOfDay < 6 * 60;
  const drop = day >= 4 ? -10 : -5;
  const storm = weather === 'storm' || weather === 'cold-snap';
  return base + (night ? drop : 0) + difficultyOffset - (storm ? 5 : 0);
}

/**
 * The town's current heating strength, from the authoritative snapshot. Reads
 * the note the production domain committed in the same span when present, so
 * the two domains cannot disagree about the tank state.
 */
export function heatingOf(snapshot: Readonly<DomainContext['snapshot']>): {
  strength: number; indoorTemp: number; effective: boolean;
} {
  const note = Number(snapshot.facts.heatingStrength);
  const strength = Number.isFinite(note) && note >= 0
    ? note : heatingStrength(snapshot.resources.firewood, snapshot.resources.power);
  const outdoor = outdoorTemperature(snapshot.day, snapshot.minuteOfDay, snapshot.weather);
  const passive = outdoor + HEATING_PASSIVE_SHELTER_OFFSET;
  const indoorTemp = passive + (HEATING_WARM_INDOOR_TEMP - passive) * strength;
  return { strength, indoorTemp, effective: strength >= HEATING_MIN_EFFECTIVE_STRENGTH };
}


export const survivalDomain: DomainModule<SurvivalState> = {
  id: 'survival',
  initial(): SurvivalState {
    return { outdoorMinutes: {}, hypothermic: [], lastMinute: 0, reportedDeaths: [] };
  },

  reduce(state, command: DomainCommand, context): DomainResult<SurvivalState> {
    const next: SurvivalState = {
      outdoorMinutes: { ...state.outdoorMinutes },
      hypothermic: [...state.hypothermic],
      lastMinute: state.lastMinute,
      reportedDeaths: [...state.reportedDeaths],
    };
    const result = emptyResult(next);
    if (command.type === 'medical') {
      const patientId = String(command.payload?.patientId ?? command.actorId);
      const patient = context.snapshot.npcs[patientId];
      if (!patient?.alive) {
        result.rejections.push({ intentId: `survival:${command.actorId}:medical`,
          code: 'no_patient', reason: `unknown or dead patient ${patientId}` });
        return result;
      }
      const medicine = Number(command.payload?.medicine ?? 1);
      result.intents.push({
        id: `survival:${command.actorId}:medical:medicine`,
        kind: 'resource', resource: 'medicine', delta: -medicine,
        actorId: command.actorId, source: 'survival.medical',
        preconditions: [{ kind: 'resource_at_least', resource: 'medicine', amount: medicine }],
      });
      result.intents.push({
        id: `survival:${patientId}:medical:heal`,
        kind: 'actor', actorId: patientId, delta: { health: 25, bodyTemp: 2 },
        source: 'survival.medical',
        preconditions: [{ kind: 'actor_alive', actorId: patientId }],
      });
      if (next.hypothermic.includes(patientId)) {
        next.hypothermic = next.hypothermic.filter(id => id !== patientId);
      }
      result.events.push({ proposalId: `survival:${patientId}:treated`, type: 'npc_treated',
        actorId: command.actorId, observedBy: 'all',
        payload: { patientId, medicine } });
      return result;
    }
    result.rejections.push({ intentId: `survival:${command.type}`, code: 'unknown_command',
      reason: `survival does not handle ${command.type}` });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute, context): DomainResult<SurvivalState> {
    const next: SurvivalState = {
      outdoorMinutes: { ...state.outdoorMinutes },
      hypothermic: [...state.hypothermic],
      lastMinute: toMinute,
      reportedDeaths: [...state.reportedDeaths],
    };
    const result = emptyResult(next);
    const minutes = Math.max(0, toMinute - fromMinute);
    if (minutes === 0) return result;
    const snapshot = context.snapshot;
    const day = snapshot.day;
    const outdoor = outdoorTemperature(day, snapshot.minuteOfDay, snapshot.weather);
    const chill = outdoor < 0 ? outdoor * WIND_CHILL : outdoor;
    const heating = heatingOf(snapshot);
    const warmthBonus = snapshot.facts.warmthPreparedDay === day ? HEATING_WARMTH_PREP_BONUS : 1;
    const heat = heating.strength * warmthBonus;

    for (const actorId of context.actorIds) {
      const actor = snapshot.npcs[actorId];
      if (!actor?.alive) continue;
      const isOutdoor = actor.location === 'village';
      const delta: Record<string, number> = {};
      if (isOutdoor) {
        const accumulated = (next.outdoorMinutes[actorId] ?? 0) + minutes;
        next.outdoorMinutes[actorId] = accumulated;
        const band = OUTDOOR_BANDS.find(entry => chill <= entry.maxTemp);
        if (band) {
          const magnitude = Math.max(1, Math.abs(chill) / 30);
          delta.stamina = -(band.stamina * magnitude * minutes);
          delta.health = -(band.health * magnitude * minutes);
          delta.san = -(band.san * magnitude * minutes);
        }
        const frostbite = next.hypothermic.includes(actorId) ? 1.5 : 1;
        delta.bodyTemp = -Math.abs(chill) * 0.00025 * minutes * frostbite;
        if (day === 2 && accumulated > OUTDOOR_LIMIT_MINUTES) {
          delta.stamina = (delta.stamina ?? 0) - 0.5 * minutes;
          delta.health = (delta.health ?? 0) - 0.3 * minutes;
        }
      } else {
        next.outdoorMinutes[actorId] = Math.max(0, (next.outdoorMinutes[actorId] ?? 0) - minutes);
        // `furnace-system.js:120-140`: effective central heating restores
        // bodyTemp, stamina and health indoors; the rates are per game minute.
        if (heating.effective) {
          delta.bodyTemp = Math.min(HEATING_BODY_TEMP_RATE * minutes,
            BODY_TEMP_TARGET - actor.bodyTemp);
          delta.stamina = HEATING_STAMINA_RATE * heat * minutes;
          delta.health = HEATING_HEALTH_RATE * heat * minutes
            // The legacy `evolveSpan` cold-building drain is what the original
            // central heating replaced; effective heating cancels it, and only
            // a town with no wood AND no power still freezes indoors.
            + (snapshot.furnace.lit ? 0 : LEGACY_COLD_HEALTH_PER_HOUR / 60 * minutes);
        } else if (heating.indoorTemp < 0) {
          // `npc-body.js:70-74`: sheltered but unheated below zero.
          delta.bodyTemp = -Math.abs(heating.indoorTemp) * 0.00003 * minutes;
        } else {
          // `npc-body.js:75-79`: sheltered and above zero.
          delta.bodyTemp = 0.001 * minutes;
        }
      }
      const projected = actor.bodyTemp + (delta.bodyTemp ?? 0);
      if (projected < HYPOTHERMIA_THRESHOLD && !next.hypothermic.includes(actorId)) {
        next.hypothermic = [...next.hypothermic, actorId].sort();
        result.events.push({ proposalId: `survival:${actorId}:hypothermia:${toMinute}`,
          type: 'npc_hypothermic', actorId, observedBy: 'all',
          payload: { bodyTemp: Number(projected.toFixed(2)), day } });
      } else if (projected >= HYPOTHERMIA_THRESHOLD
        && next.hypothermic.includes(actorId)) {
        next.hypothermic = next.hypothermic.filter(id => id !== actorId);
      }
      if (projected <= BODY_TEMP_FLOOR && actor.alive) {
        delta.health = (delta.health ?? 0) - 6 * minutes;
      }
      if (Object.keys(delta).length > 0) {
        result.intents.push({
          id: `survival:${actorId}:span:${toMinute}`,
          kind: 'actor', actorId,
          delta: delta as ActorDelta,
          source: 'survival.onTimeSpan',
          preconditions: [{ kind: 'actor_alive', actorId }],
        });
      }
      const projectedHealth = actor.health + (delta.health ?? 0);
      if (projectedHealth <= 0 && !next.reportedDeaths.includes(actorId)) {
        next.reportedDeaths = [...next.reportedDeaths, actorId].sort();
        result.events.push({ proposalId: `survival:${actorId}:died:${toMinute}`,
          type: 'npc_died', actorId, observedBy: 'all',
          payload: { cause: projected <= BODY_TEMP_FLOOR ? 'hypothermia' : 'exposure' } });
      }
    }
    return result;
  },
};

export const survivalContextOf = (context: Readonly<DomainContext>): string =>
  `${context.profile.id}@${context.snapshot.elapsed}`;
