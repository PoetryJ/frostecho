/**
 * ONE table for how long an action takes, where it must happen and whether it
 * needs a queued, persistent execution record.
 *
 * The candidate layer, the authoritative executor (`PlaySession.executeCandidate`)
 * and the intent settlement all read this module, so a new entry path cannot
 * quietly run a work action instantly or from the wrong site. `WORK_MODE_PLACE`
 * still lives in the world kernel because `submitCommand` already uses it.
 */
import { WORK_MODE_PLACE, type WorkMode } from '../survival/world-v2';

export type { WorkMode };
export { WORK_MODE_PLACE };

/** Minutes an action really occupies its actor (0 = committed immediately). */
export const ACTION_MINUTES: Record<string, number> = {
  rest: 60, work: 40, gather: 30, medical: 20, refuel: 10, deposit: 15, deliver: 15,
  move: 15,
};

/** Actions that must be queued as a persistent intent, never run inline. */
const WORK_CONTRACT_ACTIONS = new Set(['rest', 'work', 'gather', 'medical', 'refuel',
  'deposit', 'deliver']);

export interface ActionLike {
  parameters: Record<string, unknown>;
}

export function durationOf(candidate: ActionLike): number {
  const action = String(candidate.parameters.action ?? '');
  if (action === 'build-machine') return 0; // production owns its build clock
  if (action === 'rest' || action === 'work') {
    const minutes = Number(candidate.parameters.minutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : (ACTION_MINUTES[action] ?? 0);
  }
  return ACTION_MINUTES[action] ?? 0;
}

/**
 * Where a real action must physically happen. The authority checks this before
 * spending time or a resource; one table keeps proposal and execution honest.
 */
export function requiredPlaceOf(action: string, parameters: Record<string, unknown> = {}):
  string | null {
  switch (action) {
    case 'gather': return 'village';
    case 'work': {
      const mode = String(parameters.mode ?? 'power') as WorkMode;
      return WORK_MODE_PLACE[mode] ?? 'workshop';
    }
    case 'medical': return 'medical';
    case 'deposit': return 'warehouse';
    case 'deliver': return 'kitchen';
    default: return null;
  }
}

/** True when the action spends authoritative time and therefore needs an intent. */
export function requiresWorkIntent(candidate: ActionLike): boolean {
  const action = String(candidate.parameters.action ?? '');
  return WORK_CONTRACT_ACTIONS.has(action) && durationOf(candidate) > 0;
}

/**
 * A settlement capability. Only `R8Runtime.settleDueIntents` mints one, and it
 * is used synchronously inside that call, so ordinary callers cannot pass it to
 * `PlaySession.executeCandidate` and skip the queue.
 */
export interface WorkGrant {
  readonly intentId: string;
  readonly actorId: string;
  readonly candidateId: string;
}

const GRANTS = new WeakSet<object>();

export function mintWorkGrant(intentId: string, actorId: string, candidateId: string): WorkGrant {
  const grant: WorkGrant = Object.freeze({ intentId, actorId, candidateId });
  GRANTS.add(grant);
  return grant;
}

export function isWorkGrant(value: unknown): value is WorkGrant {
  return typeof value === 'object' && value !== null && GRANTS.has(value);
}
