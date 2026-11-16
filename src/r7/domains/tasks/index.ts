/**
 * P3 task domain: the original fifteen task definitions plus assignment,
 * acceptance, counter-proposal and reassignment.
 *
 * Source: `src/systems/task-system.js:16-190` (TASK_TYPES / TASK_DETAILS) and
 * `src/systems/task-effects.js` for the effect mapping. The original removed
 * MAINTAIN_FURNACE / SET_TRAP / REPAIR_RADIO (`task-system.js:120,163,164`);
 * they are absent here as well.
 *
 * A task is not an action: it produces a goal, the agency layer (A) turns that
 * goal into candidates, and only a confirmed receipt completes the task.
 */
import type { DomainCommand, DomainModule, DomainResult, ResourceId } from '../../contracts';
import { emptyResult } from '../../contracts';

export type TaskTypeId =
  | 'COLLECT_WOOD' | 'COLLECT_FOOD' | 'MAINTAIN_POWER' | 'COLLECT_MATERIAL'
  | 'PREPARE_WARMTH' | 'PREPARE_MEDICAL' | 'BOOST_MORALE' | 'COORDINATE'
  | 'DISTRIBUTE_FOOD' | 'MAINTAIN_ORDER' | 'REST_RECOVER' | 'SCOUT_RUINS'
  | 'BUILD_GENERATOR' | 'BUILD_LUMBER_MILL' | 'BUILD_FOOD_COLLECTOR';

export interface TaskDefinition {
  id: TaskTypeId;
  name: string;
  minutes: number;
  staminaCost: number;
  place: string;
  /** Only the resource tasks have a direct world yield. */
  yields?: { resource: ResourceId; amount: number };
  /** Machines are built through the production domain instead of a yield. */
  builds?: 'generator' | 'lumberMill' | 'foodCollector';
  dailyLimit?: number;
}

/** `task-system.js:39-190`; baseYield / duration / stamina cost kept verbatim. */
export const TASK_CATALOG: Record<TaskTypeId, TaskDefinition> = {
  COLLECT_WOOD: { id: 'COLLECT_WOOD', name: '🪵 收集木柴', minutes: 30,
    staminaCost: 15, place: 'lumber_camp', yields: { resource: 'firewood', amount: 10 } },
  COLLECT_FOOD: { id: 'COLLECT_FOOD', name: '🍞 收集食物', minutes: 30,
    staminaCost: 12, place: 'frozen_lake', yields: { resource: 'food', amount: 8 } },
  MAINTAIN_POWER: { id: 'MAINTAIN_POWER', name: '⚡ 维护电力', minutes: 40,
    staminaCost: 10, place: 'workshop_door', yields: { resource: 'power', amount: 15 } },
  COLLECT_MATERIAL: { id: 'COLLECT_MATERIAL', name: '🔍 探索废墟', minutes: 45,
    staminaCost: 18, place: 'ruins', dailyLimit: 3 },
  PREPARE_WARMTH: { id: 'PREPARE_WARMTH', name: '🧥 准备御寒物资', minutes: 30,
    staminaCost: 8, place: 'workshop' },
  PREPARE_MEDICAL: { id: 'PREPARE_MEDICAL', name: '💊 医疗救治', minutes: 40,
    staminaCost: 10, place: 'medical' },
  BOOST_MORALE: { id: 'BOOST_MORALE', name: '🎵 鼓舞士气', minutes: 30,
    staminaCost: 5, place: 'command' },
  COORDINATE: { id: 'COORDINATE', name: '📢 统筹协调', minutes: 30,
    staminaCost: 5, place: 'command' },
  DISTRIBUTE_FOOD: { id: 'DISTRIBUTE_FOOD', name: '🍲 分配食物', minutes: 20,
    staminaCost: 5, place: 'kitchen' },
  MAINTAIN_ORDER: { id: 'MAINTAIN_ORDER', name: '🛡️ 维持秩序', minutes: 40,
    staminaCost: 10, place: 'village' },
  REST_RECOVER: { id: 'REST_RECOVER', name: '🛏️ 休息恢复', minutes: 60,
    staminaCost: -20, place: 'dorm' },
  SCOUT_RUINS: { id: 'SCOUT_RUINS', name: '🔍 废墟侦察', minutes: 45,
    staminaCost: 15, place: 'ruins' },
  BUILD_GENERATOR: { id: 'BUILD_GENERATOR', name: '⚡ 建造自动发电机', minutes: 240,
    staminaCost: 20, place: 'workshop', builds: 'generator' },
  BUILD_LUMBER_MILL: { id: 'BUILD_LUMBER_MILL', name: '🪵 建造自动伐木机', minutes: 300,
    staminaCost: 20, place: 'workshop', builds: 'lumberMill' },
  BUILD_FOOD_COLLECTOR: { id: 'BUILD_FOOD_COLLECTOR', name: '🍞 建造自动捕猎机', minutes: 300,
    staminaCost: 20, place: 'workshop', builds: 'foodCollector' },
};

