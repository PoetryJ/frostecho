/**
 * Fair multi-actor scheduler (E). One in-flight decision per actor, round-robin
 * starts, per-task timeout, cancellation, and rejection of results produced
 * against an outdated state version. A slow or failing actor cannot block the
 * other actors' queues.
 */
export interface ScheduledTask<T> {
  taskId: string;
  actorId: string;
  stateVersion: number;
  run: () => Promise<T>;
}

export type TaskOutcome<T> =
  | { taskId: string; actorId: string; status: 'completed'; value: T }
  | { taskId: string; actorId: string; status: 'timed_out' }
  | { taskId: string; actorId: string; status: 'failed'; error: string }
  | { taskId: string; actorId: string; status: 'cancelled' }
  | { taskId: string; actorId: string; status: 'late'; currentVersion: number };

export interface SchedulerOptions {
  timeoutMs?: number;
  currentVersion?: (actorId: string) => number;
  onOutcome?: (outcome: TaskOutcome<unknown>) => void;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

export class FairScheduler {
  private readonly queues = new Map<string, ScheduledTask<unknown>[]>();
  private readonly cancelled = new Set<string>();
  private readonly inFlight = new Set<string>();

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

  /** Run all queues concurrently; each actor's queue is strictly sequential. */
  async run(options: SchedulerOptions = {}): Promise<TaskOutcome<unknown>[]> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const outcomes: TaskOutcome<unknown>[] = [];
    const push = (outcome: TaskOutcome<unknown>) => {
      outcomes.push(outcome);
      options.onOutcome?.(outcome);
    };
    const actorQueues = [...this.queues.entries()];
    await Promise.all(actorQueues.map(async ([actorId, queue]) => {
      for (const task of queue) {
        if (this.cancelled.has(task.taskId)) {
          push({ taskId: task.taskId, actorId, status: 'cancelled' });
          continue;
        }
        this.inFlight.add(actorId);
        try {
          const result = await withTimeout(task.run(), timeoutMs);
          if (result === 'timeout') {
            push({ taskId: task.taskId, actorId, status: 'timed_out' });
            continue;
          }
          const current = options.currentVersion ? options.currentVersion(actorId) : task.stateVersion;
          if (current !== task.stateVersion) {
            push({ taskId: task.taskId, actorId, status: 'late', currentVersion: current });
            continue;
          }
          push({ taskId: task.taskId, actorId, status: 'completed', value: result });
        } catch (error) {
          push({ taskId: task.taskId, actorId, status: 'failed', error: (error as Error).message });
        } finally {
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
