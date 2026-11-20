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
  resolveTokenCounter, type MemoryEncoderPort, type MemoryTruncationRecord,
  type TokenCounter } from '../jev/token-budget';
import { projectMemory, type MemoryProjection, type MemorySelection }
  from '../memory/window';
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
  /** Same budget for both memory arms (default 640); 0 or negative means none. */
  memoryTokenBudget?: number;
  /** Records the window may hold (default 12). The count and the units both bind. */
  memoryMaxRecords?: number;
  /**
   * The one counter used for BOTH the memory budget and the encode side.
   * Swapping it changes the budget and the reported envelope number together.
   */
  tokenCounter?: TokenCounter;
  /**
   * The REAL tokenizer of the model that will read this input. Its count is
   * reported next to the estimate (`memoryEncoderTokens`), never instead of it;
   * without it the record says `not-attached` rather than pretending.
   */
  encoder?: MemoryEncoderPort | null;
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
  /** UTF-8 bytes of the memory block, i.e. exactly what the encoder receives. */
  memoryBytes?: number;
  /**
   * BUDGET units, counted by `memoryCounterId` (default `utf8-bytes/3-ceil/1`).
   * This is an ESTIMATE (`memoryUnitKind`), not the model's tokenizer count.
   */
  memoryTokens?: number;
  memoryUnitKind?: 'estimated-token';
  memoryBudget?: number;
  /** Id of the counter that produced `memoryTokens` (budget == encode side). */
  memoryCounterId?: string;
  /** The real tokenizer count, reported only when a real encoder was attached. */
  memoryEncoderId?: string | null;
  memoryEncoderTokens?: number | null;
  memoryEncoderStatus?: 'counted' | 'not-attached';
  /** Identity of the projection rule that produced this window. */
  memoryProjectionId?: string;
  /** Sha/bytes of the exact memory segment; the pre-encode byte check. */
  memoryBlockSha256?: string;
  memorySegmentSha256?: string;
  memorySegmentBytes?: number;
  memoryTruncated?: boolean;
  memoryTruncatedFacts?: MemoryTruncationRecord[];
  /** Records the actor holds and the identity of its newest one (restore proof). */
  memoryCursor?: { records: number; keptRecords: number;
    lastRecordId: string | null; lastObservedAt: number | null };
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
 * count/unit budget but prefers what governs the next action: the current
 * obligation, an authorized change, and a changed condition.
 *
 * Both the type and the priority table live in `src/r7/memory/window.ts`; they
 * are re-exported here because every front-end already imports from this module.
 */
export type { MemorySelection } from '../memory/window';
export { memoryPriority } from '../memory/window';

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
  /** The real tokenizer count, recorded beside the budget's estimate. */
  encoder?: MemoryEncoderPort | null;
  /**
   * Event ids already carried by another prompt channel (an applicable
   * experience note). A record whose evidence is in this set is NOT listed
   * again as a memory entry: one record, one billing slot.
   */
  excludeEventIds?: readonly string[];
}

/**
 * The actor's own visible memory, bounded by COUNT and by an explicit budget.
 *
 * R11: this is a thin wrapper over `projectMemory` — the ONE projection shared
 * by the CLI, the web bridge, the data collector and the four-day runner. The
 * budget is charged on `renderMemoryBlock(facts)` (the exact bytes the renderer
 * puts after `记忆:`), including the first record; a record that does not fit is
 * trimmed and its trim record is returned, never admitted whole.
 */
export function visibleMemory(runtime: R8Runtime, actorId: string, topK = 12,
  selection: MemorySelection = 'obligation-first', budgetTokens = 640,
  options: MemoryWindowOptions = {}): MemoryProjection {
  const store = runtime.session.memories.get(actorId);
  const records = store === undefined ? []
    : store.toJSON().records.filter(record => record.observerId === actorId);
  const knowledge = runtime.session.knowledge();
  return projectMemory({
    actorId, records, topK, selection, budgetUnits: budgetTokens,
    counter: options.counter, encoder: options.encoder ?? null,
    excludeEventIds: options.excludeEventIds,
    relationships: knowledge[actorId] ?? { promises: [], relation: null },
  });
}

