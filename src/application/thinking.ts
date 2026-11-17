/**
 * G11 action-off — the ONE phase-to-thinking selector.
 *
 * The phase is decided by the system's DecideInput (a goalChoice input is the
 * goal phase, everything else is an action input), never by model output.
 * `thinking` keeps its historical meaning (goal/default); `actionThinking` is
 * an explicit opt-in for the action phase only and inherits when absent.
 */
import type { DecideInput } from '../agent/contracts';

export interface PhaseThinkingConfig {
  thinking: boolean;
  actionThinking?: boolean;
}

/** Pure selection: goal -> thinking; action -> actionThinking ?? thinking. */
export function thinkingForPhase(input: Pick<DecideInput, 'goalChoice'>, config: PhaseThinkingConfig): boolean {
  return input.goalChoice !== undefined ? config.thinking : (config.actionThinking ?? config.thinking);
}

/** The concrete values a run may put on the wire, in goal-then-action order. */
export function phaseThinkingValues(config: PhaseThinkingConfig): boolean[] {
  return [...new Set([config.thinking, config.actionThinking ?? config.thinking])];
}
