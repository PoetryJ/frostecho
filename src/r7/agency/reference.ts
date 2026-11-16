/**
 * Reference rule policy over the *same* candidate set the model sees.
 *
 * The utility is computed here, from the request only, and never stored in the
 * candidate: a model must not be able to read a rule's preference out of its
 * input. That is what makes the reference/JEV comparison a comparison of
 * decision makers rather than of inputs.
 */
import {
  makeChoiceResult, type Candidate, type ChoiceRequest, type ChoiceResult,
} from '../../decision/contracts';
import type { ScorePort, ScorerIdentity } from '../contracts';

export const REFERENCE_ID = 'reference-rule/1';
export const REFERENCE_NORMALIZED_ID = 'reference-rule-normalized/1';

export interface ReferenceIdentity extends ScorerIdentity {
  mode: 'reference';
  experimental: false;
  countsAsAdmitted: false;
}

export function referenceIdentity(rendererId = 'agency-options/1'): ReferenceIdentity {
  return {
    mode: 'reference', scorerId: REFERENCE_ID, rendererId,
    experimental: false, countsAsAdmitted: false,
  };
}

interface Observation {
  resources?: { food?: number; firewood?: number; power?: number; medicine?: number };
  self?: { hunger?: number; stamina?: number; health?: number; san?: number };
  belief?: { level?: number | null; rumor?: boolean };
  furnace?: { lit?: boolean; fuel?: number };
}

function observationOf(request: ChoiceRequest): Observation {
  const raw = request.observation;
  return (raw && typeof raw === 'object' ? raw : {}) as Observation;
}

/**
 * Deterministic utility per action family. Higher is better; the numbers are a
 * documented port policy, not a trained value.
 */
export function referenceUtility(candidate: Candidate, request: ChoiceRequest): number {
  const observation = observationOf(request);
  const resources = observation.resources ?? {};
  const self = observation.self ?? {};
  const action = candidate.parameters.action;
  const food = resources.food ?? 0;
  const firewood = resources.firewood ?? 0;
  const power = resources.power ?? 0;
  const medicine = resources.medicine ?? 0;
  const hunger = self.hunger ?? 100;
  const stamina = self.stamina ?? 100;
  const health = self.health ?? 100;

  switch (action) {
    case 'eat':
      return hunger < 40 ? 0.75 + (40 - hunger) / 60 : 0.15;
    case 'rest':
      return stamina < 30 ? 0.7 : 0.2;
    case 'work':
      return power < 60 ? 0.6 : 0.3;
    case 'gather': {
      const resource = String(candidate.parameters.resource ?? '');
      if (resource === 'food') return food < 24 ? 0.72 : 0.35;
      return firewood < 24 ? 0.66 : 0.3;
    }
    case 'refuel':
      return firewood >= 1 ? 0.5 : 0.05;
    case 'medical':
      return health < 70 && medicine >= 1 ? 0.68 : 0.1;
    case 'build-machine':
      return power >= 10 && firewood >= 12 ? 0.62 : 0.02;
    case 'move': {
      const purpose = String(candidate.parameters.purpose ?? '');
      const belief = observation.belief ?? {};
      if (purpose === 'verify-stock') return belief.level === null || belief.rumor ? 0.55 : 0.1;
      return 0.45;
    }
    case 'withdraw':
      return 0.5;
    case 'deliver':
    case 'deposit':
      return 0.48;
    case 'council-counter':
      return 0.4;
    case 'report-delay':
      return 0.3;
    case 'wait':
      return 0.05;
    default:
      return 0.05;
  }
}

/** Task types an action discharges, used for the obligation bonus only. */
function taskTypeOf(candidate: Candidate): string | null {
  const action = candidate.parameters.action;
  if (action === 'gather') {
    return candidate.parameters.resource === 'food' ? 'COLLECT_FOOD' : 'COLLECT_WOOD';
  }
  if (action === 'work') return 'MAINTAIN_POWER';
  if (action === 'rest') return 'REST_RECOVER';
  if (action === 'medical') return 'PREPARE_MEDICAL';
  if (action === 'build-machine') {
    const machine = String(candidate.parameters.machine);
    return machine === 'generator' ? 'BUILD_GENERATOR'
      : machine === 'lumberMill' ? 'BUILD_LUMBER_MILL' : 'BUILD_FOOD_COLLECTOR';
  }
  return null;
}

/**
 * Reference utility = need + an explicit obligation bonus for an accepted task.
 * Both terms are rule constants, recorded here and absent from the candidate.
 */
export function referenceUtilityWithGoals(candidate: Candidate,
  request: ChoiceRequest): number {
  const base = referenceUtility(candidate, request);
  const type = taskTypeOf(candidate);
  if (!type) return base;
  const goals = Array.isArray(request.goals) ? request.goals as { type?: string }[] : [];
  return goals.some(goal => goal?.type === type) ? Number((base + 0.25).toFixed(6)) : base;
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map(value => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return exps.map(value => value / total);
}

/** Reference port over the frozen contract. No model, no randomness. */
export function referenceAgencyScorer(): ScorePort {
  return {
    identity: referenceIdentity(),
    score(request: ChoiceRequest): ChoiceResult {
      if (request.candidates.length === 0) {
        return makeChoiceResult({ request, scorerId: REFERENCE_ID, scores: [],
          selectedId: null, disposition: 'unavailable', reason: 'no candidates' });
      }
      const utilities = request.candidates.map(candidate =>
        Number(referenceUtilityWithGoals(candidate, request).toFixed(6)));
      const probabilities = softmax(utilities);
      const scores = request.candidates.map((candidate, index) => ({
        candidateId: candidate.id,
        logit: utilities[index],
        probability: Number(probabilities[index].toFixed(9)),
      }));
      const best = utilities.reduce((winner, value, index) =>
        value > utilities[winner] ? index : winner, 0);
      return makeChoiceResult({
        request, scorerId: REFERENCE_ID, scores,
        selectedId: request.candidates[best].id, disposition: 'accept',
        reason: `reference utility ${utilities[best].toFixed(3)}`,
      });
    },
  };
}
