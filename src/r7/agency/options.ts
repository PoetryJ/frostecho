/**
 * A (agency): turn a visible context into 2..8 meaningful, proposable actions.
 *
 * Rules from the pack:
 *  - the model sees only what this actor can establish; unknown stock is never
 *    enumerated for it (no all-knowing legality filter);
 *  - "proposable" and "executable" are different: a candidate may carry a
 *    precondition that fails later, which is a real observation;
 *  - one natural option stays a single deterministic rule path, never a fake
 *    multi-way choice;
 *  - ids are opaque handles for mapping only, never training features.
 */
import { canonicalJson, sha256Hex, type Candidate } from '../../decision/contracts';
import { requiredPlaceOf, TASK_CATALOG, WORK_RULES, WORK_MODE_PLACE,
  type TaskTypeId } from '../domains/tasks/index';

export interface AgencyView {
  actorId: string;
  npc: { id: string; location: string; hunger: number; stamina: number;
    health: number; san: number; bodyTemp: number; alive: boolean };
  /** Public resources only. Warehouse stock is a belief, not this field. */
  resources: { food: number; firewood: number; power: number; medicine: number };
  furnace: { lit: boolean; fuel: number; warmth: number };
  weather: string;
  machines: Record<string, string>;
  /** Tasks this actor currently holds. */
  tasks: { taskId: string; type: string; status: string }[];
  /** The actor's own last confirmed stock belief, null when never verified. */
  stockBelief: { level: number | null; rumor: boolean };
  /** Conditional notes this actor holds (already filtered by the memory policy). */
  notes: ExperienceNote[];
  /** True when the context was truncated; recorded, never silently dropped. */
  truncated?: boolean;
}

export interface ExperienceNote {
  noteId: string;
  sourceEventIds: string[];
  /** Conditions under which the lesson applies; a changed condition disables it. */
  conditions: Record<string, string | number>;
  lesson: string;
  /** Version of the note format, so a stale note cannot be silently reused. */
  version: number;
}

/**
 * Kind is the executable action family (the frozen executor vocabulary), so a
 * scorer can never invent an action the world cannot run. The resource/machine
 * detail lives in `parameters`.
 */
export type ActionKind =
  | 'eat' | 'rest' | 'gather' | 'work' | 'refuel' | 'medical' | 'move'
  | 'withdraw' | 'deliver' | 'deposit' | 'build-machine'
  | 'council-counter' | 'report-delay' | 'wait';

function candidate(kind: ActionKind, description: string,
  parameters: Record<string, unknown>, preconditions: string[],
  expectedEffects: Record<string, number> = {}): Candidate {
  return {
    // Opaque handle: derived from content so the same option maps to one id
    // across processes, and the id itself carries no utility.
    id: `a-${sha256Hex(canonicalJson({ kind, parameters, preconditions })).slice(0, 12)}`,
    kind,
    description,
    parameters: { action: kind, ...parameters },
    preconditions: [...preconditions].sort(),
    expectedEffects,
    utilityComponents: {},
  };
}

export interface OptionBuild {
  candidates: Candidate[];
  /** Which rule fired, for the evidence trail. */
  rules: string[];
  notesUsed: string[];
}

/**
 * Where each task's work has to happen (the original `targetLocation`). The
 * five non-resource tasks used to be place-free (or `workshop`), which let a
 * resident do dormitory morale work from the warehouse; they now carry the
 * real room, and the authority enforces the same table.
 */
export const PLACE_FOR_TASK: Record<string, string | null> = {
  COLLECT_FOOD: 'village', COLLECT_WOOD: 'village', SCOUT_RUINS: 'village',
  MAINTAIN_POWER: 'workshop', COLLECT_MATERIAL: 'village',
  // `task-system.js:88` targetLocation `warehouse_door`; the port has no door
  // cell, so the warehouse room stands for it (same narrowing as the others).
  PREPARE_WARMTH: 'warehouse', PREPARE_MEDICAL: 'medical',
  DISTRIBUTE_FOOD: 'warehouse',
  BUILD_GENERATOR: 'workshop', BUILD_LUMBER_MILL: 'workshop',
  BUILD_FOOD_COLLECTOR: 'workshop',
  BOOST_MORALE: 'dorm-a', COORDINATE: 'dorm-a', MAINTAIN_ORDER: 'dorm-a',
  REST_RECOVER: 'dorm-a',
};

