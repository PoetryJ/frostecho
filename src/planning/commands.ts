/** Candidate -> authoritative command mapping (E port used by G). */
import type { Candidate } from '../decision/contracts';
import type { Command } from '../survival/world-v2';

export class UnsupportedActionError extends Error {
  readonly code = 'unsupported_action';

  constructor(candidateId: string, action: unknown) {
    super(`candidate ${candidateId} has no executable action (${String(action)})`);
    this.name = 'UnsupportedActionError';
  }
}

/**
 * Returns the command a candidate stands for, or null for `wait`. Everything
 * else must be explicitly executable; a free-form `talk` candidate is refused
 * rather than silently treated as an action.
 */
export function candidateCommand(candidate: Candidate, actorId: string, commandId: string): Command | null {
  const parameters = candidate.parameters as Record<string, unknown>;
  const action = parameters.action;
  switch (action) {
    case 'eat': return { commandId, type: 'eat', actorId, amount: Number(parameters.amount ?? 1) };
    case 'refuel': return { commandId, type: 'refuel', actorId, amount: Number(parameters.amount ?? 1) };
    case 'rest': return { commandId, type: 'rest', actorId, minutes: Number(parameters.minutes ?? 60) };
    case 'work': return { commandId, type: 'work', actorId, minutes: Number(parameters.minutes ?? 60) };
    case 'gather': {
      const resource = parameters.resource;
      if (resource !== 'food' && resource !== 'firewood') {
        throw new UnsupportedActionError(candidate.id, `gather:${String(resource)}`);
      }
      return { commandId, type: 'gather', actorId, resource, amount: Number(parameters.amount ?? 1) };
    }
    case 'reserve': return { commandId, type: 'reserve', actorId,
      forId: String(parameters.forId ?? 'player'), amount: Number(parameters.amount ?? 1) };
    case 'medical': return { commandId, type: 'medical', actorId, targetId: actorId,
      amount: Number(parameters.amount ?? 1) };
    case 'move': return { commandId, type: 'move', actorId, to: parameters.to as never };
    case 'travel': {
      const route = parameters.route;
      if (!Array.isArray(route) || route.length === 0) {
        throw new UnsupportedActionError(candidate.id, 'travel:route');
      }
      return { commandId, type: 'travel', actorId,
        route: route.map(cell => ({ x: Number(cell.x), y: Number(cell.y) })),
        minutesPerTile: Number(parameters.minutesPerTile ?? 2) };
    }
    case 'withdraw': {
      const place = parameters.place === 'warehouse' ? 'warehouse' as const : null;
      if (!place) throw new UnsupportedActionError(candidate.id, `withdraw:${String(parameters.place)}`);
      return { commandId, type: 'withdraw', actorId, place, resource: 'food' as const,
        amount: Number(parameters.amount ?? 1) };
    }
    case 'deposit': {
      const place = parameters.place === 'warehouse' ? 'warehouse' as const : null;
      if (!place) throw new UnsupportedActionError(candidate.id, `deposit:${String(parameters.place)}`);
      return { commandId, type: 'deposit', actorId, place, resource: 'food' as const,
        amount: Number(parameters.amount ?? 1) };
    }
    case 'deliver': {
      const to = parameters.to === 'kitchen' ? 'kitchen' as const : null;
      if (!to) throw new UnsupportedActionError(candidate.id, `deliver:${String(parameters.to)}`);
      return { commandId, type: 'deliver', actorId, to, amount: Number(parameters.amount ?? 1) };
    }
    case 'wait': return null;
    default: throw new UnsupportedActionError(candidate.id, action);
  }
}
