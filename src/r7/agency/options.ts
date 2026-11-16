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

export const MAX_OPTIONS = 8;
export const MIN_OPTIONS = 2;

/**
 * Deterministic option construction. Ordering is stable, so the same context
 * always renders the same candidate set (and the same set hash).
 */
/** Task type an action discharges; mirrors the reference/goal binding. */
export function taskTypeOfCandidate(candidate: Candidate): string | null {
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
    candidates.push(candidate('rest', '就地休息', { minutes: 60 },
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
  if (resources.firewood >= 1 && furnace.fuel < 60) {
    candidates.push(candidate('refuel', '给中央炉添柴', { amount: 3 },
      ['firewood >= 1', 'fuel < 60'], { furnaceFuel: 6 }));
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
  for (const task of view.tasks) {
    if (task.status !== 'accepted') continue;
    switch (task.type) {
      case 'COLLECT_FOOD':
        candidates.push(candidate('gather', '执行食物采集任务', { resource: 'food', amount: 2 },
          ['stamina > 15'], { food: 8 }));
        rules.push('task.collect-food');
        break;
      case 'COLLECT_WOOD':
        candidates.push(candidate('gather', '执行伐木任务', { resource: 'firewood', amount: 2 },
          ['stamina > 15'], { firewood: 10 }));
        rules.push('task.collect-wood');
        break;
      case 'MAINTAIN_POWER':
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
        candidates.push(candidate('deposit', '把粮食送进仓库', { amount: 1 },
          ['carrying food'], { warehouse: 1 }));
        candidates.push(candidate('deliver', '把饭送进厨房', { amount: 1 },
          ['carrying meals'], { meals: 1 }));
        rules.push('task.distribute');
        break;
      case 'PREPARE_WARMTH':
        candidates.push(candidate('refuel', '为御寒准备炉火', { amount: 2 },
          ['firewood >= 1'], { furnaceFuel: 4 }));
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
      case 'COLLECT_MATERIAL':
        candidates.push(candidate('work', `按分工执行${task.type}`, { minutes: 40 },
          ['stamina > 10'], { power: 6, stamina: -10 }));
        rules.push('task.work');
        break;
      case 'REST_RECOVER':
        candidates.push(candidate('rest', '按分工休息恢复', { minutes: 60 },
          ['awake'], { stamina: 20 }));
        rules.push('task.rest');
        break;
      default:
        break;
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
  if (unique.length > MAX_OPTIONS) {
    // An option that discharges an accepted task outranks a generic need when
    // the ceiling forces a cut; the drop is reported, never silent.
    const obligated = (entry: Candidate): boolean => view.tasks.some(task =>
      task.status === 'accepted' && taskTypeOfCandidate(entry) === task.type);
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
