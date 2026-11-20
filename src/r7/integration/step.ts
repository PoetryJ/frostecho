/**
 * The one decision step shared by the web entry, stdin and the four-day
 * evaluation: candidates -> ChoiceRequest -> scorer -> authoritative commit ->
 * receipt-backed task completion.
 *
 * Nothing here writes the world directly. A world action goes through
 * `PlaySession.executeCandidate`; a domain action goes through
 * `R8Runtime.dispatch`; both land in the same versioned authority.
 */
import { makeChoiceRequest, type Candidate, type ChoiceRequest,
  type ObservedFact } from '../../decision/contracts';
import { createHash } from 'node:crypto';
import type { ScorePort } from '../contracts';
import { applicableNotes, buildActionOptions, taskBindingOfCandidate,
  type MemoryPolicyId, type ExperienceNote } from '../agency/options';
import { renderRequest } from '../jev/render';
import { byteTokenCounter, renderMemoryBlock, renderMemoryLine,
  resolveTokenCounter, type TokenCounter } from '../jev/token-budget';
import { TASK_CATALOG, receiptTypesFor, requiredPlaceOf } from '../domains/tasks/index';
import { placeSatisfied, sitesFromFacts } from '../../spatial-v2/site';
import type { R8Runtime } from './runtime';

export interface StepOptions {
  /** Queue captures these at enqueue time; cancelled queued work cannot restart. */
  actorIds?: string[];
  expectedGenerations?: Record<string, number>;
  memoryPolicy?: MemoryPolicyId;
  /**
   * How the bounded memory of the actor is filled. Both arms keep the same
   * count/token budget; `raw-last12` is the frozen control.
   */
  memorySelection?: MemorySelection;
  mode?: 'reference' | 'jev-experimental' | 'jev-admitted';
  /** Conditional notes per actor; empty by default. */
  notes?: (actorId: string) => ExperienceNote[];
  /** Same token budget for both memory arms (default 640). */
  memoryTokenBudget?: number;
  /**
   * The one counter used for BOTH the memory budget and the encode side.
   * Swapping it changes the budget and the reported envelope number together.
   */
  tokenCounter?: TokenCounter;
  /**
   * One record, one billing slot: a record an applicable note already carries is
   * not listed again as a memory entry. Default on. Turning it off reproduces
   * the pre-R10 double booking deliberately, so the before/after numbers in the
   * evidence are measured rather than asserted.
   */
  memoryNoteDedupe?: boolean;
  /** Projection over an existing task/commitment ledger, never a second queue. */
  goalBridge?: {
    view(actorId: string): { goals: unknown[]; candidates: Candidate[] };
    afterCommit(actorId: string, candidate: Candidate, eventIds: string[]): void;
  };
}

export interface StepRecord {
  inputSha256?: string;
  actorId: string;
  requestId: string;
  candidateSetHash: string;
  renderSha256: string;
  observationText: string;
  jointText: string;
  candidates: { id: string; kind: string; description: string;
    parameters: Record<string, unknown>; preconditions: string[]; text: string }[];
  rules: string[];
  selectedId: string | null;
  disposition: string;
  scorerId: string;
  latencyMs: number;
  executionStatus: string;
  reason: string;
  eventIds: string[];
  taskCompleted: string | null;
  taskCompletionEvidence?: 'task-primitive' | 'work-proxy' | null;
  /** Which bounded-memory arm filled this input, and how big it really was. */
  memorySelection?: MemorySelection;
  memoryKept?: number;
  memoryDropped?: number;
  memoryBytes?: number;
  memoryTokens?: number;
  memoryBudget?: number;
  /** Id of the counter that produced `memoryTokens` (budget == encode side). */
  memoryCounterId?: string;
  /** Counts before the one-record-one-slot rule was applied. */
  memoryKeptBefore?: number;
  memoryTokensBefore?: number;
  /** Records not listed twice because an applicable note already carries them. */
  memoryNoteSuppressed?: number;
  /** The notes that owned those records, with their provenance. */
  memoryNotes?: { noteId: string; lesson: string; conditions: Record<string, string | number>;
    sourceEventIds: string[]; observedAt: number | null }[];
  worldVersion: number;
}

