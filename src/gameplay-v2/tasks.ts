/**
 * Player task board (P, R2). Tasks are explicit assignments the player gives to
 * an NPC; they become candidates in that NPC's decision input and are never
 * hard-coded obligations. Idempotent by (actorId, kind) while active, so a
 * repeated player input does not create a second task.
 *
 * R3 restart fix: `fromJSON` restores the sequence high-water mark computed
 * from the restored rows, so a new assign after save/restore can never mint an
 * ID that collides with a historical row. Explicit taskIds that collide with
 * terminal rows are content-checked and re-minted, and cancel/complete resolve
 * the active row first, so an old archive (even one already carrying the
 * pre-R3 duplicate-ID bug) cannot be mutated by mistake.
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

const ID_SEQUENCE_RE = /^task-(\d+)-/;

/** Resolves the row a taskId lookup should act on: active rows win over history. */
function resolveRow(tasks: GameplayTask[], taskId: string): GameplayTask | undefined {
  let historical: GameplayTask | undefined;
  for (const row of tasks) {
    if (row.taskId !== taskId) continue;
    if (row.status === 'active') return row;
    if (!historical) historical = row;
  }
  return historical;
}

export class TaskBoard {
  readonly tasks: GameplayTask[] = [];
  private sequence = 0;

  private mintId(kind: GameplayTaskKind): string {
    let id = `task-${String(++this.sequence).padStart(3, '0')}-${kind}`;
    while (this.tasks.some(task => task.taskId === id)) {
      id = `task-${String(++this.sequence).padStart(3, '0')}-${kind}`;
    }
    return id;
  }

  assign(actorId: string, kind: GameplayTaskKind, options:
    { taskId?: string; promiseId?: string; now?: number } = {}): GameplayTask {
    const existing = this.tasks.find(task => task.actorId === actorId && task.kind === kind
      && task.status === 'active');
    if (existing) return existing;
    let taskId: string;
    if (options.taskId !== undefined) {
      const clash = resolveRow(this.tasks, options.taskId);
      if (clash && clash.status === 'active') {
        // Content check: an explicit re-transmit naming an active row is only
        // idempotent when it names the same (actorId, kind).
        if (clash.actorId !== actorId || clash.kind !== kind) {
          throw new Error(`taskboard: taskId ${options.taskId} is active for ${clash.actorId}/${clash.kind}`);
        }
        return clash;
      }
      if (clash) {
        // Terminal row with the same explicit ID: a genuinely new request
        // must not be swallowed by (or mutate) history. Mint a fresh ID.
        taskId = this.mintId(kind);
      } else {
        taskId = options.taskId;
      }
    } else {
      taskId = this.mintId(kind);
    }
    const task: GameplayTask = {
      taskId, actorId, kind, status: 'active', assignedAt: options.now ?? 0,
      ...(options.promiseId ? { promiseId: options.promiseId } : {}),
    };
    this.tasks.push(task);
    return task;
  }

  /** Active-first taskId lookup, for callers that need the row itself. */
  find(taskId: string): GameplayTask | undefined {
    return resolveRow(this.tasks, taskId);
  }

  cancel(taskId: string): boolean {
    const task = resolveRow(this.tasks, taskId);
    if (!task || task.status !== 'active') return false;
    task.status = 'cancelled';
    return true;
  }

  activeFor(actorId: string): GameplayTask[] {
    return this.tasks.filter(task => task.actorId === actorId && task.status === 'active');
  }

  complete(taskId: string): void {
    const task = resolveRow(this.tasks, taskId);
    if (task && task.status === 'active') task.status = 'done';
  }

  toJSON(): GameplayTask[] {
    return this.tasks.map(task => ({ ...task }));
  }

  static fromJSON(raw: unknown): TaskBoard {
    const board = new TaskBoard();
    const list = Array.isArray(raw) ? raw as GameplayTask[] : [];
    for (const task of list) {
      board.tasks.push({ ...task });
      const match = ID_SEQUENCE_RE.exec(task.taskId);
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed > board.sequence) board.sequence = parsed;
      }
    }
    return board;
  }
}
