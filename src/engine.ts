import { applyEvent, checkInvariants, decide } from './rules';
import { Command, CommandResult, WorldEvent, WorldState } from './types';
import { canonical, deepClone, deepFreeze } from './util';

export interface LogEntry { seq: number; command: Command; result: CommandResult }
/** Everything needed to restore the engine, including dedupe info. */
export interface SaveData {
  version: 1;
  initialState: WorldState;
  state: WorldState;
  seq: number;
  eventCounter: number;
  events: WorldEvent[];
  log: LogEntry[];
  /** dedupe index: commandId -> fingerprint + original result */
  processed: Record<string, { fingerprint: string; result: CommandResult }>;
}

/**
 * Content identity for dedupe: actorId + type + payload.
 * Missing payload is not coerced to null or {}. Eat accepts both omission and
 * {}, and rejects null; those three must not share a fingerprint.
 * Explicit payload: undefined is the same as omission (JSON drops both).
 */
export function fingerprint(c: Command): string {
  return canonical({ actorId: c.actorId, type: c.type, payload: c.payload });
}

export class Engine {
  private initial: WorldState;
  private state: WorldState;
  private seq = 0;
  private eventCounter = 0;
  private events: WorldEvent[] = [];
  private log: LogEntry[] = [];
  private processed = new Map<string, { fingerprint: string; result: CommandResult }>();

  constructor(initial: WorldState) {
    const errs = checkInvariants(initial);
    if (errs.length) throw new Error('invalid initial state: ' + errs.join(','));
    this.initial = deepFreeze(deepClone(initial));
    this.state = deepFreeze(deepClone(initial));
  }

  /** Single entry point: validate + commit. Commands processed strictly in call order. */
  submit(raw: unknown): CommandResult {
    const seq = ++this.seq;
    let cmd: Command;
    try { cmd = deepClone(raw) as Command; } catch { cmd = { commandId: '', actorId: '', type: '', payload: null }; }
    const record = (result: CommandResult): CommandResult => {
      const r = deepFreeze(deepClone(result));
      this.log.push(deepFreeze({ seq, command: deepClone(cmd), result: r }));
      return deepClone(r);
    };
    if (!cmd || typeof cmd !== 'object' || typeof cmd.commandId !== 'string' || !cmd.commandId
        || typeof cmd.actorId !== 'string' || typeof cmd.type !== 'string')
      return record({ commandId: String((cmd as any)?.commandId ?? ''), seq, status: 'rejected', reason: 'INVALID_COMMAND', detail: 'commandId/actorId/type must be non-empty strings', eventIds: [] });

    const fp = fingerprint(cmd);
    const prev = this.processed.get(cmd.commandId);
    if (prev) {
      if (prev.fingerprint !== fp)
        return record({ commandId: cmd.commandId, seq, status: 'rejected', reason: 'COMMAND_ID_CONFLICT', detail: `commandId reused with different content (original seq ${prev.result.seq})`, eventIds: [], originalSeq: prev.result.seq });
      return record({ ...prev.result, seq, status: 'duplicate', originalSeq: prev.result.seq, detail: `replay of original result: ${prev.result.status}${prev.result.reason ? ' ' + prev.result.reason : ''}` });
    }

    const d = decide(this.state, cmd);
    let result: CommandResult;
    if (!d.ok) {
      result = { commandId: cmd.commandId, seq, status: 'rejected', reason: d.reason, detail: d.detail, eventIds: [] };
    } else {
      // Atomic: compute all new events & next state first, check invariants, then swap in one step.
      const newEvents: WorldEvent[] = d.events.map(e => ({ ...e, eventId: `e${this.eventCounter + 1 + d.events.indexOf(e)}`, seq, commandId: cmd.commandId } as WorldEvent));
      let next = this.state;
      for (const e of newEvents) next = applyEvent(next, e);
      const errs = checkInvariants(next);
      if (errs.length) throw new Error('invariant violated, nothing committed: ' + errs.join(','));
      this.eventCounter += newEvents.length;
      this.events.push(...newEvents.map(e => deepFreeze(e)));
      this.state = deepFreeze(next);
      result = { commandId: cmd.commandId, seq, status: 'accepted', eventIds: newEvents.map(e => e.eventId) };
    }
    // Both accepted and rejected outcomes are remembered: retrying a rejected id returns the same rejection.
    this.processed.set(cmd.commandId, { fingerprint: fp, result: deepFreeze(deepClone(result)) });
    return record(result);
  }

  getState(): WorldState { return deepClone(this.state); }
  getEvents(): WorldEvent[] { return deepClone(this.events); }
  getLog(): LogEntry[] { return deepClone(this.log); }
  getInitialState(): WorldState { return deepClone(this.initial); }

  save(): SaveData {
    return deepClone({ version: 1 as const, initialState: this.initial, state: this.state, seq: this.seq, eventCounter: this.eventCounter,
      events: this.events, log: this.log, processed: Object.fromEntries(this.processed) });
  }

  /** Restore: state is rebuilt by replaying events (saved `state` is only cross-checked). */
  static restore(data: SaveData): Engine {
    const json: SaveData = JSON.parse(JSON.stringify(data));
    const e = new Engine(json.initialState);
    const rebuilt = replay(json.initialState, json.events);
    if (canonical(rebuilt) !== canonical(json.state)) throw new Error('save corrupt: replayed state != saved state');
    e.state = deepFreeze(rebuilt);
    e.seq = json.seq; e.eventCounter = json.eventCounter;
    e.events = json.events.map(x => deepFreeze(x));
    e.log = json.log.map(x => deepFreeze(x));
    e.processed = new Map(Object.entries(json.processed));
    return e;
  }
}

/** Replay: initial state + committed events. Does NOT call decide()/executor. */
export function replay(initial: WorldState, events: readonly WorldEvent[]): WorldState {
  let s = deepClone(initial);
  for (const e of events) s = applyEvent(s, e);
  return s;
}

export function initialWorld(): WorldState {
  return { tick: 0, npcs: { npc_a: { id: 'npc_a', location: 'dorm', hunger: 40 }, npc_b: { id: 'npc_b', location: 'dorm', hunger: 20 } }, food: { dorm: 0, kitchen: 1 } };
}