/**
 * The projection must be the text the renderer really emits. Checked before the
 * request leaves the step: if these two ever diverge, the budget governs a copy
 * and the model reads something else.
 */
export function assertMemorySegmentMatchesRender(projection: MemoryProjection,
  request: { memoryFacts: readonly ObservedFact[] }): void {
  const rendered = renderMemoryBlock(request.memoryFacts);
  if (rendered !== projection.block || request.memoryFacts.length !== projection.facts.length)
    throw new Error('memory_projection_render_mismatch: the billed block is not the '
      + 'block the renderer emits');
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

/**
 * The memory evidence of one step, in ONE place so the live record, the stale
 * record and the evidence scripts cannot disagree about which number is which.
 */
function memoryEvidence(memory: MemoryProjection, before: MemoryProjection) {
  return {
    memorySelection: memory.selection,
    memoryKept: memory.kept, memoryDropped: memory.dropped,
    memoryBytes: memory.bytes, memoryTokens: memory.units,
    memoryUnitKind: memory.unitKind, memoryBudget: memory.budgetUnits,
    memoryCounterId: memory.unitId,
    memoryEncoderId: memory.encoder.id,
    memoryEncoderTokens: memory.encoder.tokens,
    memoryEncoderStatus: memory.encoder.status,
    memoryProjectionId: memory.projectionId,
    memoryBlockSha256: memory.blockSha256,
    memorySegmentSha256: memory.segmentSha256,
    memorySegmentBytes: memory.segmentBytes,
    memoryTruncated: memory.truncated,
    memoryTruncatedFacts: memory.truncatedFacts,
    memoryCursor: memory.cursor,
    memoryKeptBefore: before.kept, memoryTokensBefore: before.units,
    memoryNoteSuppressed: before.kept - memory.kept,
  } as const;
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
    const memoryMaxRecords = options.memoryMaxRecords ?? 12;
    const counter = resolveTokenCounter(options.tokenCounter);
    const encoder = options.encoder ?? null;
    const noteEventIds = (options.memoryNoteDedupe ?? true)
      ? [...new Set(notes.flatMap(note => note.sourceEventIds))] : [];
    const readMemory = () => noteEventIds.length === 0
      ? visibleMemory(runtime, actorId, memoryMaxRecords, memorySelection, memoryBudget,
        { counter, encoder })
      : visibleMemory(runtime, actorId, memoryMaxRecords, memorySelection, memoryBudget,
        { counter, encoder, excludeEventIds: noteEventIds });
    const memory = readMemory();
    // Before/after counts travel with the record, so the saved slot is visible
    // evidence rather than a claim in a report. With no notes the two reads are
    // the same, so the second read is skipped.
    const memoryBefore = noteEventIds.length === 0 ? memory
      : visibleMemory(runtime, actorId, memoryMaxRecords, memorySelection, memoryBudget,
        { counter, encoder });
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
    // The billed block and the encoded block are the same bytes, checked here
    // rather than asserted in a report. A projection that exceeds its own budget
    // must never reach the scorer.
    assertMemorySegmentMatchesRender(memory, request);
    if (memory.units > memory.budgetUnits)
      throw new Error(`memory_budget_exceeded: ${memory.units} > ${memory.budgetUnits}`);
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
        ...memoryEvidence(memory, memoryBefore), memoryNotes,
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
      ...memoryEvidence(memory, memoryBefore), memoryNotes,
      worldVersion: runtime.world.version,
    });
  }
  return { records, executed: records.filter(record => record.executionStatus === 'applied').length,
    mode: scorer.identity.mode };
}

export { TASK_CATALOG };