export const MAX_OPTIONS = 8;
export const MIN_OPTIONS = 2;

export const WORK_PROXY_TASKS: ReadonlySet<TaskTypeId> = new Set([
  'COLLECT_MATERIAL', 'BOOST_MORALE', 'COORDINATE', 'MAINTAIN_ORDER', 'SCOUT_RUINS',
]);

/** Explicit goal identity, validated against the existing executable primitive.
 * The five work proxies prove spent work and the existing receipt contract;
 * they do not prove scouting discoveries, social persuasion, or material yield.
 */
export function taskBindingOfCandidate(entry: Candidate): {
  taskId: string; type: TaskTypeId; evidenceClass: 'task-primitive' | 'work-proxy';
} | null {
  const { taskId, taskType, action } = entry.parameters;
  if (typeof taskId !== 'string' || !taskId || typeof taskType !== 'string'
    || !Object.prototype.hasOwnProperty.call(TASK_CATALOG, taskType)) return null;
  const type = taskType as TaskTypeId;
  const definition = TASK_CATALOG[type], rule = WORK_RULES[type];
  const matches = definition.builds
    ? action === 'build-machine' && entry.parameters.machine === definition.builds
    : type === 'DISTRIBUTE_FOOD' ? action === 'deposit' || action === 'deliver'
      : rule !== null && action === rule.action
        && (!rule.resource || entry.parameters.resource === rule.resource)
        && (!rule.mode || entry.parameters.mode === rule.mode);
  if (!matches) return null;
  return { taskId, type, evidenceClass: WORK_PROXY_TASKS.has(type) ? 'work-proxy' : 'task-primitive' };
}

function bindTask(entry: Candidate, task: AgencyView['tasks'][number]): Candidate {
  const parameters = { ...entry.parameters, taskId: task.taskId, taskType: task.type };
  return { ...entry, parameters,
    id: `a-${sha256Hex(canonicalJson({ kind: entry.kind, parameters,
      preconditions: entry.preconditions })).slice(0, 12)}` };
}

/**
 * Deterministic option construction. Ordering is stable, so the same context
 * always renders the same candidate set (and the same set hash).
 */
/** Task type an action discharges; mirrors the reference/goal binding. */
export function taskTypeOfCandidate(candidate: Candidate): string | null {
  const binding = taskBindingOfCandidate(candidate);
  if (binding) return binding.type;
  const action = candidate.parameters.action;
  if (action === 'gather') {
    return candidate.parameters.resource === 'food' ? 'COLLECT_FOOD' : 'COLLECT_WOOD';
  }
  if (action === 'work') return 'MAINTAIN_POWER';
  if (action === 'rest') return 'REST_RECOVER';
  if (action === 'medical') return 'PREPARE_MEDICAL';
  if (action === 'build-machine') {
    const machine = String(candidate.parameters.machine);
    return machine === 'generator' ? 'BUILD_GENERATOR'
      : machine === 'lumberMill' ? 'BUILD_LUMBER_MILL' : 'BUILD_FOOD_COLLECTOR';
  }
  if (action === 'deposit' || action === 'deliver') return 'DISTRIBUTE_FOOD';
  return null;
}

