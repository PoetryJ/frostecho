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
import type { ScorePort } from '../contracts';
import { buildActionOptions, type MemoryPolicyId, type ExperienceNote } from '../agency/options';
import { renderRequest } from '../jev/render';
import { TASK_CATALOG, type TaskTypeId } from '../domains/tasks/index';
import type { R8Runtime } from './runtime';

export interface StepOptions {
  memoryPolicy?: MemoryPolicyId;
  mode?: 'reference' | 'jev-experimental' | 'jev-admitted';
  /** Conditional notes per actor; empty by default. */
  notes?: (actorId: string) => ExperienceNote[];
}

export interface StepRecord {
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
    'stock_deposited']);
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

function taskTypeOf(candidate: Candidate): TaskTypeId | null {
  const action = candidate.parameters.action;
  if (action === 'gather') {
    return candidate.parameters.resource === 'food' ? 'COLLECT_FOOD' : 'COLLECT_WOOD';
  }
  if (action === 'work') return 'MAINTAIN_POWER';
  if (action === 'rest') return 'REST_RECOVER';
  if (action === 'medical') return 'PREPARE_MEDICAL';
  if (action === 'refuel') return 'PREPARE_WARMTH';
  if (action === 'deposit' || action === 'deliver') return 'DISTRIBUTE_FOOD';
  if (action === 'build-machine') {
    const machine = String(candidate.parameters.machine);
    return machine === 'generator' ? 'BUILD_GENERATOR'
      : machine === 'lumberMill' ? 'BUILD_LUMBER_MILL' : 'BUILD_FOOD_COLLECTOR';
  }
  return null;
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
  const type = taskTypeOf(candidate);
  if (!type || eventIds.length === 0) return null;
  const tasks = (runtime.states.tasks as { tasks: { taskId: string; type: string;
    status: string; assigneeId: string }[] }).tasks;
  const task = tasks.find(entry => entry.assigneeId === actorId
    && entry.status === 'accepted' && entry.type === type);
  if (!task) return null;
  const result = runtime.dispatch('tasks', 'complete', actorId,
    { taskId: task.taskId, receiptEventId: eventIds[eventIds.length - 1] });
  return result.applied.length > 0 ? task.taskId : null;
}

export async function runStep(runtime: R8Runtime, scorer: ScorePort,
  options: StepOptions = {}): Promise<StepResult> {
  const memoryPolicy = options.memoryPolicy ?? 'conditional-experience';
  const records: StepRecord[] = [];
  const snapshot = runtime.snapshot();
  for (const actorId of runtime.context().actorIds) {
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
    if (built.candidates.length === 0) continue;
    const memory = visibleMemory(runtime, actorId);
    const request = makeChoiceRequest({
      requestId: `${runtime.world.version}-${actorId}`,
      task: 'choose_action',
      actorId,
      stateVersion: runtime.world.version,
      observation: { day: snapshot.day, minuteOfDay: snapshot.minuteOfDay,
        weather: snapshot.weather, resources: snapshot.resources,
        furnace: snapshot.furnace, self: npc, belief: beliefOf(runtime, actorId) },
      question: '现在最该做什么？',
      memoryFacts: memory.facts,
      relationships: memory.relationships,
      goals: tasks.map(task => ({ taskId: task.taskId, type: task.type,
        memoryTruncated: memory.truncated })),
      candidates: built.candidates,
      memoryPolicyVersion: memoryPolicy,
    });
    const rendered = renderRequest(request);
    const startedVersion = runtime.world.version;
    const startedGeneration = runtime.session.generationFor(actorId);
    const started = Date.now();
    const result = await scorer.score(request);
    const latencyMs = Date.now() - started;
    // The score arrived after an await. Re-check synchronously, before any
    // commit: a cancel/timeout or a newer world version voids this result.
    const fresh = runtime.world.version === startedVersion
      && runtime.session.generationFor(actorId) === startedGeneration;
    if (!fresh) {
      records.push({
        actorId, requestId: request.requestId,
        candidateSetHash: request.candidateSetHash,
        renderSha256: `${rendered.text.length}`,
        observationText: rendered.text, jointText: rendered.text,
        candidates: [], rules: built.rules, selectedId: null,
        disposition: 'stale', scorerId: result.scorerId, latencyMs,
        executionStatus: 'stale', reason: 'generation_or_version_changed',
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
    records.push({
      actorId, requestId: request.requestId,
      candidateSetHash: request.candidateSetHash,
      renderSha256: `${rendered.text.length}`,
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
      worldVersion: runtime.world.version,
    });
  }
  return { records, executed: records.filter(record => record.executionStatus === 'applied').length,
    mode: scorer.identity.mode };
}

export { TASK_CATALOG };
