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
import { buildActionOptions, taskBindingOfCandidate, type MemoryPolicyId, type ExperienceNote } from '../agency/options';
import { renderRequest } from '../jev/render';
import { TASK_CATALOG, receiptTypesFor } from '../domains/tasks/index';
import type { R8Runtime } from './runtime';

export interface StepOptions {
  /** Queue captures these at enqueue time; cancelled queued work cannot restart. */
  actorIds?: string[];
  expectedGenerations?: Record<string, number>;
  memoryPolicy?: MemoryPolicyId;
  mode?: 'reference' | 'jev-experimental' | 'jev-admitted';
  /** Conditional notes per actor; empty by default. */
  notes?: (actorId: string) => ExperienceNote[];
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
 * The actor's own visible memory, bounded. `memoryFacts` used to be empty, which
 * meant the model never saw a single promise or relationship; it now carries the
 * actor's own records only.
 */
export function visibleMemory(runtime: R8Runtime, actorId: string, topK = 12):
  { facts: ObservedFact[]; relationships: unknown; truncated: boolean } {
  const store = runtime.session.memories.get(actorId);
  if (!store) return { facts: [], relationships: {}, truncated: false };
  const records = store.toJSON().records.filter(record => record.observerId === actorId);
  const facts: ObservedFact[] = records.slice(-topK).map(record => ({
    eventId: record.sourceEventIds[0] ?? record.recordId,
    observerId: actorId,
    simTime: Number((record.payload as Record<string, unknown> | undefined)?.simTime
      ?? runtime.world.simTime),
    subjectIds: [actorId],
    kind: record.kind,
    payload: record.payload,
    source: 'engine',
  }));
  const knowledge = runtime.session.knowledge();
  const relationships = knowledge[actorId] ?? { promises: [], relation: null };
  return { facts, relationships, truncated: records.length > facts.length };
}

/** Execute one selected candidate; returns what really landed. */
export function executeCandidate(runtime: R8Runtime, actorId: string,
  candidate: Candidate, commandId: string):
  { status: string; reason: string; eventIds: string[] } {
  const action = candidate.parameters.action;
  if (action === 'build-machine') {
    const machine = String(candidate.parameters.machine);
    const result = runtime.dispatch('production', 'build-machine', actorId,
      { machine, workerId: actorId });
    return { status: result.applied.length > 0 ? 'applied' : 'rejected',
      reason: result.rejected.map(entry => `${entry.code}:${entry.reason}`).join('; ')
        || 'intents applied',
      eventIds: result.events.map(event => event.eventId) };
  }
  if (action === 'council-counter' || action === 'report-delay') {
    runtime.session.ingestTeamEvent(String(action),
      { actorId, note: String(candidate.parameters.note ?? '') }, runtime.world.simTime);
    return { status: 'applied', reason: 'communication recorded', eventIds: [] };
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
    const tasks = (runtime.states.tasks as { tasks: { taskId: string; type: string;
      status: string; assigneeId: string }[] }).tasks
      .filter(task => task.assigneeId === actorId);
    const built = buildActionOptions({
      actorId,
      npc: { id: npc.id, location: npc.location, hunger: npc.hunger,
        stamina: npc.stamina, health: npc.health, san: npc.san,
        bodyTemp: npc.bodyTemp, alive: npc.alive },
      resources: snapshot.resources,
      furnace: snapshot.furnace,
      weather: snapshot.weather,
      machines: snapshot.machines,
      tasks: tasks.map(task => ({ taskId: task.taskId, type: task.type,
        status: task.status })),
      stockBelief: beliefOf(runtime, actorId),
      notes: options.notes?.(actorId) ?? [],
    });
    const bridgeView = options.goalBridge?.view(actorId) ?? { goals: [], candidates: [] };
    if (bridgeView.candidates.length > 0) {
      const unique = [...new Map([...bridgeView.candidates, ...built.candidates]
        .map(candidate => [candidate.id, candidate])).values()];
      if (unique.length > 8) built.rules.push(`bridge.truncated:${unique.length}->8`);
      built.candidates = unique.slice(0, 8);
    }
    if (built.candidates.length === 0) continue;
    const memory = visibleMemory(runtime, actorId);
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
      && memoryHash(visibleMemory(runtime, actorId)) === startedMemory
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
        eventIds: [], taskCompleted: null, worldVersion: runtime.world.version,
      });
      continue;
    }
    const selected = request.candidates.find(entry => entry.id === result.selectedId);
    const outcome = selected && result.disposition === 'accept'
      ? executeCandidate(runtime, actorId, selected,
        `${actorId}-r8-${runtime.world.version}`)
      : { status: 'abstained', reason: result.reason, eventIds: [] as string[] };
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
      worldVersion: runtime.world.version,
    });
  }
  return { records, executed: records.filter(record => record.executionStatus === 'applied').length,
    mode: scorer.identity.mode };
}

export { TASK_CATALOG };
