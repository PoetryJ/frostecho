/**
 * P1 survival domain: body temperature, outdoor exposure, frostbite and death.
 *
 * Ported from the original:
 *   - `src/npc/npc-body.js:32,36,48,65` outdoor cooling `|temp|*0.00025*dt`
 *     (frostbite x1.5, floor 25C), indoor recovery `+0.00333/s` toward 36.5C;
 *   - `src/systems/weather-system.js:244-316` wind chill x1.3 and the three
 *     temperature bands (-50..-20, below -50, above 0);
 *   - `src/systems/weather-system.js:192-199` night temperature drop;
 *   - `src/systems/event-system.js:341` frostbite is a day-2 event.
 *
 * The original clock is 1 real second = 1 game minute (`game.js:42` timeSpeed
 * 60), so a per-second rate is a per-minute rate here. That conversion is the
 * only clock change and is listed in the parity table.
 *
 * Base hunger/stamina/san decay stays in `survival-rules/2` (world-v2) and is
 * NOT re-applied here, so one span never charges a body twice.
 */
import type { ActorDelta, DomainCommand, DomainContext, DomainModule,
  DomainResult } from '../../contracts';
import { emptyResult } from '../../contracts';

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

/** Outdoor temperature per original day configuration. */
export function outdoorTemperature(day: number, minuteOfDay: number,
  weather: string, difficultyOffset = 0): number {
  const base = day >= 4 ? -60 : day === 2 ? -30 : 0;
  const night = minuteOfDay >= 16 * 60 || minuteOfDay < 6 * 60;
  const drop = day >= 4 ? -10 : -5;
  const storm = weather === 'storm' || weather === 'cold-snap';
  return base + (night ? drop : 0) + difficultyOffset - (storm ? 5 : 0);
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
        const warmth = snapshot.furnace.lit || snapshot.furnace.warmth > 0;
        if (warmth) {
          delta.bodyTemp = Math.min(0.2 * minutes,
            BODY_TEMP_TARGET - actor.bodyTemp);
        } else {
          delta.bodyTemp = -Math.abs(outdoor) * 0.0001 * minutes;
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
