/**
 * G09 worker C — the deterministic two-phase reference provider.
 *
 * Offline only: the goal phase answers with the requested goal, the action
 * phase answers with the requested action. It exists so the CLI and the fake
 * batches are playable without a model; it never claims to be a model.
 */
import type { Provider } from '../agent/contracts';
import type { GoalChoiceId } from './contracts';

export interface G09ReferenceOptions {
  /** The goal the reference answers with (self_only always feed_self). */
  goal?: GoalChoiceId;
  /** The action JSON the reference answers with. */
  action?: string;
}

export function createG09ReferenceProvider(options: G09ReferenceOptions = {}): Provider {
  const goal: GoalChoiceId = options.goal ?? 'feed_self';
  const action = options.action ?? '{"type":"eat"}';
  return {
    async decide(input) {
      if (input.goalChoice !== undefined) {
        // A reference in the self_only arm can only say feed_self.
        if (input.goalChoice.arm === 'self_only') return '{"goal":"feed_self"}';
        return JSON.stringify({ goal });
      }
      return action;
    },
  };
}
