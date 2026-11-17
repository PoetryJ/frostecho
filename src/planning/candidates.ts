/**
 * Candidate generation and scoring ports (E).
 *
 * Illegal actions are never offered. Utility components stay interpretable and
 * separate: a utility is not a probability, and the softmax is only a
 * distribution conditioned on this candidate set.
 */
import {
  ContractError,
  makeChoiceRequest,
  makeChoiceResult,
  type Candidate,
  type ChoiceRequest,
  type ChoiceResult,
  type ChoiceTask,
  type ObservedFact,
} from '../decision/contracts';

export interface PlanningNpc {
  id: string;
  hunger: number;
  stamina: number;
  health: number;
  san: number;
  alive: boolean;
}

export interface PlanningView {
  actorId: string;
  npcs: PlanningNpc[];
  resources: { food: number; firewood: number; power: number; medicine: number };
  furnace: { lit: boolean; fuel: number; warmth: number };
  weather: string;
}

export type PromiseStatus = 'active' | 'cancelled' | 'kept' | 'broken' | 'unresolved';

export interface PromiseRef {
  promiseId: string;
  toId: string;
  status: PromiseStatus;
  revision: number;
}

export interface RelationRef {
  fromId: string;
  toId: string;
  trust: number;
  grievance: number;
  debt: number;
}

export interface CandidateInput {
  view: PlanningView;
  promises?: PromiseRef[];
  relations?: RelationRef[];
  /** Optional diagnostics: set by the caller when the memory view was truncated. */
  memoryTruncated?: boolean;
}

const UTILITY_WEIGHTS: Record<string, number> = {
  hunger_need: 1.0,
  stamina_need: 0.8,
  health_need: 1.2,
  power_need: 0.2,
  obligation: 1.6,
  social: 0.5,
  preference: 0.3,
  risk: -0.5,
};

function parametersFor(candidate: Candidate, input: CandidateInput): Record<string, unknown> {
  switch (candidate.id) {
    case 'c-eat': return { action: 'eat', amount: 1 };
    case 'c-refuel': return { action: 'refuel', amount: 1 };
    case 'c-rest': return { action: 'rest', minutes: 60 };
    case 'c-work': return { action: 'work', minutes: 60 };
    case 'c-gather-food': return { action: 'gather', resource: 'food', amount: 2 };
    case 'c-gather-wood': return { action: 'gather', resource: 'firewood', amount: 2 };
    case 'c-medical': return { action: 'medical', amount: 1 };
    case 'c-wait': return { action: 'wait' };
    default:
      if (candidate.id.startsWith('c-help-')) {
        const promise = (input.promises ?? []).find(entry => `c-help-${entry.promiseId}` === candidate.id);
        return { action: 'reserve', amount: 1, forId: promise?.toId ?? 'player' };
      }
      return { action: 'talk' };
  }
}

export function utilityOf(candidate: Candidate): number {
  let total = 0;
  for (const [key, value] of Object.entries(candidate.utilityComponents)) {
    total += (UTILITY_WEIGHTS[key] ?? 0.1) * value;
  }
  return Number(total.toFixed(6));
}

function candidate(id: string, kind: string, description: string,
  utilityComponents: Record<string, number>,
  expectedEffects: Record<string, number> = {},
  preconditions: string[] = []): Candidate {
  return { id, kind, description, parameters: {}, preconditions, expectedEffects,
    utilityComponents: Object.fromEntries(Object.entries(utilityComponents)
      .map(([key, value]) => [key, Number(value.toFixed(6))])) };
}