export interface StepResult {
  records: StepRecord[];
  executed: number;
  mode: string;
}

function beliefOf(runtime: R8Runtime, actorId: string): { level: number | null; rumor: boolean } {
  const store = runtime.session.memories.get(actorId);
  if (!store) return { level: null, rumor: false };
  const records = store.toJSON().records.filter(record => record.observerId === actorId);
  const stockKinds = new Set(['stock_withdrawn', 'out_of_stock', 'stock_restocked',
    'stock_deposited', 'warehouse_stock_observed']);
  let level: number | null = null;
  let rumor = false;
  let sawDirect = false;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind === 'restock_rumor') { if (!sawDirect) rumor = true; continue; }
    if (!stockKinds.has(record.kind)) continue;
    sawDirect = true;
    if (level === null) {
      const payload = record.payload as Record<string, unknown>;
      if (typeof payload.remaining === 'number') level = payload.remaining;
      else if (typeof payload.total === 'number') level = payload.total;
      else if (record.kind === 'out_of_stock') level = 0;
    }
  }
  return { level, rumor };
}

/**
 * Conditional notes this actor actually holds, from its own records. A note
 * carries its conditions, so a changed condition wakes only the learner.
 */
/**
 * What the actor currently believes about the warehouse: `restocked` only if it
 * personally saw a restock newer than the shortage it remembers.
 */
export function latestStockCondition(runtime: R8Runtime, actorId: string):
  'shortage' | 'restocked' | 'unknown' {
  const store = runtime.session.memories.get(actorId);
  if (!store) return 'unknown';
  const records = store.toJSON().records.filter(record => record.observerId === actorId);
  // Order in the actor's own store is the honest observation clock: two events
  // can share a simTime, so index order decides which came later.
  let shortageIndex = -1;
  let restockIndex = -1;
  records.forEach((record, index) => {
    if (record.kind === 'out_of_stock') shortageIndex = index;
    if (record.kind === 'stock_restocked' || record.kind === 'stock_deposited') {
      restockIndex = index;
    }
  });
  if (restockIndex >= 0 && restockIndex > shortageIndex) return 'restocked';
  if (shortageIndex >= 0) return 'shortage';
  return 'unknown';
}

export function notesFor(runtime: R8Runtime, actorId: string): ExperienceNote[] {
  const store = runtime.session.memories.get(actorId);
  if (!store) return [];
  const records = store.toJSON().records.filter(record => record.observerId === actorId);
  const notes: ExperienceNote[] = [];
  const shortage = [...records].reverse().find(record => record.kind === 'out_of_stock');
  if (shortage) {
    notes.push({ noteId: `note-shortage-${actorId}`,
      sourceEventIds: [...shortage.sourceEventIds],
      conditions: { place: 'warehouse', stock: 'shortage' },
      lesson: 'delay-should-be-reported', version: 1 });
  }
  const restock = [...records].reverse().find(record => record.kind === 'stock_restocked');
  if (restock && shortage && restock.observedAt > shortage.observedAt) {
    notes.push({ noteId: `note-restock-${actorId}`,
      sourceEventIds: [...restock.sourceEventIds],
      conditions: { place: 'warehouse', stock: 'restocked' },
      lesson: 'shortage-condition-lifted', version: 1 });
  }
  const refusal = [...records].reverse().find(record => record.kind === 'task_declined');
  if (refusal) {
    notes.push({ noteId: `note-refusal-${actorId}`,
      sourceEventIds: [...refusal.sourceEventIds], conditions: { taskState: 'declined' },
      lesson: 'conflict', version: 1 });
  }
  return notes;
}

/**
 * How the bounded memory window is filled. `raw-last12` is the frozen control
 * (newest twelve records, whatever they are); `obligation-first` keeps the same
 * count/token budget but prefers what governs the next action: the current
 * obligation, an authorized change, and a changed condition.
 */
