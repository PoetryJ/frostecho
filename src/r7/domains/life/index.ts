/**
 * P4 life domain: the four original endings and the reincarnation cycle.
 *
 * Source:
 *   - `src/systems/death-system.js:16-53` PERFECT 8 / NORMAL 5 / BLEAK 2 /
 *     EXTINCTION 0 survivors;
 *   - `src/systems/death-ending.js:35-47` the ending fires at day 4 hour>=18 or
 *     day>=5, `:17-29` extinction ends the run immediately;
 *   - `src/systems/reincarnation-system.js:15-17,64-69` life number and at most
 *     20 past lives (oldest shifted out), `:82-108` advanceLife;
 *   - `src/core/game.js:738-787` a new life resets time/weather and rebuilds the
 *     NPCs, so no stale stock or promise survives.
 */
import type { DomainCommand, DomainModule, DomainResult } from '../../contracts';
import { emptyResult } from '../../contracts';

export type EndingKind = 'perfect' | 'normal' | 'bleak' | 'extinction';

export const ENDING_THRESHOLDS = { perfect: 8, normal: 5, bleak: 2 } as const;
export const MAX_PAST_LIVES = 20;

export interface LifeRecord {
  lifeNumber: number;
  ending: EndingKind;
  survivors: number;
  endedAtElapsed: number;
  /** Cross-life notes only: conditional lessons, never current facts. */
  lessons: string[];
}

export interface LifeState {
  lifeNumber: number;
  pastLives: LifeRecord[];
  ending: { kind: EndingKind; survivors: number; settledAtElapsed: number } | null;
  /** Prevents a second settlement of the same run. */
  settled: boolean;
}

export function endingFor(survivors: number): EndingKind {
  if (survivors >= ENDING_THRESHOLDS.perfect) return 'perfect';
  if (survivors >= ENDING_THRESHOLDS.normal) return 'normal';
  if (survivors >= ENDING_THRESHOLDS.bleak) return 'bleak';
  return 'extinction';
}

export function isFinalMinute(day: number, minuteOfDay: number): boolean {
  return day >= 5 || (day === 4 && minuteOfDay >= 18 * 60);
}

export const lifeDomain: DomainModule<LifeState> = {
  id: 'life',
  initial(): LifeState {
    return { lifeNumber: 1, pastLives: [], ending: null, settled: false };
  },

  reduce(state, command: DomainCommand, context): DomainResult<LifeState> {
    const next: LifeState = {
      lifeNumber: state.lifeNumber,
      pastLives: state.pastLives.map(record => ({ ...record, lessons: [...record.lessons] })),
      ending: state.ending ? { ...state.ending } : null,
      settled: state.settled,
    };
    const result = emptyResult(next);

    if (command.type === 'settle') {
      if (next.settled) {
        result.rejections.push({ intentId: 'life:settle', code: 'already_settled',
          reason: 'this life is already settled' });
        return result;
      }
      const survivors = Object.values(context.snapshot.npcs)
        .filter(npc => npc.alive).length;
      const kind = endingFor(survivors);
      next.ending = { kind, survivors, settledAtElapsed: context.snapshot.elapsed };
      next.settled = true;
      next.pastLives.push({
        lifeNumber: next.lifeNumber, ending: kind, survivors,
        endedAtElapsed: context.snapshot.elapsed,
        lessons: [...(command.payload?.lessons as string[] ?? [])],
      });
      if (next.pastLives.length > MAX_PAST_LIVES) {
        next.pastLives = next.pastLives.slice(next.pastLives.length - MAX_PAST_LIVES);
      }
      result.events.push({ proposalId: `life:${next.lifeNumber}:ended`, type: 'ending_reached',
        actorId: 'system', observedBy: 'all',
        payload: { lifeNumber: next.lifeNumber, ending: kind, survivors,
          elapsed: context.snapshot.elapsed } });
      result.intents.push({ id: `life:${next.lifeNumber}:ending-note`, kind: 'intent-note',
        key: 'ending', value: kind === 'perfect' ? 4 : kind === 'normal' ? 3
          : kind === 'bleak' ? 2 : 1, actorId: 'system', source: 'life.settle',
        preconditions: [] });
      return result;
    }

    if (command.type === 'reincarnate') {
      if (!next.settled) {
        result.rejections.push({ intentId: 'life:reincarnate', code: 'not_settled',
          reason: 'a new life requires a settled ending' });
        return result;
      }
      next.lifeNumber += 1;
      next.ending = null;
      next.settled = false;
      result.events.push({ proposalId: `life:${next.lifeNumber}:started`,
        type: 'reincarnated', actorId: 'system', observedBy: 'all',
        payload: { lifeNumber: next.lifeNumber,
          pastLives: next.pastLives.length } });
      return result;
    }

    result.rejections.push({ intentId: `life:${command.type}`, code: 'unknown_command',
      reason: `life does not handle ${command.type}` });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute, context): DomainResult<LifeState> {
    const next: LifeState = {
      lifeNumber: state.lifeNumber,
      pastLives: state.pastLives.map(record => ({ ...record })),
      ending: state.ending ? { ...state.ending } : null,
      settled: state.settled,
    };
    const result = emptyResult(next);
    if (toMinute <= fromMinute || next.settled) return result;
    const snapshot = context.snapshot;
    const alive = Object.values(snapshot.npcs).filter(npc => npc.alive).length;
    const final = isFinalMinute(snapshot.day, snapshot.minuteOfDay);
    if (alive === 0 || final) {
      result.events.push({ proposalId: `life:due:${toMinute}`, type: 'ending_due',
        actorId: 'system', observedBy: 'all',
        payload: { survivors: alive, day: snapshot.day,
          elapsed: snapshot.elapsed, reason: alive === 0 ? 'extinction' : 'calendar' } });
    }
    return result;
  },

  serialize(state) {
    return { lifeNumber: state.lifeNumber, pastLives: state.pastLives,
      ending: state.ending, settled: state.settled };
  },

  restore(raw) {
    const value = raw as LifeState;
    if (!value || typeof value.lifeNumber !== 'number' || !Array.isArray(value.pastLives)) {
      throw new Error('invalid life state');
    }
    return { lifeNumber: value.lifeNumber, pastLives: value.pastLives.slice(-MAX_PAST_LIVES),
      ending: value.ending ?? null, settled: Boolean(value.settled) };
  },
};