export function buildActionOptions(view: AgencyView): OptionBuild {
  const candidates: Candidate[] = [];
  const rules: string[] = [];
  const notesUsed: string[] = [];
  const { npc, resources, furnace } = view;
  if (!npc.alive) return { candidates: [], rules: ['dead'], notesUsed: [] };

  if (resources.food >= 1 && npc.hunger < 80) {
    candidates.push(candidate('eat', '吃掉一份食物', { amount: 1 },
      ['food >= 1', 'hunger < 80'], { hunger: 18, food: -1 }));
    rules.push('need.eat');
  }
  if (npc.stamina < 70) {
    candidates.push(candidate('rest', '回宿舍休息', { minutes: 60, place: 'dorm-a' },
      ['awake'], { stamina: 20 }));
    rules.push('need.rest');
  }
  if (npc.stamina > 15) {
    candidates.push(candidate('gather', '去冰湖采集食物', { resource: 'food', amount: 2 },
      ['stamina > 15'], { food: 8, stamina: -12 }));
    candidates.push(candidate('gather', '去伐木场收集木柴', { resource: 'firewood', amount: 2 },
      ['stamina > 15'], { firewood: 10, stamina: -15 }));
    rules.push('yield.gather');
  }
  // R10-D (shared file, one line, disclosed in D-R10.md): the original has ONE
  // central-heating model (`furnace-system.js:9-14`); its strength comes from
  // the wood/power reserve and it needs no manual stoking. The legacy furnace
  // tank remained a per-actor candidate at `fuel < 60`, so eight residents each
  // spent 2-3 wood every hour for a 100-cap tank that burns 0.4/h — 55 wood of
  // the four-day run's 70 went into it, and the town froze at D2 16:00 with the
  // tank still at 72. Now the tank is fed only on a real deficit, and only while
  // the town can still afford it.
  if (resources.firewood >= 8 && furnace.fuel < 20) {
    candidates.push(candidate('refuel', '给中央炉添柴', { amount: 2 },
      ['firewood >= 8', 'fuel < 20'], { furnaceFuel: 4 }));
    rules.push('need.heat');
  }
  if (npc.health < 70 && resources.medicine >= 1) {
    candidates.push(candidate('medical', '处理伤病', { medicine: 1 },
      ['medicine >= 1', 'health < 70'], { health: 25 }));
    rules.push('need.medical');
  }

  // Stock belief: verify only when the actor actually has a stale belief or a
  // rumor. A never-verified actor walks to the warehouse and looks.
  const belief = view.stockBelief;
  if (belief.level === 0 || belief.rumor || belief.level === null) {
    candidates.push(candidate('move', '去仓库核实存粮',
      { to: 'warehouse', purpose: 'verify-stock' }, ['alive'], {}));
    rules.push(belief.rumor ? 'stock.rumor-verify' : 'stock.unknown-verify');
    if (belief.rumor || belief.level === null) {
      candidates.push(candidate('move', '前往仓库', { to: 'warehouse', purpose: 'travel' },
        ['alive'], { travelMinutes: 20 }));
      rules.push('spatial.travel');
    }
    if (belief.level === 0) {
      // A seen shortage is the only reason to switch source; a rumor is not.
      candidates.push(candidate('gather', '仓库缺货：改去采集', { resource: 'food', amount: 2 },
        ['alive'], { food: 8, stamina: -12 }));
      rules.push('stock.fallback-gather');
    }
  }
  // If an accepted task needs a place this actor is not standing in, walking
  // there is the honest next option, not an impossible action.
  const needed = view.tasks.filter(task => task.status === 'accepted')
    .map(task => PLACE_FOR_TASK[task.type]).find(place => place && place !== npc.location);
  if (needed) {
    candidates.push(candidate('move', `前往${needed}`, { to: needed, purpose: 'task-place' },
      ['alive'], { travelMinutes: 15 }));
    rules.push('spatial.task-place');
  }
  for (const task of view.tasks) {
    if (task.status !== 'accepted') continue;
    const firstTaskCandidate = candidates.length;
    switch (task.type) {
      case 'COLLECT_FOOD':
        // The candidate layer reads the same place table as the authority: an
        // action the executor would refuse is never offered; the walk is.
        if (npc.location !== 'village') {
          rules.push(`task.work-place-blocked:${task.type}@village`);
          break;
        }
        candidates.push(candidate('gather', '执行食物采集任务', { resource: 'food', amount: 2 },
          ['stamina > 15'], { food: 8 }));
        rules.push('task.collect-food');
        break;
      case 'COLLECT_WOOD':
        if (npc.location !== 'village') {
          rules.push(`task.work-place-blocked:${task.type}@village`);
          break;
        }
        candidates.push(candidate('gather', '执行伐木任务', { resource: 'firewood', amount: 2 },
          ['stamina > 15'], { firewood: 10 }));
        rules.push('task.collect-wood');
        break;
      case 'MAINTAIN_POWER':
        if (npc.location !== WORK_MODE_PLACE.power) {
          rules.push(`task.work-place-blocked:${task.type}@${WORK_MODE_PLACE.power}`);
          break;
        }
        candidates.push(candidate('work', '去车间维护电力', { minutes: 40 },
          ['stamina > 10'], { power: 15, stamina: -10 }));
        rules.push('task.maintain-power');
        break;
      case 'BUILD_GENERATOR':
      case 'BUILD_LUMBER_MILL':
      case 'BUILD_FOOD_COLLECTOR': {
        const machine = task.type === 'BUILD_GENERATOR' ? 'generator'
          : task.type === 'BUILD_LUMBER_MILL' ? 'lumberMill' : 'foodCollector';
        if (view.machines[machine] === 'absent') {
          candidates.push(candidate('build-machine',
            `建造${machine}`, { machine }, ['power and firewood affordable'],
            { machines: 1 }));
          rules.push('task.build');
        }
        break;
      }
      case 'DISTRIBUTE_FOOD':
        if (npc.location === 'warehouse') {
          candidates.push(candidate('deposit', '把粮食送进仓库', { amount: 1 },
            ['carrying food'], { warehouse: 1 }));
          rules.push('task.distribute');
          break;
        }
        if (npc.location === 'kitchen') {
          candidates.push(candidate('deliver', '把饭送进厨房', { amount: 1 },
            ['carrying meals'], { meals: 1 }));
          rules.push('task.distribute');
          break;
        }
        rules.push(`task.work-place-blocked:${task.type}@warehouse|kitchen`);
        break;
      case 'PREPARE_WARMTH':
        // `task-effects.js:320-336`: 30 minutes of preparation in the warehouse
        // (blankets/clothing), NOT a wood-burning stoke. The old `refuel(2)`
        // candidate burned the town's firewood and could not close this task
        // any more once the domain mapping was corrected.
        if (npc.location !== 'warehouse') {
          rules.push('task.work-place-blocked:PREPARE_WARMTH@warehouse');
          break;
        }
        candidates.push(candidate('rest', '在仓库准备御寒物资', { minutes: 30, place: 'warehouse' },
          ['alive'], { bodyTemp: 0.5, sanity: 3 }));
        rules.push('task.prepare-warmth');
        break;
      case 'PREPARE_MEDICAL':
        candidates.push(candidate('medical', '按分工处理伤病', { medicine: 1 },
          ['medicine >= 1'], { health: 25 }));
        rules.push('task.prepare-medical');
        break;
      case 'BOOST_MORALE':
      case 'COORDINATE':
      case 'MAINTAIN_ORDER':
      case 'SCOUT_RUINS':
      case 'COLLECT_MATERIAL': {
        // Real original semantics, not a generic power shift: the candidate
        // names the work mode, the real duration and the effect it will cause.
        const rule = WORK_RULES[task.type as TaskTypeId]!;
        const definition = TASK_CATALOG[task.type as TaskTypeId];
        const mode = rule.mode!;
        // The site is visible to the actor, so an impossible instant action is
        // never offered: walking there is the offered option instead (the
        // executor would refuse it anyway, but the model should not be invited
        // to spend an hour on a doomed command).
        const required = WORK_MODE_PLACE[mode];
        if (npc.location !== required) {
          rules.push(`task.work-place-blocked:${task.type}@${required}`);
          break;
        }
        const text: Record<string, string> = {
          morale: '在宿舍唱歌鼓舞士气', coordinate: '在宿舍统筹协调、安抚同屋',
          order: '在宿舍维持秩序、调解冲突', scout: '深入废墟侦察稀有物资',
          explore: '去废墟探索可用物资',
        };
        const expected: Record<string, number> = mode === 'morale'
          ? { sanityOthers: 36, sanity: 5 }
          : mode === 'coordinate' ? { sanityOthers: 36, sanity: 5 }
            : mode === 'order' ? { sanityOthers: 54, sanity: 5 }
              : mode === 'scout' ? { sanity: 5, scoutRolls: definition.minutes }
                : { sanity: 5 };
        candidates.push(candidate('work', text[mode] ?? `按分工执行${task.type}`,
          { minutes: definition.minutes, mode }, [`stamina > ${Math.max(10, definition.staminaCost)}`],
          expected));
        rules.push('task.work');
        rules.push(`task.work-proxy:${task.type}`);
        break;
      }
      case 'REST_RECOVER':
        candidates.push(candidate('rest', '按分工休息恢复', { minutes: 60, place: 'dorm-a' },
          ['awake'], { stamina: 20 }));
        rules.push('task.rest');
        break;
      default:
        break;
    }
    for (let index = firstTaskCandidate; index < candidates.length; index += 1) {
      const entry = candidates[index];
      if (WORK_PROXY_TASKS.has(task.type as TaskTypeId)) {
        // Use the already declared work primitive, not a fabricated task effect.
        entry.parameters.minutes = WORK_RULES[task.type as TaskTypeId]?.minutes ?? 40;
      }
      candidates[index] = bindTask(entry, task);
    }
  }
  // A refusal with an alternative is a real action, not a message.
  const conflictNote = view.notes.find(note => note.lesson === 'conflict');
  if (conflictNote) {
    notesUsed.push(conflictNote.noteId);
    candidates.push(candidate('council-counter', '在晨会上提出替代分工',
      { note: conflictNote.noteId }, ['council open'], {}));
    rules.push('agency.counter-with-note');
  }
  if (view.notes.some(note => note.lesson === 'delay-should-be-reported')
    && belief.level === 0) {
    notesUsed.push(view.notes.find(note => note.lesson === 'delay-should-be-reported')!.noteId);
    candidates.push(candidate('report-delay', '说明延误并给出新时点', {},
      ['alive'], {}));
    rules.push('agency.report-delay');
  }

  candidates.push(candidate('wait', '原地等待', {}, ['alive'], {}));
  rules.push('baseline.wait');

  // Deterministic de-duplication by content, then stable truncation to the
  // contract's 8-candidate ceiling (the dropped ones are reported in rules).
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const entry of candidates) {
    const key = canonicalJson({ kind: entry.kind, parameters: entry.parameters });
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  // The candidate layer reads the SAME place table as the authority: an action
  // that could not execute here is replaced by the real walk to its site. This
  // keeps every offered option executable (a precondition may still fail later,
  // which is a legitimate observation), and it removes the impossible-option
  // noise that used to dominate the rejection ledger.
  const gated: Candidate[] = [];
  let needsWalk: string | null = null;
  for (const entry of unique) {
    const site = requiredPlaceOf(String(entry.parameters.action ?? ''),
      entry.parameters as Record<string, unknown>);
    if (site && view.npc.location !== site) {
      needsWalk = needsWalk ?? site;
      rules.push(`action.place-blocked:${String(entry.parameters.action)}@${site}`);
      continue;
    }
    gated.push(entry);
  }
  if (needsWalk && !gated.some(entry => entry.parameters.action === 'move'
    && entry.parameters.to === needsWalk)) {
    gated.push(candidate('move', `前往${needsWalk}`, { to: needsWalk, purpose: 'task-place' },
      ['alive'], { travelMinutes: 15 }));
    rules.push('action.walk-to-site');
  }
  unique.length = 0;
  unique.push(...gated);
  if (unique.length > MAX_OPTIONS) {
    // An option that discharges an accepted task outranks a generic need when
    // the ceiling forces a cut; the drop is reported, never silent.
    const obligated = (entry: Candidate): boolean => {
      const binding = taskBindingOfCandidate(entry);
      return binding !== null && view.tasks.some(task => task.status === 'accepted'
        && task.taskId === binding.taskId && task.type === binding.type);
    };
    const ordered = [...unique].sort((left, right) =>
      Number(obligated(right)) - Number(obligated(left)));
    rules.push(`truncated:${unique.length}->${MAX_OPTIONS}`);
    unique.length = 0;
    unique.push(...ordered.slice(0, MAX_OPTIONS));
  }
  return { candidates: unique, rules, notesUsed };
}