export type MemorySelection = 'raw-last12' | 'obligation-first';

const MEMORY_PRIORITY: Record<string, number> = {
  task_proposed: 100, task_accepted: 100, task_reassigned: 100, task_countered: 100,
  commitment_proposed: 100, commitment_accepted: 100, commitment_change_proposed: 100,
  commitment_change_accepted: 90, commitment_change_rejected: 90, commitment_resumed: 90,
  out_of_stock: 80, stock_restocked: 80, stock_deposited: 80, stock_withdrawn: 80,
  warehouse_stock_observed: 80, restock_rumor: 80, commitment_cancelled: 80,
  commitment_withdrawn: 80, commitment_fulfilled: 80, commitment_declined: 80,
  promise_kept: 70, promise_broken: 70, task_vacated: 70, commitment_action_committed: 70,
};

/** Priority of one record for the next decision; ties break on recency. */
export function memoryPriority(kind: string): number {
  return MEMORY_PRIORITY[kind] ?? 10;
}

/**
 * The actor's own visible memory, bounded. `memoryFacts` used to be empty, which
 * meant the model never saw a single promise or relationship; it now carries the
 * actor's own records only. Selection is explicit so the raw window stays a
 * real control arm rather than being silently replaced.
 */

/**
 * Cost of ONE memory line. Exported for evidence only: a line is not a billing
 * unit, because `ceil` per line is not additive. The budget is charged on the
 * block, exactly as the renderer joins it.
 */
export function memoryFactTokens(fact: ObservedFact,
  counter: TokenCounter = byteTokenCounter): number {
  return resolveTokenCounter(counter).count(renderMemoryLine(fact));
}

/** How the bounded window handles a record that another channel already owns. */
export interface MemoryWindowOptions {
  /** Counter used for the budget; the encode side gets the same object. */
  counter?: TokenCounter;
  /**
   * Event ids already carried by another prompt channel (an applicable
   * experience note). A record whose evidence is in this set is NOT listed
   * again as a memory entry: one record, one billing slot.
   */
  excludeEventIds?: readonly string[];
}

/**
 * The actor's own visible memory, bounded by COUNT and by an explicit token
 * budget. Both arms get the same budget; only the selection rule differs, so a
 * difference between them comes from what the actor was allowed to know, not
 * from one arm being fed more text.
 *
 * The budget is charged on `renderMemoryBlock(facts)` — the exact bytes the
 * renderer puts after the `记忆:` header — through the passed-in counter, so
 * the number recorded here is the number the encoder measures.
 */
