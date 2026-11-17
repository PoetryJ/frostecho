/**
 * G03 workstream A — deterministic round-robin scheduler.
 *
 * One global in-flight step at a time: the model requests of several
 * autonomous NPCs are serialized. Rotation: from the cursor inspect at most n
 * actors, pick the first ready, cursor = (picked + 1) % n. Terminal actors are
 * skipped, so an actor that stays ready keeps getting turns. `busy` is
 * synchronous: overlapping advance/run never starts a second provider call.
 * timeout/provider_error interrupt the episode; parse failures and per-actor
 * budget exhaustion are ordinary actor results.
 */
import {
  AdvanceOutcome, RunOutcomeKind, Scheduler, SchedulerOptions, isTerminalStatus, validateActorIds,
} from './contracts';
import type { StepAgentResult } from '../agent/contracts';

export function createScheduler(options: SchedulerOptions): Scheduler {
  const actorIds = [...options.actorIds];
  validateActorIds(actorIds);

  let cursor = 0;
  let inFlight: Promise<StepAgentResult> | null = null;
  let closed = false;
  let running: Promise<RunOutcomeKind> | null = null;

  const allTerminal = (): boolean =>
    actorIds.every(id => isTerminalStatus(options.getStatus(id)));

  /** First ready actor from the cursor, or null. Mutates the cursor only on a pick. */
  function pickReady(): string | null {
    for (let i = 0; i < actorIds.length; i++) {
      const idx = (cursor + i) % actorIds.length;
      const id = actorIds[idx];
      if (options.getStatus(id) === 'ready') {
        cursor = (idx + 1) % actorIds.length;
        return id;
      }
    }
    return null;
  }

  async function advanceOnce(): Promise<AdvanceOutcome> {
    if (closed) return { kind: 'closed' };
    if (inFlight !== null) return { kind: 'busy' };
    const actorId = pickReady();
    if (actorId === null) return allTerminal() ? { kind: 'done' } : { kind: 'busy' };
    const pending = options.step(actorId);
    // Occupied before any await: a second advance() sees busy and adds no request.
    inFlight = pending;
    try {
      const result = await pending;
      if (result.status === 'timeout' || result.status === 'provider_error') {
        return { kind: 'interrupted', actorId, result };
      }
      return { kind: 'stepped', actorId, result };
    } finally {
      if (inFlight === pending) inFlight = null;
    }
  }

  return {
    actorIds,
    advance: async (): Promise<AdvanceOutcome> => {
      if (running !== null) return { kind: 'busy' }; // run() owns the drive
      return advanceOnce();
    },
    run: async (): Promise<RunOutcomeKind> => {
      if (running !== null) return 'busy';
      const task = (async (): Promise<RunOutcomeKind> => {
        for (;;) {
          if (closed) return 'closed';
          if (allTerminal()) return 'done';
          const outcome = await advanceOnce();
          if (outcome.kind === 'interrupted') return 'interrupted';
          if (outcome.kind === 'closed') return 'closed';
          if (outcome.kind === 'done') return 'done';
          // stepped → loop; busy is not expected (we own the loop) but is safe to stop on.
          if (outcome.kind === 'busy') return 'busy';
        }
      })();
      running = task;
      try {
        return await task;
      } finally {
        if (running === task) running = null;
      }
    },
    close: async (): Promise<void> => {
      closed = true; // no new steps from now on
      if (inFlight !== null) await inFlight.then(() => undefined, () => undefined);
      if (running !== null) await running.then(() => undefined, () => undefined);
    },
    isClosed: () => closed,
  };
}