export const TASK_IDS = Object.keys(TASK_CATALOG) as TaskTypeId[];

/**
 * The committed event types that can close a task. `machine_build_started` is
 * deliberately absent: starting a build is not finishing it.
 */
export const RECEIPT_TYPES: Record<TaskTypeId, string[]> = {
  COLLECT_WOOD: ['gathered'],
  COLLECT_FOOD: ['gathered'],
  MAINTAIN_POWER: ['worked'],
  COLLECT_MATERIAL: ['gathered', 'worked'],
  PREPARE_WARMTH: ['refuelled'],
  PREPARE_MEDICAL: ['treated'],
  BOOST_MORALE: ['worked'],
  COORDINATE: ['worked'],
  DISTRIBUTE_FOOD: ['stock_deposited', 'meal_delivered'],
  MAINTAIN_ORDER: ['worked'],
  REST_RECOVER: ['rested'],
  SCOUT_RUINS: ['gathered', 'traveled', 'worked'],
  BUILD_GENERATOR: ['machine_built'],
  BUILD_LUMBER_MILL: ['machine_built'],
  BUILD_FOOD_COLLECTOR: ['machine_built'],
};

/** The work a task actually performs; resources come from this, not the close. */
export interface WorkRule {
  action: 'gather' | 'work' | 'refuel' | 'medical' | 'deposit' | 'rest';
  resource?: 'food' | 'firewood';
  amount?: number;
  minutes?: number;
}

export const WORK_RULES: Record<TaskTypeId, WorkRule | null> = {
  COLLECT_WOOD: { action: 'gather', resource: 'firewood', amount: 2 },
  COLLECT_FOOD: { action: 'gather', resource: 'food', amount: 2 },
  MAINTAIN_POWER: { action: 'work', minutes: 40 },
  COLLECT_MATERIAL: { action: 'work', minutes: 45 },
  PREPARE_WARMTH: { action: 'refuel', amount: 2 },
  PREPARE_MEDICAL: { action: 'medical', amount: 1 },
  BOOST_MORALE: { action: 'work', minutes: 30 },
  COORDINATE: { action: 'work', minutes: 30 },
  DISTRIBUTE_FOOD: { action: 'deposit', amount: 1 },
  MAINTAIN_ORDER: { action: 'work', minutes: 40 },
  REST_RECOVER: { action: 'rest', minutes: 60 },
  SCOUT_RUINS: { action: 'work', minutes: 45 },
  BUILD_GENERATOR: null,
  BUILD_LUMBER_MILL: null,
  BUILD_FOOD_COLLECTOR: null,
};

export function receiptTypesFor(type: TaskTypeId): string[] {
  return RECEIPT_TYPES[type] ?? [];
}

export type TaskStatus = 'proposed' | 'accepted' | 'declined' | 'countered'
  | 'reassigned' | 'done' | 'cancelled';

export interface TaskRecord {
  taskId: string;
  type: TaskTypeId;
  proposerId: string;
  assigneeId: string;
  status: TaskStatus;
  revision: number;
  /** Set when someone counters; the counter target must accept it. */
  counterOf?: string;
  reason?: string;
  /** Minutes of work already performed (survives reassignment). */
  workedMinutes: number;
  createdAtMinute: number;
}

export interface TasksState {
  tasks: TaskRecord[];
  seq: number;
  /** Daily usage counters for limited tasks (key: type/actor/day). */
  dailyUsage: Record<string, number>;
}

function find(state: TasksState, taskId: string): TaskRecord | undefined {
  return state.tasks.find(task => task.taskId === taskId);
}

