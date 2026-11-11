/**
 * Player task board (P, R2). Tasks are explicit assignments the player gives to
 * an NPC; they become candidates in that NPC's decision input and are never
 * hard-coded obligations. Idempotent by (actorId, kind) while active, so a
 * repeated player input does not create a second task.
 */
export type GameplayTaskKind = 'gather-food' | 'gather-wood' | 'heating' | 'leave-food';

export interface GameplayTask {
  taskId: string;
  actorId: string;
  kind: GameplayTaskKind;
  status: 'active' | 'cancelled' | 'done';
  assignedAt: number;
  promiseId?: string;
}

export class TaskBoard {
  readonly tasks: GameplayTask[] = [];
  private sequence = 0;

  assign(actorId: string, kind: GameplayTaskKind, options:
    { taskId?: string; promiseId?: string; now?: number } = {}): GameplayTask {
    const existing = this.tasks.find(task => task.actorId === actorId && task.kind === kind
      && task.status === 'active');
    if (existing) return existing;
    const task: GameplayTask = {
      taskId: options.taskId ?? `task-${String(++this.sequence).padStart(3, '0')}-${kind}`,
      actorId, kind, status: 'active', assignedAt: options.now ?? 0,
      ...(options.promiseId ? { promiseId: options.promiseId } : {}),
    };
    this.tasks.push(task);
    return task;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.find(entry => entry.taskId === taskId);
    if (!task || task.status !== 'active') return false;
    task.status = 'cancelled';
    return true;
  }

  activeFor(actorId: string): GameplayTask[] {
    return this.tasks.filter(task => task.actorId === actorId && task.status === 'active');
  }

  complete(taskId: string): void {
    const task = this.tasks.find(entry => entry.taskId === taskId);
    if (task && task.status === 'active') task.status = 'done';
  }

  toJSON(): GameplayTask[] {
    return this.tasks.map(task => ({ ...task }));
  }

  static fromJSON(raw: unknown): TaskBoard {
    const board = new TaskBoard();
    const list = Array.isArray(raw) ? raw as GameplayTask[] : [];
    for (const task of list) board.tasks.push({ ...task });
    return board;
  }
}