export function visibleMemory(runtime: R8Runtime, actorId: string, topK = 12,
  selection: MemorySelection = 'obligation-first', budgetTokens = 640,
  options: MemoryWindowOptions = {}):
  { facts: ObservedFact[]; relationships: unknown; truncated: boolean;
    selection: MemorySelection; kept: number; dropped: number; bytes: number;
    tokens: number; budgetTokens: number; counterId: string; suppressed: number } {
  const counter = resolveTokenCounter(options.counter);
  const store = runtime.session.memories.get(actorId);
  if (!store) return { facts: [], relationships: {}, truncated: false,
    selection, kept: 0, dropped: 0, bytes: 0, tokens: 0, budgetTokens,
    counterId: counter.id, suppressed: 0 };
  const all = store.toJSON().records.filter(record => record.observerId === actorId);
  // One record, one slot: a record whose evidence an applicable note already
  // carries is not listed (and not billed) a second time as a memory entry.
  const occupied = new Set(options.excludeEventIds ?? []);
  const records = occupied.size === 0 ? all
    : all.filter(record => !record.sourceEventIds.some(id => occupied.has(id)));
  const suppressed = all.length - records.length;
  // Same count AND same token budget for both arms; only the choice differs.
  const candidates = selection === 'raw-last12'
    ? records.slice(-topK).map((record, index) => ({ record,
      index: Math.max(0, records.length - topK) + index })).reverse()
    : records.map((record, index) => ({ record, index }))
      .sort((left, right) => memoryPriority(right.record.kind) - memoryPriority(left.record.kind)
        || right.index - left.index
        || left.record.recordId.localeCompare(right.record.recordId));
  const chosen: { record: typeof records[number]; index: number }[] = [];
  for (const entry of candidates) {
    if (chosen.length >= topK) break;
    const fact = factOf(actorId, entry.record);
    // Charge the block as it will be rendered, not a per-line sum: `ceil` per
    // line over-bills and a different ORDER never changes byte length.
    const trial = [...chosen.map(row => factOf(actorId, row.record)), fact];
    if (chosen.length > 0 && counter.count(renderMemoryBlock(trial)) > budgetTokens) continue;
    chosen.push(entry);
  }
  chosen.sort((left, right) => left.index - right.index);
  const facts: ObservedFact[] = chosen.map(({ record }) => factOf(actorId, record));
  const knowledge = runtime.session.knowledge();
  const relationships = knowledge[actorId] ?? { promises: [], relation: null };
  return { facts, relationships, truncated: records.length > facts.length,
    selection, kept: facts.length, dropped: Math.max(0, records.length - facts.length),
    bytes: Buffer.byteLength(JSON.stringify(facts), 'utf8'),
    tokens: counter.count(renderMemoryBlock(facts)), budgetTokens,
    counterId: counter.id, suppressed };
}

/** One stored record as the actor may see it, with its provenance intact. */
function factOf(actorId: string, record: {
  recordId: string; kind: string; observedAt: number; occurredAt: number;
  authority: string; speakerId?: string | null; source: string;
  sourceEventIds: string[]; subjectIds: string[]; payload: unknown }): ObservedFact {
  return {
    eventId: record.sourceEventIds[0] ?? record.recordId,
    observerId: actorId,
    // When THIS actor learned it, not when the event happened.
    simTime: record.observedAt,
    subjectIds: record.subjectIds.length > 0 ? [...record.subjectIds] : [actorId],
    kind: record.kind,
    payload: {
      ...((record.payload as Record<string, unknown> | undefined) ?? {}),
      occurredAt: record.occurredAt,
      authority: record.authority,
      speakerId: record.speakerId ?? null,
      sourceEventIds: [...record.sourceEventIds],
    },
    // Provenance is carried, never forced: a player statement stays a player
    // statement and an inference stays an inference.
    source: record.source === 'player_statement' ? 'player_statement'
      : record.source === 'inference' ? 'inference' : 'engine',
  };
}

/**
 * How long an action really occupies its actor. Nothing is applied before that
 * time has passed on the authoritative clock; the three front-ends share it.
 * The table itself lives in `execution/place-rules` so the authority reads the
 * same numbers as the proposal layer.
 */
import { durationOf, isWorkGrant, requiresWorkIntent, type WorkGrant }
  from '../../execution/place-rules';

export { ACTION_MINUTES, durationOf, requiredPlaceOf } from '../../execution/place-rules';

/** The one place gate: `work` resolves by its mode, never by a caller label. */
function requiredPlace(candidate: Candidate): string | null {
  return requiredPlaceOf(String(candidate.parameters.action ?? ''),
    candidate.parameters as Record<string, unknown>);
}

/**
 * Execute one selected candidate; returns what really landed.
 *
 * This is the R8 execution helper. A time-consuming action is refused here
 * unless the settled intent minted the grant, so no new-profile entry can run
 * work inline; the legacy low-level `PlaySession` command path is unchanged.
 */