export const tasksDomain: DomainModule<TasksState> = {
  id: 'tasks',
  initial(): TasksState {
    return { tasks: [], seq: 0, dailyUsage: {} };
  },

  reduce(state, command: DomainCommand, context): DomainResult<TasksState> {
    const next: TasksState = {
      tasks: state.tasks.map(task => ({ ...task })),
      seq: state.seq,
      dailyUsage: { ...state.dailyUsage },
    };
    const result = emptyResult(next);
    const now = context.snapshot.elapsed;

    if (command.type === 'propose') {
      const type = command.payload?.type as TaskTypeId;
      const definition = TASK_CATALOG[type];
      if (!definition) {
        result.rejections.push({ intentId: 'tasks:propose', code: 'unknown_task',
          reason: `unknown task ${String(type)}` });
        return result;
      }
      const assigneeId = String(command.payload?.assigneeId ?? command.actorId);
      if (!context.snapshot.npcs[assigneeId]?.alive) {
        result.rejections.push({ intentId: 'tasks:propose', code: 'unknown_assignee',
          reason: `assignee ${assigneeId} is not alive` });
        return result;
      }
      if (definition.dailyLimit) {
        const key = `${type}/${assigneeId}/d${context.snapshot.day}`;
        if ((next.dailyUsage[key] ?? 0) >= definition.dailyLimit) {
          result.rejections.push({ intentId: 'tasks:propose', code: 'daily_limit',
            reason: `${type} already used ${definition.dailyLimit}x today` });
          return result;
        }
      }
      next.seq += 1;
      const task: TaskRecord = {
        taskId: `task-${next.seq}`, type, proposerId: command.actorId, assigneeId,
        status: 'proposed', revision: 1, workedMinutes: 0, createdAtMinute: now,
      };
      next.tasks.push(task);
      result.requests.push({ requestId: `req-${task.taskId}`, kind: 'commitment',
        actorId: assigneeId, payload: { taskId: task.taskId, type, minutes: definition.minutes } });
      result.events.push({ proposalId: `tasks:${task.taskId}:proposed`, type: 'task_proposed',
        actorId: command.actorId, observedBy: 'all',
        payload: { taskId: task.taskId, type, assigneeId } });
      return result;
    }

    const taskId = String(command.payload?.taskId ?? '');
    const task = find(next, taskId);
    if (!task) {
      result.rejections.push({ intentId: `tasks:${command.type}`, code: 'unknown_task_id',
        reason: `no task ${taskId}` });
      return result;
    }

    if (command.type === 'respond') {
      const verdict = String(command.payload?.verdict ?? 'decline');
      const reason = String(command.payload?.reason ?? '');
      if (task.status !== 'proposed' && task.status !== 'countered') {
        result.rejections.push({ intentId: `tasks:${taskId}:respond`, code: 'not_pending',
          reason: `task ${taskId} is ${task.status}` });
        return result;
      }
      if (verdict === 'accept') {
        task.status = 'accepted';
        task.revision += 1;
        result.events.push({ proposalId: `tasks:${taskId}:accepted`, type: 'task_accepted',
          actorId: command.actorId, observedBy: 'all',
          payload: { taskId, revision: task.revision } });
      } else if (verdict === 'counter') {
        const counterType = String(command.payload?.counterType ?? task.type) as TaskTypeId;
        if (!TASK_CATALOG[counterType]) {
          result.rejections.push({ intentId: `tasks:${taskId}:respond`, code: 'unknown_task',
            reason: `unknown counter type ${counterType}` });
          return result;
        }
        next.seq += 1;
        const counter: TaskRecord = {
          taskId: `task-${next.seq}`, type: counterType, proposerId: command.actorId,
          assigneeId: String(command.payload?.assigneeId ?? task.assigneeId),
          status: 'proposed', revision: 1, counterOf: taskId, reason,
          workedMinutes: 0, createdAtMinute: now,
        };
        next.tasks.push(counter);
        task.status = 'countered';
        task.revision += 1;
        result.events.push({ proposalId: `tasks:${taskId}:countered`, type: 'task_countered',
          actorId: command.actorId, observedBy: 'all',
          payload: { taskId, counterTaskId: counter.taskId, counterType, reason } });
      } else {
        task.status = 'declined';
        task.revision += 1;
        task.reason = reason;
        result.events.push({ proposalId: `tasks:${taskId}:declined`, type: 'task_declined',
          actorId: command.actorId, observedBy: 'all', payload: { taskId, reason } });
      }
      return result;
    }

    if (command.type === 'reassign') {
      const toId = String(command.payload?.assigneeId ?? '');
      if (!context.snapshot.npcs[toId]?.alive) {
        result.rejections.push({ intentId: `tasks:${taskId}:reassign`, code: 'unknown_assignee',
          reason: `assignee ${toId} is not alive` });
        return result;
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        result.rejections.push({ intentId: `tasks:${taskId}:reassign`, code: 'terminal',
          reason: `task ${taskId} is ${task.status}` });
        return result;
      }
      const previous = task.assigneeId;
      task.assigneeId = toId;
      task.status = 'accepted';
      task.revision += 1;
      result.events.push({ proposalId: `tasks:${taskId}:reassigned`, type: 'task_reassigned',
        actorId: command.actorId, observedBy: 'all',
        payload: { taskId, from: previous, to: toId, revision: task.revision } });
      return result;
    }

    if (command.type === 'complete') {
      const definition = TASK_CATALOG[task.type];
      if (task.status !== 'accepted' && task.status !== 'reassigned') {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`, code: 'not_accepted',
          reason: `task ${taskId} is ${task.status}` });
        return result;
      }
      const receiptId = command.payload?.receiptEventId;
      if (typeof receiptId !== 'string' || receiptId.length === 0) {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`, code: 'no_receipt',
          reason: 'a task completes only on its own receipt' });
        return result;
      }
      // The receipt must be an event that actually landed in the authority,
      // produced by this assignee, of a type this task can be closed by.
      const receipt = context.committed(receiptId);
      if (!receipt) {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`,
          code: 'receipt_not_committed',
          reason: `no committed event ${receiptId}` });
        return result;
      }
      if (receipt.actorId !== task.assigneeId) {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`,
          code: 'receipt_actor_mismatch',
          reason: `${receiptId} was produced by ${receipt.actorId}, task belongs to ${task.assigneeId}` });
        return result;
      }
      const allowed = RECEIPT_TYPES[task.type] ?? [];
      if (!allowed.includes(receipt.type)) {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`,
          code: 'receipt_type_mismatch',
          reason: `${task.type} needs ${allowed.join('|')}, got ${receipt.type}` });
        return result;
      }
      if (definition.builds) {
        const machineState = context.snapshot.machines[definition.builds];
        if (machineState !== 'running') {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'machine_not_running',
            reason: `${definition.builds} is ${machineState}` });
          return result;
        }
      }
      task.status = 'done';
      task.revision += 1;
      // No yield and no stamina here: the work command already charged and paid.
      if (definition.dailyLimit) {
        const key = `${task.type}/${task.assigneeId}/d${context.snapshot.day}`;
        next.dailyUsage[key] = (next.dailyUsage[key] ?? 0) + 1;
      }
      result.events.push({ proposalId: `tasks:${taskId}:done`, type: 'task_completed',
        actorId: task.assigneeId, observedBy: 'all',
        payload: { taskId, type: task.type, receipt: receiptId, receiptType: receipt.type } });
      return result;
    }

    if (command.type === 'cancel') {
      task.status = 'cancelled';
      task.revision += 1;
      result.events.push({ proposalId: `tasks:${taskId}:cancelled`, type: 'task_cancelled',
        actorId: command.actorId, observedBy: 'all', payload: { taskId } });
      return result;
    }

    result.rejections.push({ intentId: `tasks:${command.type}`, code: 'unknown_command',
      reason: `tasks does not handle ${command.type}` });
    return result;
  },

  onTimeSpan(state, fromMinute, toMinute, context): DomainResult<TasksState> {
    const next: TasksState = {
      tasks: state.tasks.map(task => ({ ...task })),
      seq: state.seq,
      dailyUsage: { ...state.dailyUsage },
    };
    const result = emptyResult(next);
    const minutes = Math.max(0, toMinute - fromMinute);
    if (minutes === 0) return result;
    for (const task of next.tasks) {
      if (task.status !== 'accepted') continue;
      // An assignee that dies mid-work returns the task to the council.
      if (!context.snapshot.npcs[task.assigneeId]?.alive) {
        task.status = 'proposed';
        task.revision += 1;
        result.events.push({ proposalId: `tasks:${task.taskId}:vacated:${toMinute}`,
          type: 'task_vacated', actorId: task.assigneeId, observedBy: 'all',
          payload: { taskId: task.taskId, type: task.type } });
      }
    }
    return result;
  },
};

export const activeTasks = (state: TasksState, actorId?: string): TaskRecord[] =>
  state.tasks.filter(task => (task.status === 'accepted' || task.status === 'proposed')
    && (actorId === undefined || task.assigneeId === actorId));
