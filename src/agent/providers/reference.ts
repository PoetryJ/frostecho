import { DecideInput, Provider } from '../contracts';

/**
 * Offline policy. Reads only DecideInput (observation + goal). Feedback is not
 * consulted; the next observation already reflects the world.
 *
 * 1. Not full and not in the kitchen → move to kitchen.
 * 2. In the kitchen with food here → eat.
 * 3. Otherwise (no food, or already full) → stop.
 * Stop is a decision, not a world command.
 */
export function referenceDecision(input: DecideInput): string {
  const { observation, goal } = input;
  const full = observation.hunger >= goal.hungerAtLeast;
  if (!full && observation.location !== 'kitchen') return '{"type":"move","to":"kitchen"}';
  if (observation.location === 'kitchen' && observation.foodHere > 0) return '{"type":"eat"}';
  return '{"type":"stop"}';
}

export function createReferenceProvider(): Provider {
  return {
    decide(input, signal) {
      if (signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve(referenceDecision(input));
    },
  };
}
