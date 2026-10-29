import { Location, RULES } from '../types';
import { AgentAction, ParseResult } from './contracts';

const LOCATIONS = new Set<string>(RULES.LOCATIONS);

/**
 * Accept only these JSON objects (key order does not matter):
 *   {"type":"move","to":"dorm"|"kitchen"}
 *   {"type":"eat"}
 *   {"type":"stop"}
 * Extra fields, forged actorId/commandId, and unknown places are rejected.
 */
export function parseAction(raw: string): ParseResult {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid JSON' };
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (obj.type === 'move') {
    if (keys.length !== 2 || !Object.hasOwn(obj, 'to')) {
      return { ok: false, error: 'move must be exactly {"type":"move","to":<location>}' };
    }
    if (typeof obj.to !== 'string' || !LOCATIONS.has(obj.to)) {
      return { ok: false, error: `move.to must be one of ${RULES.LOCATIONS.join('|')}` };
    }
    const action: AgentAction = { type: 'move', to: obj.to as Location };
    return { ok: true, action };
  }
  if (obj.type === 'eat' || obj.type === 'stop') {
    if (keys.length !== 1) {
      return { ok: false, error: `${String(obj.type)} must be exactly {"type":"${String(obj.type)}"}` };
    }
    return { ok: true, action: { type: obj.type } };
  }
  return { ok: false, error: 'type must be move, eat, or stop' };
}
