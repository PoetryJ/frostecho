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
  location: string;
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
  /**
   * R3 (P): derived delivery phase inputs — carried meals, the actor's own
   * last-confirmed warehouse level (null = never verified), an unverified
   * restock rumor, and precomputed routes. Present only when a deliver-meal
   * task is active.
   */
  delivery?: DeliveryView;
}

/** What the delivery state machine needs; all of it is observable to the actor. */
export interface DeliveryView {
  carried: number;
  stockLevel: number | null;
  restockRumor: boolean;
  routeToWarehouse: Array<{ x: number; y: number }> | null;
  routeToKitchen: Array<{ x: number; y: number }> | null;
}

/** Derived phase of the warehouse -> kitchen meal run (position + carry + belief). */
export type DeliveryPhase = 'deliver' | 'travel-kitchen' | 'withdraw' | 'travel-warehouse'
  | 'gather-fallback' | 'report-blocked';

export function deriveDeliveryPhase(npc: GameplayNpcView, delivery: DeliveryView): DeliveryPhase {
  if (delivery.carried > 0) {
    if (npc.location === 'kitchen') return 'deliver';
    return delivery.routeToKitchen ? 'travel-kitchen' : 'report-blocked';
  }
  if (npc.location === 'warehouse') {
    if (delivery.stockLevel === 0 && !delivery.restockRumor) return 'gather-fallback';
    return 'withdraw';
  }
  if (delivery.routeToWarehouse === null) return 'report-blocked';
  if (delivery.stockLevel === 0 && !delivery.restockRumor) return 'gather-fallback';
  return 'travel-warehouse';
}

function deliveryCandidates(npc: GameplayNpcView, delivery: DeliveryView):
  { entries: GameplayCandidate[]; conflict: GameplayConflict | null } {
  const phase = deriveDeliveryPhase(npc, delivery);
  switch (phase) {
    case 'deliver':
      return { entries: [{ candidate: candidate('g-deliver', 'deliver', '把饭送进厨房',
        { action: 'deliver', to: 'kitchen', amount: 1 }), utility: 0.9, rule: 'delivery.deliver' }], conflict: null };
    case 'travel-kitchen':
      return { entries: [{ candidate: candidate('g-travel-kitchen', 'travel', '带着饭去厨房',
        { action: 'travel', route: delivery.routeToKitchen!, minutesPerTile: 2 }),
        utility: 0.8, rule: 'delivery.travel-kitchen' }], conflict: null };
    case 'withdraw':
      return { entries: [{ candidate: candidate('g-withdraw', 'withdraw', '从仓库取饭',
        { action: 'withdraw', place: 'warehouse', amount: 1 }), utility: 0.75,
        rule: 'delivery.withdraw' }], conflict: null };
    case 'travel-warehouse':
      return { entries: [{ candidate: candidate('g-travel-warehouse', 'travel',
        delivery.restockRumor ? '传闻已补货：回仓库核实' : '去仓库取饭',
        { action: 'travel', route: delivery.routeToWarehouse!, minutesPerTile: 2 }),
        utility: delivery.restockRumor ? 0.72 : 0.7, rule: 'delivery.travel-warehouse' }], conflict: null };
    case 'gather-fallback':
      // 亲见缺货：换来源采集 + 说明延误。承诺保持，不永久禁用仓库路线。
      return { entries: [
        { candidate: candidate('g-gather-food', 'gather', '仓库缺货：改为采集食物',
          { action: 'gather', resource: 'food', amount: 2 }), utility: 0.5,
          rule: 'delivery.fallback-gather' },
        { candidate: candidate('g-report-delay', 'wait', '向玩家说明延误',
          { action: 'wait' }), utility: 0.45, rule: 'delivery.report-delay' }],
        conflict: { kind: 'hunger_vs_leave-food', chosen: 'g-gather-food', deferred: 'delivery',
          detail: '亲见仓库缺货：换来源并说明延误，补货/传闻后重试' } };
    case 'report-blocked':
      return { entries: [
        { candidate: candidate('g-report-blocked', 'wait', '道路封闭：上报无法通行',
          { action: 'wait' }), utility: 0.46, rule: 'delivery.report-blocked' }],
        conflict: { kind: 'heating_vs_gather', chosen: 'g-report-blocked', deferred: 'delivery',
          detail: '路线被封闭：上报等待改道，承诺不自动取消' } };
  }
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
    if (task.kind === 'deliver-meal' && input.delivery) {
      const built = deliveryCandidates(npc, input.delivery);
      list.push(...built.entries);
      conflict = conflict ?? built.conflict;
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
