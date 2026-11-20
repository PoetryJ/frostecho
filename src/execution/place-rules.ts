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
  // R10-D: `medical` is the PREPARE_MEDICAL primitive and the original spends
  // 1800 s on it (`task-system.js:79-86`).
  // R11-D: `deposit`/`deliver` keep 15 as the generic store action, but a
  // candidate that carries its own `minutes` (DISTRIBUTE_FOOD = 20,
  // `task-system.js:105-112`) now bills THAT number — the 6th parity NARROWED.
  rest: 60, work: 40, gather: 30, medical: 30, refuel: 10, deposit: 15, deliver: 15,
  move: 15, 'start-machine': 0,
};

/** Actions that must be queued as a persistent intent, never run inline. */
const WORK_CONTRACT_ACTIONS = new Set(['rest', 'work', 'gather', 'medical', 'refuel',
  'deposit', 'deliver']);

export interface ActionLike {
  parameters: Record<string, unknown>;
}

/** Actions whose catalogue duration can be overridden by the candidate. */
const MINUTES_OVERRIDABLE = new Set(['rest', 'work', 'deposit', 'deliver', 'medical']);

export function durationOf(candidate: ActionLike): number {
  const action = String(candidate.parameters.action ?? '');
  if (action === 'build-machine' || action === 'start-machine') return 0;
  if (MINUTES_OVERRIDABLE.has(action)) {
    const minutes = Number(candidate.parameters.minutes);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
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
    // `machine-system.js:30-78`: a machine is restarted at the workshop panel.
    case 'start-machine': return 'workshop';
    // R10-D (shared table, one line, disclosed in D-R10.md): the original REST_RECOVER
    // happens at `dorm_a_door` (`task-system.js:171`) and the original has no
    // "sleep in the snow" recovery. A rest candidate that names its site must
    // happen there; a bare `rest` command keeps its legacy freedom so the older
    // command tests and fixtures do not change meaning.
    case 'rest':
      return typeof parameters.place === 'string' ? String(parameters.place) : null;
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