export function executeCandidate(runtime: R8Runtime, actorId: string,
  candidate: Candidate, commandId: string, grant?: WorkGrant):
  { status: string; reason: string; eventIds: string[] } {
  const action = candidate.parameters.action;
  const place = requiredPlace(candidate);
  if (place) {
    const here = runtime.world.npcs[actorId]?.location;
    // R11-D: the same door-or-inside rule the authority uses, so the proposal
    // layer and the executor cannot disagree about the site.
    const sites = sitesFromFacts(runtime.world.r8?.facts as Record<string, number> | undefined,
      actorId, String(here));
    if (!placeSatisfied(place, String(here), sites)) {
      return { status: 'rejected',
        reason: `wrong_location: ${action}${candidate.parameters.mode
          ? `(${String(candidate.parameters.mode)})` : ''} needs ${place}, actor is at ${String(here)}`,
        eventIds: [] };
    }
  }
  if (action === 'build-machine') {
    const machine = String(candidate.parameters.machine);
    const result = runtime.dispatch('production', 'build-machine', actorId,
      { machine, workerId: actorId });
    return { status: result.applied.length > 0 ? 'applied' : 'rejected',
      reason: result.rejected.map(entry => `${entry.code}:${entry.reason}`).join('; ')
        || 'intents applied',
      eventIds: result.events.map(event => event.eventId) };
  }
  // R11-D: 机器停机 → 补给恢复. The restart is the production domain's own
  // command, so the machine state and the receipt stay authoritative.
  if (action === 'start-machine') {
    const machine = String(candidate.parameters.machine);
    const result = runtime.dispatch('production', 'start-machine', actorId, { machine });
    return { status: result.applied.length > 0 ? 'applied' : 'rejected',
      reason: result.rejected.map(entry => `${entry.code}:${entry.reason}`).join('; ')
        || 'machine restarted',
      eventIds: result.events.map(event => event.eventId) };
  }
  if (action === 'council-counter' || action === 'report-delay') {
    runtime.session.ingestTeamEvent(String(action),
      { actorId, note: String(candidate.parameters.note ?? '') }, runtime.world.simTime);
    return { status: 'applied', reason: 'communication recorded', eventIds: [] };
  }
  if (requiresWorkIntent(candidate) && !(isWorkGrant(grant) && grant.actorId === actorId)) {
    return { status: 'rejected', eventIds: [],
      reason: `work_requires_intent: ${String(action)} spends authoritative time; `
        + 'queue it and settle on the clock' };
  }
  const outcome = runtime.session.executeCandidate(actorId, candidate, commandId);
  if (outcome.events) runtime.recordCommitted(outcome.events);
  return { status: outcome.status, reason: outcome.reason ?? '', eventIds: outcome.eventIds };
}

/** A task closes only on a committed receipt of the right type. */
export function closeTaskOnReceipt(runtime: R8Runtime, actorId: string,
  candidate: Candidate, eventIds: string[]): string | null {
  const binding = taskBindingOfCandidate(candidate);
  if (!binding || eventIds.length === 0) return null;
  const tasks = (runtime.states.tasks as { tasks: { taskId: string; type: string;
    status: string; assigneeId: string }[] }).tasks;
  const task = tasks.find(entry => entry.taskId === binding.taskId && entry.assigneeId === actorId
    && entry.status === 'accepted' && entry.type === binding.type);
  if (!task) return null;
  const receiptId = [...eventIds].reverse().find(id => {
    const receipt = runtime.committedEvent(id);
    return receipt?.actorId === actorId && receiptTypesFor(binding.type).includes(receipt.type);
  });
  if (!receiptId) return null;
  const result = runtime.dispatch('tasks', 'complete', actorId,
    { taskId: task.taskId, receiptEventId: receiptId });
  const after = runtime.states.tasks.tasks.find(entry => entry.taskId === task.taskId);
  // Completing a task can emit only a domain event, with no world intents.
  return result.rejected.length === 0 && after?.status === 'done'
    && result.events.some(event => event.type === 'task_completed'
      && event.payload.taskId === task.taskId && event.payload.receipt === receiptId)
    ? task.taskId : null;
}

