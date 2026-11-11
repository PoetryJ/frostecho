/**
 * Gameplay reference policy (P, R2). Deterministic rule-based candidate
 * construction and selection; this is NOT an LLM and the output is labelled
 * `reference-rules/1` everywhere it is reported.
 *
 * Pre-registered relation effect: with an identical world/memory snapshot,
 * relation trust 0 selects gather-food (utility 0.56 vs 0.45) while trust 1
 * selects leave-food (0.60 vs 0.56). No randomness is involved.
 */
import type { Candidate } from '../decision/contracts';
import type { GameplayTask } from './tasks';

export interface GameplayNpcView {
  id: string;
  hunger: number;
  stamina: number;
  health: number;
  san: number;
  alive: boolean;
}

export interface GameplayDecisionInput {
  actorId: string;
  npc: GameplayNpcView;
  resources: { food: number; firewood: number; power: number; medicine: number };
  furnace: { lit: boolean; fuel: number; warmth: number };
  tasks: GameplayTask[];
  /** NPV -> player trust, from the memory store (0 when unknown). */
  relationTrust: number;
}

export interface GameplayConflict {
  kind: 'hunger_vs_leave-food' | 'heating_vs_gather';
  chosen: string;
  deferred: string;
  detail: string;
}

export interface GameplayCandidate {
  candidate: Candidate;
  utility: number;
  rule: string;
}

export interface GameplayStepRecord {
  actorId: string;
  selectedId: string | null;
  executed: boolean;
  reason: string;
  conflict: GameplayConflict | null;
  candidates: { id: string; utility: number; rule: string }[];
  mode: 'reference-rules/1';
}

function candidate(id: string, kind: string, description: string,
  parameters: Record<string, unknown>, utilityComponents: Record<string, number> = {}): Candidate {
  return { id, kind, description, parameters, preconditions: [], expectedEffects: {},
    utilityComponents };
}

export function buildGameplayCandidates(input: GameplayDecisionInput):
  { candidates: GameplayCandidate[]; conflict: GameplayConflict | null } {
  const { npc, resources, furnace } = input;
  const list: GameplayCandidate[] = [];
  let conflict: GameplayConflict | null = null;

  if (npc.hunger < 40 && resources.food >= 1) {
    list.push({ candidate: candidate('g-eat', 'eat', '吃一份食物',
      { action: 'eat', amount: 1 }), utility: 0.4 + (40 - npc.hunger) / 40, rule: 'need.eat' });
  }
  if (npc.stamina < 25) {
    list.push({ candidate: candidate('g-rest', 'rest', '休息',
      { action: 'rest', minutes: 60 }), utility: 0.7, rule: 'need.rest' });
  }

  for (const task of input.tasks) {
    if (task.kind === 'gather-food') {
      list.push({ candidate: candidate('g-gather-food', 'gather', '采集食物',
        { action: 'gather', resource: 'food', amount: 2 }), utility: 0.56,
        rule: 'task.gather-food' });
    }
    if (task.kind === 'gather-wood') {
      list.push({ candidate: candidate('g-gather-wood', 'gather', '采集柴火',
        { action: 'gather', resource: 'firewood', amount: 2 }), utility: 0.5,
        rule: 'task.gather-wood' });
    }
    if (task.kind === 'heating') {
      const cold = !furnace.lit || furnace.fuel < 20;
      if (cold) {
        if (input.resources.firewood >= 3) {
          list.push({ candidate: candidate('g-heat', 'refuel', '给炉子添柴',
            { action: 'refuel', amount: 3 }), utility: 0.6, rule: 'task.heating' });
        } else {
          conflict = { kind: 'heating_vs_gather', chosen: 'g-gather-wood',
            deferred: `task:${task.taskId}`,
            detail: '炉子缺柴且库存不足 3：供暖任务让位给采柴' };
          list.push({ candidate: candidate('g-gather-wood', 'gather', '采集柴火',
            { action: 'gather', resource: 'firewood', amount: 2 }), utility: 0.52,
            rule: 'task.heating.fallback-gather' });
        }
      }
    }
    if (task.kind === 'leave-food') {
      const base = 0.45 + Math.min(1, Math.max(0, input.relationTrust)) * 0.15;
      const hungryDefer = npc.hunger < 35;
      const utility = hungryDefer ? base - 0.6 : base;
      if (hungryDefer) {
        conflict = { kind: 'hunger_vs_leave-food', chosen: 'g-eat',
          deferred: `task:${task.taskId}`,
          detail: `饥饿 ${npc.hunger.toFixed(1)} < 35：先吃，暂缓留饭` };
      }
      list.push({ candidate: candidate(`c-help-${task.promiseId ?? 'player'}`, 'help', '给玩家留饭',
        { action: 'reserve', amount: 1, forId: 'player' }, { obligation: 1 }),
        utility, rule: 'task.leave-food' });
    }
  }

  list.push({ candidate: candidate('g-wait', 'wait', '等待', { action: 'wait' }),
    utility: 0.1, rule: 'baseline.wait' });
  return { candidates: list, conflict };
}

/** Deterministic reference selection: highest utility, ties by candidate id. */
export function chooseReference(candidates: GameplayCandidate[]): GameplayCandidate {
  return [...candidates].sort((left, right) =>
    right.utility - left.utility || left.candidate.id.localeCompare(right.candidate.id))[0];
}
