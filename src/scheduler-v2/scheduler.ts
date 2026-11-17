/**
 * Fair multi-actor scheduler (E). One decision in flight per actor, round-robin
 * starts, per-task timeout, cancellation, and an explicit commit lease.
 *
 * R2 fixes the audited lifecycle defects:
 *  - a timeout no longer just stops waiting: it REVOKES the task's lease, so a
 *    late result has no right to submit world effects (the task asks its lease
 *    in the synchronous commit section; `assertActive` fails closed);
 *  - the version check happens BEFORE a task starts, never after it finishes:
 *    a task's own successful submission must not be re-labelled `late`;
 *  - every outcome (completed/timed_out/failed/cancelled/late) is returned so
 *    the application can surface real terminal states instead of dropping them.
 *
 * The old task may keep consuming CPU after revocation (JavaScript promises
 * cannot be force-killed); the contract bounds it to "no commit right", and the
 * next task must not start while the old one still holds an active lease.
 */
export interface TaskLease {
  readonly taskId: string;
  readonly actorId: string;
  readonly generation: number;
  active: boolean;
  revokedReason: string | null;
  revoke(reason: string): void;
  /** Throws when the lease was revoked; used inside synchronous commit sections. */
  assertActive(): void;
}

export interface ScheduledTask<T> {
  taskId: string;
  actorId: string;
  stateVersion: number;
  run: (lease: TaskLease) => Promise<T>;
}

export type TaskOutcome<T> =
  | { taskId: string; actorId: string; status: 'completed'; value: T }
  | { taskId: string; actorId: string; status: 'timed_out'; revoked: boolean }
  | { taskId: string; actorId: string; status: 'failed'; error: string }
  | { taskId: string; actorId: string; status: 'cancelled' }
  | { taskId: string; actorId: string; status: 'late'; currentVersion: number };

export interface SchedulerOptions {
  timeoutMs?: number;
  currentVersion?: (actorId: string) => number;
  /**
   * Pre-flight staleness check. Default true (a task declared for version N is
   * late when the world is already at another version). Apps that build their
   * request fresh inside run() may pass false and rely on commit-time checks.
   */
  checkVersion?: boolean;
  onOutcome?: (outcome: TaskOutcome<unknown>) => void;
}

class Lease implements TaskLease {
  active = true;
  revokedReason: string | null = null;
  constructor(readonly taskId: string, readonly actorId: string, readonly generation: number) {}

  revoke(reason: string): void {
    if (!this.active) return;
    this.active = false;
    this.revokedReason = reason;
  }

  assertActive(): void {
    if (!this.active) throw new Error(`lease_revoked:${this.revokedReason ?? 'unknown'}`);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); resolve('timeout'); }, timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

export class FairScheduler {
  private readonly queues = new Map<string, ScheduledTask<unknown>[]>();
  private readonly cancelled = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly generations = new Map<string, number>();

  add<T>(task: ScheduledTask<T>): void {
    const queue = this.queues.get(task.actorId) ?? [];
    queue.push(task as ScheduledTask<unknown>);
    this.queues.set(task.actorId, queue);
  }

  cancel(taskId: string): void {
    this.cancelled.add(taskId);
  }

  get activeActors(): string[] {
    return [...this.inFlight];
  }

  /** Monotonic commit-generation counter for an actor. */
  generation(actorId: string): number {
    return this.generations.get(actorId) ?? 0;
  }

  /** Invalidate every outstanding submission right for an actor. */
  revokeActor(actorId: string, reason: string): number {
    const next = this.generation(actorId) + 1;
    this.generations.set(actorId, next);
    for (const task of this.inFlightTasks.get(actorId) ?? []) task.revoke(reason);
    return next;
  }

  private readonly inFlightTasks = new Map<string, Set<Lease>>();

  /** Run all queues concurrently; each actor's queue is strictly sequential. */
  async run<T = unknown>(options: SchedulerOptions = {}): Promise<TaskOutcome<T>[]> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const checkVersion = options.checkVersion ?? true;
    const outcomes: TaskOutcome<T>[] = [];
    const push = (outcome: TaskOutcome<unknown>) => {
      outcomes.push(outcome as TaskOutcome<T>);
      options.onOutcome?.(outcome);
    };
    const actorQueues = [...this.queues.entries()];
    await Promise.all(actorQueues.map(async ([actorId, queue]) => {
      for (const task of queue) {
        if (this.cancelled.has(task.taskId)) {
          push({ taskId: task.taskId, actorId, status: 'cancelled' });
          continue;
        }
        // Pre-flight freshness: reject work requested against another version
        // before it runs. Never checked after completion (the task's own
        // submission legitimately advances the version).
        if (checkVersion && options.currentVersion) {
          const current = options.currentVersion(actorId);
          if (current !== task.stateVersion) {
            push({ taskId: task.taskId, actorId, status: 'late', currentVersion: current });
            continue;
          }
        }
        const lease = new Lease(task.taskId, actorId, this.generation(actorId));
        const leases = this.inFlightTasks.get(actorId) ?? new Set<Lease>();
        leases.add(lease);
        this.inFlightTasks.set(actorId, leases);
        this.inFlight.add(actorId);
        try {
          const result = await withTimeout(task.run(lease), timeoutMs, () => lease.revoke('timeout'));
          if (result === 'timeout') {
            push({ taskId: task.taskId, actorId, status: 'timed_out', revoked: !lease.active });
            continue;
          }
          push({ taskId: task.taskId, actorId, status: 'completed', value: result });
        } catch (error) {
          push({ taskId: task.taskId, actorId, status: 'failed', error: (error as Error).message });
        } finally {
          leases.delete(lease);
          if (leases.size === 0) this.inFlightTasks.delete(actorId);
          this.inFlight.delete(actorId);
        }
      }
    }));
    return outcomes;
  }
}

/** Round-robin start order, used to prove fairness without wall-clock flakiness. */
export function fairOrder(tasks: ScheduledTask<unknown>[]): string[] {
  const byActor = new Map<string, string[]>();
  for (const task of tasks) {
    const queue = byActor.get(task.actorId) ?? [];
    queue.push(task.taskId);
    byActor.set(task.actorId, queue);
  }
  const order: string[] = [];
  let remaining = true;
  let index = 0;
  while (remaining) {
    remaining = false;
    for (const queue of byActor.values()) {
      if (index < queue.length) {
        order.push(queue[index]);
        remaining = true;
      }
    }
    index += 1;
  }
  return order;
}