export async function runStep(runtime: R8Runtime, scorer: ScorePort,
  options: StepOptions = {}): Promise<StepResult> {
  const memoryPolicy = options.memoryPolicy ?? 'conditional-experience';
  const records: StepRecord[] = [];
  const available = runtime.context().actorIds;
  const actors = options.actorIds ?? available;
  if (new Set(actors).size !== actors.length || actors.some(id => !available.includes(id)))
    throw new Error('invalid step actorIds');
  for (const actorId of actors) {
    const expected = options.expectedGenerations?.[actorId];
    if (expected !== undefined && runtime.session.generationFor(actorId) !== expected) {
      records.push({ actorId, requestId: `${runtime.world.version}-${actorId}`,
        candidateSetHash: '', renderSha256: '', observationText: '', jointText: '',
        candidates: [], rules: [], selectedId: null, disposition: 'stale',
        scorerId: scorer.identity.scorerId, latencyMs: 0, executionStatus: 'stale',
        reason: 'generation_changed_before_start', eventIds: [], taskCompleted: null,
        worldVersion: runtime.world.version });
      continue;
    }
    // Earlier actors may have committed: build this actor's input from that state.
    const snapshot = runtime.snapshot();
    const npc = snapshot.npcs[actorId];
    if (!npc?.alive) continue;
    const busyUntil = runtime.busyUntil(actorId);
    if (busyUntil !== null) {
      records.push({
        actorId, requestId: `${runtime.world.version}-${actorId}-busy`,
        candidateSetHash: '', renderSha256: '', observationText: '', jointText: '',
        candidates: [], rules: ['occupancy.busy'], selectedId: null,
        disposition: 'busy', scorerId: 'none', latencyMs: 0,
        executionStatus: 'busy', reason: `busy until ${busyUntil}`,
        eventIds: [], taskCompleted: null, worldVersion: runtime.world.version,
      });
      continue;
    }
    const tasks = (runtime.states.tasks as { tasks: { taskId: string; type: string;
      status: string; assigneeId: string }[] }).tasks
      .filter(task => task.assigneeId === actorId);
    // Notes are resolved once: they drive the candidate block AND they own the
    // records they were distilled from, so the same evidence is never billed
    // twice (once as a note, once as a memory entry).
    const notes = applicableNotes(options.notes?.(actorId) ?? notesFor(runtime, actorId),
      memoryPolicy, {
        place: 'warehouse',
        taskState: 'declined',
        // The condition the actor can see right now: a witnessed restock
        // lifts the shortage lesson; otherwise it still applies.
        stock: latestStockCondition(runtime, actorId),
      });
    const built = buildActionOptions({
      actorId,
      npc: { id: npc.id, location: npc.location, hunger: npc.hunger,
        stamina: npc.stamina, health: npc.health, san: npc.san,
        bodyTemp: npc.bodyTemp, alive: npc.alive },
      // Door-or-inside, from the committed original position (R11-D).
      sites: sitesFromFacts(runtime.world.r8?.facts as Record<string, number> | undefined,
        actorId, npc.location),
      // `weather-system.js:29-40`: the two-hour outdoor limit is a rule of the
      // BOARD too, not only of the survival domain (D-R10 known gap).
      outdoorMinutes: (runtime.states.survival as { outdoorMinutes: Record<string, number> })
        .outdoorMinutes[actorId] ?? 0,
      resources: snapshot.resources,
      furnace: snapshot.furnace,
      weather: snapshot.weather,
      machines: snapshot.machines,
      tasks: tasks.map(task => ({ taskId: task.taskId, type: task.type,
        status: task.status })),
      stockBelief: beliefOf(runtime, actorId),
      notes,
    });
    const bridgeView = options.goalBridge?.view(actorId) ?? { goals: [], candidates: [] };
    if (bridgeView.candidates.length > 0) {
      const unique = [...new Map([...bridgeView.candidates, ...built.candidates]
        .map(candidate => [candidate.id, candidate])).values()];
      if (unique.length > 8) built.rules.push(`bridge.truncated:${unique.length}->8`);
      built.candidates = unique.slice(0, 8);
    }
    if (built.candidates.length === 0) continue;
    const memorySelection = options.memorySelection ?? 'obligation-first';
    const memoryBudget = options.memoryTokenBudget ?? 640;
    const counter = resolveTokenCounter(options.tokenCounter);
    const noteEventIds = (options.memoryNoteDedupe ?? true)
      ? [...new Set(notes.flatMap(note => note.sourceEventIds))] : [];
    const readMemory = () => noteEventIds.length === 0
      ? visibleMemory(runtime, actorId, 12, memorySelection, memoryBudget, { counter })
      : visibleMemory(runtime, actorId, 12, memorySelection, memoryBudget,
        { counter, excludeEventIds: noteEventIds });
    const memory = readMemory();
    // Before/after counts travel with the record, so the saved slot is visible
    // evidence rather than a claim in a report. With no notes the two reads are
    // the same, so the second read is skipped.
    const memoryBefore = noteEventIds.length === 0 ? memory
      : visibleMemory(runtime, actorId, 12, memorySelection, memoryBudget, { counter });
    // Provenance of the notes that own suppressed records: the lesson survives
    // in the record even though its raw line no longer occupies the window.
    const store = runtime.session.memories.get(actorId);
    const storedRecords = store?.toJSON().records ?? [];
    const memoryNotes = notes.map(note => {
      const owner = storedRecords.find(record => record.sourceEventIds
        .some(id => note.sourceEventIds.includes(id)));
      return { noteId: note.noteId, lesson: note.lesson, conditions: note.conditions,
        sourceEventIds: [...note.sourceEventIds], observedAt: owner?.observedAt ?? null };
    });
    const request = makeChoiceRequest({
      requestId: runtime.session.nextInputId('r8-score', actorId),
      task: 'choose_action',
      actorId,
      stateVersion: runtime.world.version,
      observation: { day: snapshot.day, minuteOfDay: snapshot.minuteOfDay,
        weather: snapshot.weather, resources: snapshot.resources,
        furnace: snapshot.furnace, self: npc, belief: beliefOf(runtime, actorId) },
      question: '现在最该做什么？',
      memoryFacts: memory.facts,
      relationships: memory.relationships,
      goals: [...tasks.filter(task => task.status === 'accepted').map(task => ({ taskId: task.taskId, type: task.type,
        status: 'accepted',
        memoryTruncated: memory.truncated })), ...bridgeView.goals],
      candidates: built.candidates,
      memoryPolicyVersion: memoryPolicy,
    });
    const rendered = renderRequest(request);
    const inputSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const startedVersion = runtime.world.version;
    const startedGeneration = runtime.session.generationFor(actorId);
    const memoryHash = (value: unknown) => createHash('sha256')
      .update(JSON.stringify(value)).digest('hex');
    const startedMemory = memoryHash(memory);
    const startedBridge = memoryHash(bridgeView);
    const started = Date.now();
    const result = await scorer.score(request);
    const latencyMs = Date.now() - started;
    // The score arrived after an await. Re-check synchronously, before any
    // commit: a cancel/timeout or a newer world version voids this result.
    const fresh = runtime.world.version === startedVersion
      && runtime.session.generationFor(actorId) === startedGeneration
      && memoryHash(readMemory()) === startedMemory
      && memoryHash(options.goalBridge?.view(actorId) ?? { goals: [], candidates: [] }) === startedBridge;
    if (!fresh) {
      records.push({
        actorId, requestId: request.requestId, inputSha256,
        candidateSetHash: request.candidateSetHash,
        renderSha256: createHash('sha256').update(rendered.text).digest('hex'),
        observationText: rendered.text, jointText: rendered.text,
        candidates: [], rules: built.rules, selectedId: null,
        disposition: 'stale', scorerId: result.scorerId, latencyMs,
        executionStatus: 'stale', reason: 'generation_version_or_memory_changed',
        eventIds: [], taskCompleted: null,
        memorySelection, memoryKept: memory.kept, memoryDropped: memory.dropped,
        memoryBytes: memory.bytes, memoryTokens: memory.tokens,
        memoryBudget: memory.budgetTokens, memoryCounterId: memory.counterId,
        memoryKeptBefore: memoryBefore.kept, memoryTokensBefore: memoryBefore.tokens,
        memoryNoteSuppressed: memoryBefore.kept - memory.kept, memoryNotes,
        worldVersion: runtime.world.version,
      });
      continue;
    }
    const selected = request.candidates.find(entry => entry.id === result.selectedId);
    let outcome: { status: string; reason: string; eventIds: string[] };
    if (!selected || result.disposition !== 'accept') {
      outcome = { status: 'abstained', reason: result.reason, eventIds: [] };
    } else {
      const minutes = durationOf(selected);
      const commandId = `${actorId}-r8-${runtime.world.version}`;
      if (minutes > 0) {
        // Occupy the actor through ONE persistent intent: it carries the
        // authorisation generation, the place premise and the exact
        // task/commitment instance, so settlement (also in a new process) can
        // re-validate them instead of replaying a captured closure.
        const binding = taskBindingOfCandidate(selected);
        const parameters = selected.parameters as Record<string, unknown>;
        const begun = runtime.beginIntent({
          intentId: commandId, commandId, actorId, candidate: selected, minutes,
          inputSha256,
          taskId: binding?.taskId ?? (typeof parameters.legacyTaskId === 'string'
            ? parameters.legacyTaskId : null),
          taskType: binding?.type ?? null,
          commitmentId: typeof parameters.commitmentId === 'string'
            ? parameters.commitmentId : null,
          commitmentRevision: typeof parameters.commitmentRevision === 'number'
            ? parameters.commitmentRevision : null,
        });
        outcome = 'rejected' in begun
          ? { status: 'rejected', reason: begun.rejected, eventIds: [] }
          : { status: 'working', reason: `until ${begun.intent.dueAt}`, eventIds: [] };
      } else {
        outcome = executeCandidate(runtime, actorId, selected, commandId);
      }
    }
    const taskCompleted = outcome.status === 'applied' && selected
      ? closeTaskOnReceipt(runtime, actorId, selected, outcome.eventIds) : null;
    if (outcome.status === 'applied' && selected)
      options.goalBridge?.afterCommit(actorId, selected, outcome.eventIds);
    records.push({
      actorId, requestId: request.requestId, inputSha256,
      candidateSetHash: request.candidateSetHash,
      renderSha256: createHash('sha256').update(rendered.text).digest('hex'),
      observationText: rendered.text,
      jointText: rendered.text,
      candidates: request.candidates.map(candidate => ({
        id: candidate.id, kind: candidate.kind, description: candidate.description,
        parameters: candidate.parameters, preconditions: candidate.preconditions,
        text: rendered.segments.find(segment => segment.index === request.candidates
          .indexOf(candidate))?.text.slice(3) ?? candidate.description,
      })),
      rules: built.rules, selectedId: result.selectedId,
      disposition: result.disposition, scorerId: result.scorerId, latencyMs,
      executionStatus: outcome.status, reason: outcome.reason,
      eventIds: outcome.eventIds, taskCompleted,
      taskCompletionEvidence: taskCompleted && selected ? taskBindingOfCandidate(selected)?.evidenceClass ?? null : null,
      memorySelection, memoryKept: memory.kept, memoryDropped: memory.dropped,
      memoryBytes: memory.bytes, memoryTokens: memory.tokens,
      memoryBudget: memory.budgetTokens, memoryCounterId: memory.counterId,
      memoryKeptBefore: memoryBefore.kept, memoryTokensBefore: memoryBefore.tokens,
      memoryNoteSuppressed: memoryBefore.kept - memory.kept, memoryNotes,
      worldVersion: runtime.world.version,
    });
  }
  return { records, executed: records.filter(record => record.executionStatus === 'applied').length,
    mode: scorer.identity.mode };
}

export { TASK_CATALOG };