/** Rules-only candidate set. No model call, no hidden state. */
export function generateCandidates(input: CandidateInput): Candidate[] {
  const { view } = input;
  const self = view.npcs.find(npc => npc.id === view.actorId);
  if (!self || !self.alive) return [];
  const out: Candidate[] = [];
  const food = view.resources.food;
  const wood = view.resources.firewood;
  const medicine = view.resources.medicine;

  if (food >= 1 && self.hunger < 95) {
    out.push(candidate('c-eat', 'eat', '吃掉一份食物', {
      hunger_need: (100 - self.hunger) / 100, preference: 1, risk: 0,
    }, { food: -1, hunger: 9 }, ['food >= 1', 'hunger < 95']));
  }
  if (wood >= 1 && view.furnace.fuel < 60) {
    out.push(candidate('c-refuel', 'refuel', '给暖炉添柴', {
      preference: 0.4, risk: view.furnace.lit ? 0 : 0.3,
    }, { firewood: -1, furnaceFuel: 2 }, ['firewood >= 1', 'fuel < 60']));
  }
  if (self.stamina < 70) {
    out.push(candidate('c-rest', 'rest', '休息恢复体力', {
      stamina_need: (100 - self.stamina) / 100,
    }, { stamina: 6 }, ['alive']));
  }
  if (self.stamina > 10) {
    out.push(candidate('c-work', 'work', '去工作换取电力', {
      power_need: view.resources.power < 20 ? 0.8 : 0.2,
    }, { power: 2, stamina: -4 }, ['stamina > 10']));
  }
  if (view.resources.food < 8) {
    out.push(candidate('c-gather-food', 'gather', '采集食物', {
      preference: 0.6, hunger_need: 0.3,
    }, { food: 6, stamina: -2 }, ['alive']));
  }
  if (wood < 6) {
    out.push(candidate('c-gather-wood', 'gather', '采集木柴', {
      preference: 0.5,
    }, { firewood: 6, stamina: -2 }, ['alive']));
  }
  for (const promise of input.promises ?? []) {
    if (promise.status !== 'active' || food < 1) continue;
    out.push(candidate(`c-help-${promise.promiseId}`, 'help', `履行对 ${promise.toId} 的留饭承诺`, {
      obligation: 1, social: 0.6,
    }, { food: -1, promiseRevision: promise.revision }, ['promise active']));
  }
  if (self.health < 70 && medicine >= 1) {
    out.push(candidate('c-medical', 'medical', '处理伤势', {
      health_need: (100 - self.health) / 100,
    }, { medicine: -1, health: 25 }, ['medicine >= 1']));
  }
  const friend = (input.relations ?? []).find(relation => relation.trust > 0.2 && relation.toId !== self.id);
  if (friend && self.stamina > 20) {
    out.push(candidate(`c-assist-${friend.toId}`, 'social', `与 ${friend.toId} 沟通`, {
      social: Math.min(1, friend.trust),
    }, { stamina: -1 }, ['alive']));
  }
  out.push(candidate('c-wait', 'wait', '原地等待', { preference: 0.1 }, {}, ['alive']));
  return out.map(entry => ({ ...entry, parameters: parametersFor(entry, input) }));
}

export function buildPlanningRequest(input: CandidateInput & {
  requestId: string;
  stateVersion: number;
  memoryFacts?: ObservedFact[];
  memorySnapshotHash?: string;
  memoryPolicyVersion?: string;
  task?: ChoiceTask;
}): ChoiceRequest {
  const candidates = generateCandidates(input);
  return makeChoiceRequest({
    requestId: input.requestId,
    task: input.task ?? 'choose_action',
    actorId: input.view.actorId,
    stateVersion: input.stateVersion,
    observation: { npcs: input.view.npcs, resources: input.view.resources,
      furnace: input.view.furnace, weather: input.view.weather },
    question: '考虑到当前资源、身体状态和承诺，现在最该做什么？',
    memoryFacts: input.memoryFacts ?? [],
    relationships: input.relations ?? [],
    goals: (input.promises ?? []).filter(promise => promise.status === 'active')
      .map(promise => ({ promiseId: promise.promiseId, toId: promise.toId })),
    candidates,
    memorySnapshotHash: input.memorySnapshotHash,
    memoryPolicyVersion: input.memoryPolicyVersion,
  });
}

export type ScorerMode = 'reference' | 'json' | 'jev';

export interface ScorerPort {
  readonly id: string;
  readonly mode: ScorerMode;
  /**
   * R3 (M): real model scorers are slow I/O, so the port accepts Promises.
   * The runtime awaits every call; the commit section after scoring stays
   * synchronous, and freshness (generation/version/memory) is re-checked
   * inside that synchronous section, so a late result still commits nothing.
   */
  score(request: ChoiceRequest): ChoiceResult | Promise<ChoiceResult>;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map(value => value / total);
}

