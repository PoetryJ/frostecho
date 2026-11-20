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
import { WORK_MODE_PLACE, type WorkMode } from '../../../survival/world-v2';

export type { WorkMode };
export { WORK_MODE_PLACE };

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

/**
 * `task-system.js:39-190`; baseYield / duration / stamina cost kept verbatim.
 * The five work-proxy rows carry the original `baseDuration` in minutes
 * (3600s explore/coordinate/order, 1800s morale, 2400s scout) and the original
 * `staminaCost`; their `place` is the original `targetLocation`, so the
 * authority can demand the real work site instead of any indoor room.
 */
export const TASK_CATALOG: Record<TaskTypeId, TaskDefinition> = {
  COLLECT_WOOD: { id: 'COLLECT_WOOD', name: '🪵 收集木柴', minutes: 30,
    staminaCost: 15, place: 'lumber_camp', yields: { resource: 'firewood', amount: 10 } },
  COLLECT_FOOD: { id: 'COLLECT_FOOD', name: '🍞 收集食物', minutes: 30,
    staminaCost: 12, place: 'frozen_lake', yields: { resource: 'food', amount: 8 } },
  MAINTAIN_POWER: { id: 'MAINTAIN_POWER', name: '⚡ 维护电力', minutes: 40,
    staminaCost: 10, place: 'workshop_door', yields: { resource: 'power', amount: 15 } },
  COLLECT_MATERIAL: { id: 'COLLECT_MATERIAL', name: '🔍 探索废墟', minutes: 60,
    staminaCost: 18, place: 'ruins_site', dailyLimit: 3 },
  PREPARE_WARMTH: { id: 'PREPARE_WARMTH', name: '🧥 准备御寒物资', minutes: 30,
    staminaCost: 8, place: 'warehouse_door' },
  PREPARE_MEDICAL: { id: 'PREPARE_MEDICAL', name: '💊 医疗救治', minutes: 30,
    staminaCost: 5, place: 'medical_door' },
  BOOST_MORALE: { id: 'BOOST_MORALE', name: '🎵 鼓舞士气', minutes: 30,
    staminaCost: 8, place: 'dorm_a_door' },
  COORDINATE: { id: 'COORDINATE', name: '📢 统筹协调', minutes: 60,
    staminaCost: 5, place: 'dorm_a_door' },
  DISTRIBUTE_FOOD: { id: 'DISTRIBUTE_FOOD', name: '🍲 分配食物', minutes: 20,
    staminaCost: 3, place: 'kitchen_door' },
  MAINTAIN_ORDER: { id: 'MAINTAIN_ORDER', name: '🛡️ 维持秩序', minutes: 60,
    staminaCost: 5, place: 'dorm_a_door' },
  REST_RECOVER: { id: 'REST_RECOVER', name: '🛏️ 休息恢复', minutes: 60,
    staminaCost: 0, place: 'dorm_a_door' },
  SCOUT_RUINS: { id: 'SCOUT_RUINS', name: '🔍 废墟侦察', minutes: 40,
    staminaCost: 20, place: 'ruins_site' },
  BUILD_GENERATOR: { id: 'BUILD_GENERATOR', name: '⚡ 建造自动发电机', minutes: 240,
    staminaCost: 20, place: 'workshop_door', builds: 'generator' },
  BUILD_LUMBER_MILL: { id: 'BUILD_LUMBER_MILL', name: '🪵 建造自动伐木机', minutes: 360,
    staminaCost: 25, place: 'workshop_door', builds: 'lumberMill' },
  BUILD_FOOD_COLLECTOR: { id: 'BUILD_FOOD_COLLECTOR', name: '🍞 建造自动捕猎机', minutes: 240,
    staminaCost: 20, place: 'workshop_door', builds: 'foodCollector' },
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
  PREPARE_WARMTH: ['rested'],
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

/**
 * The work a task actually performs; resources come from this, not the close.
 * The five non-resource tasks carry the original `task-effects.js` mode, so a
 * power repair can never close a morale task.
 */
export interface WorkRule {
  action: 'gather' | 'work' | 'refuel' | 'medical' | 'deposit' | 'rest';
  mode?: WorkMode;
  resource?: 'food' | 'firewood';
  amount?: number;
  minutes?: number;
  /**
   * `GATHER_RATES` (`resource-system.js`): wood 8/h, food 5/h. The engine used
   * one 8/h rule for both and rounded amount*2, so food was 60% too generous
   * (parity DIVERGES #2). The rate is now explicit per resource.
   */
  gatherRatePerHour?: number;
  /**
   * `task-system.js:55-62` baseYield 15 per baseDuration 40 min = 22.5/h. The
   * engine charged `work(power)` at the frozen 2/h (parity DIVERGES #3).
   */
  powerPerHour?: number;
  /** Per-second aura of the original PREPARE_MEDICAL (`task-effects.js:216-240`). */
  medicalAura?: { healthPerSecond: number; bodyTempPerSecond: number;
    healthThreshold: number; hypothermiaBelow: number };
  /** DISTRIBUTE_FOOD's own 20 minutes, not the generic 15-minute deposit. */
  durationMinutes?: number;
}

export const WORK_RULES: Record<TaskTypeId, WorkRule | null> = {
  // `resource-system.js` GATHER_RATES: wood 8/h, food 5/h.
  COLLECT_WOOD: { action: 'gather', resource: 'firewood', gatherRatePerHour: 8 },
  COLLECT_FOOD: { action: 'gather', resource: 'food', gatherRatePerHour: 5 },
  // `task-system.js:55-62`: +15 power per 40 minutes.
  MAINTAIN_POWER: { action: 'work', mode: 'power', minutes: 40, powerPerHour: 22.5 },
  COLLECT_MATERIAL: { action: 'work', mode: 'explore', minutes: 60 },
  // `task-effects.js:320-336`: PREPARE_WARMTH is warmth preparation in the
  // warehouse. It spends NO wood; the earlier `refuel(2)` mapping invented a
  // wood sink (four residents burned 23 wood in five hours in the R10 run) and
  // is replaced by the original indoor 30-minute preparation.
  PREPARE_WARMTH: { action: 'rest', minutes: 30 },
  // `task-effects.js:216-240`: health < 60 in the same room +0.03/s, and a
  // hypothermic patient also +0.005/s bodyTemp, for the whole 30 minutes.
  PREPARE_MEDICAL: { action: 'medical', amount: 1,
    medicalAura: { healthPerSecond: 0.03, bodyTempPerSecond: 0.005,
      healthThreshold: 60, hypothermiaBelow: 35.5 } },
  BOOST_MORALE: { action: 'work', mode: 'morale', minutes: 30 },
  COORDINATE: { action: 'work', mode: 'coordinate', minutes: 60 },
  DISTRIBUTE_FOOD: { action: 'deposit', amount: 1, durationMinutes: 20 },
  MAINTAIN_ORDER: { action: 'work', mode: 'order', minutes: 60 },
  REST_RECOVER: { action: 'rest', minutes: 60 },
  SCOUT_RUINS: { action: 'work', mode: 'scout', minutes: 40 },
  BUILD_GENERATOR: null,
  BUILD_LUMBER_MILL: null,
  BUILD_FOOD_COLLECTOR: null,
};

/** work mode -> the task it discharges (the authority's completion mapping). */
export const WORK_MODE_TASK: Record<WorkMode, TaskTypeId> = {
  power: 'MAINTAIN_POWER', explore: 'COLLECT_MATERIAL', morale: 'BOOST_MORALE',
  coordinate: 'COORDINATE', order: 'MAINTAIN_ORDER', scout: 'SCOUT_RUINS',
};

/**
 * The place/duration table is shared with the authority: see
 * `src/execution/place-rules.ts`. Re-exported here so the agency layer keeps one
 * import and cannot drift from `PlaySession.executeCandidate`.
 */
export { requiredPlaceOf, durationOf, ACTION_MINUTES } from '../../../execution/place-rules';

export function receiptTypesFor(type: TaskTypeId): string[] {
  return RECEIPT_TYPES[type] ?? [];
}

export type TaskStatus = 'proposed' | 'accepted' | 'declined' | 'countered'
  | 'reassigned' | 'done' | 'cancelled';

export interface TaskGoal {
  /** The resource this task must actually produce/move, when it is one. */
  resource?: 'food' | 'firewood' | 'power' | 'medicine';
  /** Minimum amount the receipt must carry. */
  amount?: number;
  /** The place/object the receipt must name. */
  place?: 'warehouse' | 'kitchen';
  /** The work mode the receipt must prove (the five non-resource tasks). */
  mode?: WorkMode;
}

export interface TaskRecord {
  taskId: string;
  /** What this instance must actually achieve; receipts are checked against it. */
  goal?: TaskGoal;
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
  /** Receipts already spent by some task: one receipt closes one instance. */
  usedReceipts: string[];
}

/**
 * The goal each type must really reach. The five non-resource tasks are not
 * closed by a generic `worked` receipt: the receipt must carry the original
 * work mode, which is the committed proof that the right work happened.
 * (`COLLECT_MATERIAL` used to demand `power`; the original `explore` source
 * yields no public resource, so that goal was never the real one.)
 */
export const TASK_GOALS: Record<TaskTypeId, TaskGoal> = {
  COLLECT_WOOD: { resource: 'firewood', amount: 1 },
  COLLECT_FOOD: { resource: 'food', amount: 1 },
  MAINTAIN_POWER: { resource: 'power', amount: 1 },
  COLLECT_MATERIAL: { mode: 'explore', amount: 1 },
  PREPARE_WARMTH: { amount: 1 },
  PREPARE_MEDICAL: { amount: 1 },
  BOOST_MORALE: { mode: 'morale' },
  COORDINATE: { mode: 'coordinate' },
  DISTRIBUTE_FOOD: { place: 'warehouse', amount: 1 },
  MAINTAIN_ORDER: { mode: 'order' },
  REST_RECOVER: {},
  SCOUT_RUINS: { mode: 'scout' },
  BUILD_GENERATOR: {},
  BUILD_LUMBER_MILL: {},
  BUILD_FOOD_COLLECTOR: {},
};

function find(state: TasksState, taskId: string): TaskRecord | undefined {
  return state.tasks.find(task => task.taskId === taskId);
}

export const tasksDomain: DomainModule<TasksState> = {
  id: 'tasks',
  initial(): TasksState {
    return { tasks: [], seq: 0, dailyUsage: {}, usedReceipts: [] };
  },

  reduce(state, command: DomainCommand, context): DomainResult<TasksState> {
    const next: TasksState = {
      tasks: state.tasks.map(task => ({ ...task })),
      seq: state.seq,
      dailyUsage: { ...state.dailyUsage },
      usedReceipts: [...state.usedReceipts],
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
        goal: TASK_GOALS[type] ?? {},
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
      if (next.usedReceipts.includes(receiptId)) {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`,
          code: 'receipt_already_used',
          reason: `${receiptId} already closed another task` });
        return result;
      }
      if (receipt.simTime < task.createdAtMinute) {
        result.rejections.push({ intentId: `tasks:${taskId}:complete`,
          code: 'receipt_before_task',
          reason: `${receiptId} predates task ${taskId}` });
        return result;
      }
      // Goal predicate: the receipt must name the right resource/place and
      // carry real amount, not merely be of an accepted type.
      const goal = task.goal ?? {};
      const payload = receipt.payload as Record<string, unknown>;
      if (goal.resource) {
        // A receipt may name the resource explicitly (`resource: food`) or carry
        // it as a numeric field (`worked` reports `power`). Both are real
        // evidence; a different resource is not.
        const named = payload.resource;
        const carried = typeof payload[goal.resource] === 'number'
          ? Number(payload[goal.resource]) : null;
        if (named !== undefined && named !== goal.resource) {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'receipt_goal_resource_mismatch',
            reason: `${task.type} needs ${goal.resource}, receipt is ${String(named)}` });
          return result;
        }
        if (named === undefined && carried === null) {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'receipt_goal_resource_missing',
            reason: `receipt names no ${goal.resource} amount` });
          return result;
        }
        const amount = Number(payload.amount ?? carried ?? 0);
        if (!(amount >= (goal.amount ?? 1))) {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'receipt_goal_amount', reason: `amount ${amount} < ${goal.amount ?? 1}` });
          return result;
        }
      }
      if (goal.place) {
        const place = payload.place ?? payload.to;
        if (place !== goal.place) {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'receipt_goal_place_mismatch',
            reason: `${task.type} needs ${goal.place}, receipt is ${String(place)}` });
          return result;
        }
      }
      // The five non-resource tasks are proven by the real work mode the
      // receipt carries (morale/coordinate/order/explore/scout), not by any
      // `worked` event: a power repair stays a power repair.
      if (goal.mode) {
        if (payload.mode !== goal.mode) {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'receipt_goal_mode_mismatch',
            reason: `${task.type} needs work mode ${goal.mode}, receipt is ${String(payload.mode)}` });
          return result;
        }
        if (goal.amount !== undefined && !(Number(payload.amount ?? 0) >= goal.amount)) {
          result.rejections.push({ intentId: `tasks:${taskId}:complete`,
            code: 'receipt_goal_amount',
            reason: `amount ${String(payload.amount)} < ${goal.amount}` });
          return result;
        }
      }
      next.usedReceipts.push(receiptId);
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

      // ---- `task-effects.js` completion effects (both are world effects, so
      // they are typed intents for every living resident, never a silent write).
      const living = context.actorIds.filter(id => context.snapshot.npcs[id]?.alive);
      if (task.type === 'PREPARE_WARMTH') {
        // `task-effects.js:320-336`: +0.5 bodyTemp and +3 sanity to everyone,
        // and the day's warmth-preparation bonus (furnace-system.js:117 +10%).
        for (const id of living) {
          result.intents.push({ id: `tasks:${taskId}:warmth:${id}`, kind: 'actor', actorId: id,
            delta: { bodyTemp: 0.5, san: 3 }, source: 'tasks.warmth-prepared',
            preconditions: [{ kind: 'actor_alive', actorId: id }] });
        }
        result.intents.push({ id: `tasks:${taskId}:warmth-bonus`, kind: 'intent-note',
          key: 'warmthPreparedDay', value: context.snapshot.day, actorId: task.assigneeId,
          source: 'tasks.warmth-prepared', preconditions: [] });
        result.events.push({ proposalId: `tasks:${taskId}:warmth`,
          type: 'warmth_prepared', actorId: task.assigneeId, observedBy: 'all',
          payload: { taskId, residents: living.length, bodyTemp: 0.5, san: 3,
            day: context.snapshot.day } });
      }
      if (task.type === 'DISTRIBUTE_FOOD') {
        // `task-effects.js:290-318`: one meal costs 1.5 food per resident and
        // gives +25 satiety and +2 sanity. With too little food nothing is
        // served (the original logs the shortage instead of pretending).
        const cost = living.length * 1.5;
        if (context.snapshot.resources.food >= cost) {
          result.intents.push({ id: `tasks:${taskId}:meal-food`, kind: 'resource',
            resource: 'food', delta: -cost, actorId: task.assigneeId,
            source: 'tasks.meal-distributed',
            preconditions: [{ kind: 'resource_at_least', resource: 'food', amount: cost }] });
          for (const id of living) {
            result.intents.push({ id: `tasks:${taskId}:meal:${id}`, kind: 'actor', actorId: id,
              delta: { hunger: 25, san: 2 }, source: 'tasks.meal-distributed',
              preconditions: [{ kind: 'actor_alive', actorId: id }] });
          }
          result.events.push({ proposalId: `tasks:${taskId}:meal`, type: 'food_distributed',
            actorId: task.assigneeId, observedBy: 'all',
            payload: { taskId, residents: living.length, foodCost: cost, hunger: 25 } });
        } else {
          result.events.push({ proposalId: `tasks:${taskId}:meal-short`,
            type: 'food_distribution_insufficient', actorId: task.assigneeId,
            observedBy: 'all', payload: { taskId, need: cost,
              have: context.snapshot.resources.food } });
        }
      }
      if (task.type === 'PREPARE_MEDICAL') {
        // `task-effects.js:216-240`: a per-second aura on the room the medic
        // stands in. The engine settles work on the clock, so the aura is
        // applied ONCE over the real minutes the work occupied, sampled at
        // settlement (`medical-aura/settlement-sampled`). That is the honest
        // maximum here: the room is not re-scanned per second, so a patient
        // who walks in halfway is treated as present for the whole window and
        // one who leaves is treated as present for none. Named, not hidden.
        const aura = WORK_RULES.PREPARE_MEDICAL?.medicalAura;
        const medic = context.snapshot.npcs[task.assigneeId];
        const minutes = TASK_CATALOG.PREPARE_MEDICAL.minutes;
        const seconds = minutes * 60;
        const reached: string[] = [];
        if (aura && medic) {
          for (const id of living) {
            const patient = context.snapshot.npcs[id];
            if (!patient || patient.location !== medic.location) continue;
            const healthGain = patient.health < aura.healthThreshold
              ? Number((aura.healthPerSecond * seconds).toFixed(3)) : 0;
            const tempGain = patient.bodyTemp < aura.hypothermiaBelow
              ? Number((aura.bodyTempPerSecond * seconds).toFixed(3)) : 0;
            if (healthGain === 0 && tempGain === 0) continue;
            reached.push(id);
            result.intents.push({ id: `tasks:${taskId}:aura:${id}`, kind: 'actor',
              actorId: id, delta: { health: healthGain, bodyTemp: tempGain },
              source: 'tasks.medical-aura', preconditions: [{ kind: 'actor_alive', actorId: id }] });
          }
          result.events.push({ proposalId: `tasks:${taskId}:aura`,
            type: 'medical_aura_settled', actorId: task.assigneeId, observedBy: 'all',
            payload: { taskId, place: medic.location, minutes, reached,
              model: 'medical-aura/settlement-sampled' } });
        }
      }
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
      usedReceipts: [...state.usedReceipts],
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