/**
 * Memory policies with a real difference (A). `raw` carries every observed
 * record; `unconditioned-experience` carries lessons with no conditions;
 * `conditional-experience` keeps the conditions and drops a note whose
 * condition no longer holds.
 */
export type MemoryPolicyId = 'raw' | 'unconditioned-experience' | 'conditional-experience';

export const MEMORY_POLICIES: readonly MemoryPolicyId[] =
  ['raw', 'unconditioned-experience', 'conditional-experience'];

export function applicableNotes(notes: readonly ExperienceNote[], policy: MemoryPolicyId,
  context: Record<string, string | number>): ExperienceNote[] {
  if (policy === 'raw') return [];
  if (policy === 'unconditioned-experience') {
    return notes.map(note => ({ ...note, conditions: {} }));
  }
  return notes.filter(note => Object.entries(note.conditions)
    .every(([key, value]) => context[key] === value));
}

export function noteFrom(sourceEventIds: string[], conditions: Record<string, string | number>,
  lesson: string): ExperienceNote {
  return {
    noteId: `note-${sha256Hex(canonicalJson({ sourceEventIds, conditions, lesson })).slice(0, 12)}`,
    sourceEventIds: [...sourceEventIds].sort(),
    conditions,
    lesson,
    version: 1,
  };
}