/** Deterministic utility scorer. Always available; proves the mechanics only. */
export function referenceScorer(): ScorerPort {
  return {
    id: 'reference-utility/1',
    mode: 'reference',
    score(request) {
      if (request.candidates.length === 0) {
        return makeChoiceResult({ request, scorerId: 'reference-utility/1', scores: [],
          selectedId: null, disposition: 'unavailable', reason: 'no legal candidates' });
      }
      const utilities = request.candidates.map(utilityOf);
      const probabilities = softmax(utilities);
      const scores = request.candidates.map((candidate, index) => ({
        candidateId: candidate.id,
        logit: utilities[index],
        probability: Number(probabilities[index].toFixed(9)),
      }));
      const best = utilities.reduce((winner, value, index) =>
        value > utilities[winner] ? index : winner, 0);
      return makeChoiceResult({
        request, scorerId: 'reference-utility/1', scores,
        selectedId: request.candidates[best].id, disposition: 'accept',
        reason: `highest utility (${utilities[best].toFixed(3)})`,
      });
    },
  };
}

export interface JsonScorerReply {
  selectedId: string;
  scores?: { candidateId: string; logit: number }[];
}

/** JSON protocol adapter. Malformed or unbound selections are rejected. */
export function jsonScorer(id: string, generate: (request: ChoiceRequest) => JsonScorerReply | string): ScorerPort {
  return {
    id,
    mode: 'json',
    score(request) {
      let reply: JsonScorerReply;
      try {
        const raw = generate(request);
        reply = typeof raw === 'string' ? JSON.parse(raw) as JsonScorerReply : raw;
      } catch (error) {
        return makeChoiceResult({ request, scorerId: id, scores: [], selectedId: null,
          disposition: 'unavailable', reason: `json_parse_error: ${(error as Error).message}` });
      }
      if (!reply || typeof reply.selectedId !== 'string') {
        return makeChoiceResult({ request, scorerId: id, scores: [], selectedId: null,
          disposition: 'unavailable', reason: 'json_missing_selectedId' });
      }
      const scores = reply.scores ?? request.candidates.map(candidate => ({
        candidateId: candidate.id, logit: candidate.id === reply.selectedId ? 1 : 0,
      }));
      return makeChoiceResult({ request, scorerId: id, scores, selectedId: reply.selectedId,
        disposition: 'accept', reason: 'json selected' });
    },
  };
}

/**
 * JEV shadow adapter: it may produce a preference for logging, but it never
 * submits an action. A missing model is `unavailable`, not a silent fallback.
 */
export function jevShadowScorer(id: string,
  predict?: (request: ChoiceRequest) => { candidateId: string; logit: number; probability: number }[]): ScorerPort {
  return {
    id,
    mode: 'jev',
    score(request) {
      if (!predict) {
        return makeChoiceResult({ request, scorerId: id, scores: [], selectedId: null,
          disposition: 'unavailable', reason: 'jev_model_not_loaded' });
      }
      let scores;
      try {
        scores = predict(request);
      } catch (error) {
        return makeChoiceResult({ request, scorerId: id, scores: [], selectedId: null,
          disposition: 'unavailable', reason: `jev_error: ${(error as Error).message}` });
      }
      const ranked = [...scores].sort((left, right) => right.probability - left.probability);
      return makeChoiceResult({ request, scorerId: id,
        scores: scores.map(score => ({ candidateId: score.candidateId, logit: score.logit })),
        selectedId: null, disposition: 'abstain',
        reason: `shadow_only: would pick ${ranked[0]?.candidateId ?? 'n/a'}` });
    },
  };
}

export function assertScorerIdentity(scorer: ScorerPort, expected: { mode: ScorerMode; id?: string }): void {
  if (scorer.mode !== expected.mode) {
    throw new ContractError('scorer_mode', `expected ${expected.mode}, got ${scorer.mode}`);
  }
  if (expected.id && scorer.id !== expected.id) {
    throw new ContractError('scorer_id', `expected ${expected.id}, got ${scorer.id}`);
  }
}
