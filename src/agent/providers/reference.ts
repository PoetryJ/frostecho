import { DecideInput, Provider } from '../contracts';

/**
 * Offline policy. Reads only DecideInput (observation + goal). Feedback is not
 * consulted; the next observation already reflects the world.
 *
 * 1. Already at the hunger goal → stop, including in the kitchen with food left.
 * 2. Not in the kitchen → move to kitchen.
 * 3. In the kitchen with food here → eat.
 * 4. Otherwise → stop.
 * Stop is a decision, not a world command.
 */
export function referenceDecision(input: DecideInput): string {
  const { observation, goal } = input;
  if (observation.hunger >= goal.hungerAtLeast) return '{"type":"stop"}';
  if (observation.location !== 'kitchen') return '{"type":"move","to":"kitchen"}';
  if (observation.foodHere > 0) return '{"type":"eat"}';
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
