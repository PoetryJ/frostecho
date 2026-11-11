/**
 * Minimal playable four-day entry (G bridge, reference scorer).
 *
 * This is a mechanics demo: it uses the reference utility scorer, not a
 * research model. Every world change goes through F's command interface, and
 * the memory asymmetry from D is applied before planning.
 *
 * Run: node dist/scripts/play-fixture.js [days] [npcCount]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, type MemoryRecordInput } from '../src/memory/store';
import {
  buildPlanningRequest,
  referenceScorer,
  utilityOf,
  type PlanningView,
  type PromiseRef,
} from '../src/planning/candidates';
import {
  applyCommand,
  createWorldV2,
  runEightNpcDay,
  viewOf,
  type Command,
  type WorldEvent,
  type WorldV2,
} from '../src/survival/world-v2';

const days = Number(process.argv[2] ?? 4);
const npcCount = Number(process.argv[3] ?? 8);
const ids = Array.from({ length: npcCount }, (_, index) => `npc_${String(index + 1).padStart(2, '0')}`);

function memoryFromNames(actorId: string): MemoryStore {
  const store = new MemoryStore();
  const make = (input: MemoryRecordInput) => store.append(input);
  make({ eventId: `promise-${actorId}`, observerId: actorId, occurredAt: 0, observedAt: 0,
    kind: 'promise_made', subjectIds: [actorId, 'player'],
    payload: { promiseId: `p-${actorId}`, fromId: actorId, toId: 'player', text: '给玩家留一份饭' },
    source: 'engine', authority: 'npc' });
  return store;
}

function applyChoice(state: WorldV2, actorId: string, candidateId: string): { state: WorldV2; events: WorldEvent[] } {
  const map: Record<string, Command | null> = {
    'c-eat': { commandId: `${actorId}-eat-${state.version}`, type: 'eat', actorId, amount: 1 },
    'c-refuel': { commandId: `${actorId}-refuel-${state.version}`, type: 'refuel', actorId, amount: 1 },
    'c-rest': { commandId: `${actorId}-rest-${state.version}`, type: 'rest', actorId, minutes: 60 },
    'c-work': { commandId: `${actorId}-work-${state.version}`, type: 'work', actorId, minutes: 60 },
    'c-gather-food': { commandId: `${actorId}-gf-${state.version}`, type: 'gather', actorId, resource: 'food', amount: 2 },
    'c-gather-wood': { commandId: `${actorId}-gw-${state.version}`, type: 'gather', actorId, resource: 'firewood', amount: 2 },
    'c-wait': null,
    'c-medical': null,
  };
  if (candidateId.startsWith('c-help-')) {
    try {
      return applyCommand(state, { commandId: `${actorId}-help-${state.version}`, type: 'reserve',
        actorId, forId: 'player', amount: 1 });
    } catch (error) {
      return { state, events: [{ eventId: `rejected-${state.version}`, type: 'command_rejected',
        simTime: state.simTime, actorId, payload: { reason: (error as Error).message } }] };
    }
  }
  const command = map[candidateId];
  if (!command) return { state, events: [] };
  try {
    return applyCommand(state, command);
  } catch (error) {
    return { state, events: [{ eventId: `rejected-${state.version}`, type: 'command_rejected', simTime: state.simTime,
      actorId, payload: { reason: (error as Error).message } }] };
  }
}

let state = createWorldV2({ npcIds: ids, days, rngSeed: `play-${npcCount}-${days}` });
const memories = new Map(ids.map(id => [id, memoryFromNames(id)]));
const trace: unknown[] = [];
const allEvents: WorldEvent[] = [];

for (let day = 1; day <= days; day += 1) {
  const dayStart = state;
  const decisions: unknown[] = [];
  // Overnight survival clock continues even while decisions are made.
  const baseline = runEightNpcDay(state, day);
  state = baseline.state;
  allEvents.push(...baseline.events);
  for (const id of ids) {
    const npc = state.npcs[id];
    if (!npc.alive) continue;
    const view = viewOf(state);
    const memory = memories.get(id)!;
    const query = memory.query({ observerId: id, now: state.simTime, goalRef: `p-${id}`, text: '留饭', topK: 4 });
    const promises: PromiseRef[] = query.promises.map(promise => ({
      promiseId: promise.promiseId, toId: promise.toId, status: promise.status, revision: promise.lastRevision,
    }));
    const planningView: PlanningView = {
      actorId: id,
      npcs: view.npcs.map(entry => ({ id: entry.id, hunger: entry.hunger, stamina: entry.stamina,
        health: entry.health, san: entry.san, alive: entry.alive })),
      resources: view.resources,
      furnace: view.furnace,
      weather: view.weather,
    };
    const request = buildPlanningRequest({ view: planningView, promises, stateVersion: state.version,
      requestId: `${id}-d${day}`, memorySnapshotHash: query.memorySnapshotHash,
      memoryPolicyVersion: query.memoryPolicyVersion });
    const result = referenceScorer().score(request);
    const before = state;
    const applied = result.selectedId ? applyChoice(state, id, result.selectedId) : { state, events: [] };
    state = applied.state;
    allEvents.push(...applied.events);
    if (result.selectedId?.startsWith('c-help-')) {
      const promiseId = promises[0]?.promiseId;
      if (promiseId) {
        memory.append({ eventId: `kept-${promiseId}-d${day}`, observerId: id,
          occurredAt: state.simTime, observedAt: state.simTime, kind: 'promise_kept',
          subjectIds: [id, 'player'],
          payload: { promiseId, fromId: id, toId: 'player' }, source: 'engine', authority: 'npc' });
      }
    }
    const chosen = request.candidates.find(candidate => candidate.id === result.selectedId);
    decisions.push({
      actorId: id,
      selectedId: result.selectedId,
      candidateIds: request.candidates.map(candidate => candidate.id),
      utility: chosen ? utilityOf(chosen) : null,
      probability: result.scores.find(score => score.candidateId === result.selectedId)?.probability ?? null,
      promiseStatus: promises[0]?.status ?? null,
      memorySnapshotHash: query.memorySnapshotHash,
      memoryQueryStatus: query.queryStatus,
      stateVersionBefore: before.version,
      stateVersionAfter: state.version,
      events: applied.events.map(event => event.type),
    });
  }
  trace.push({
    day,
    start: { day: dayStart.day, resources: dayStart.resources, furnace: dayStart.furnace,
      alive: Object.values(dayStart.npcs).filter(npc => npc.alive).length },
    end: { day: state.day, resources: state.resources, furnace: state.furnace,
      alive: Object.values(state.npcs).filter(npc => npc.alive).length },
    decisions,
  });
}

const outDir = join(process.cwd(), 'artifacts/sprint-r1/play-fixture');
mkdirSync(outDir, { recursive: true });
const payload = {
  schema: 'frostecho.play-trace/1',
  mode: 'reference-fixture',
  days,
  npcCount,
  final: { ending: state.ending, resources: state.resources, furnace: state.furnace,
    alive: Object.values(state.npcs).filter(npc => npc.alive).length,
    dead: state.dead },
  eventCount: allEvents.length,
  trace,
  traceSha256: createHash('sha256').update(JSON.stringify(trace)).digest('hex'),
};
const path = join(outDir, `${npcCount}npc-${days}day.json`);
writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ path, ending: state.ending, alive: payload.final.alive,
  eventCount: allEvents.length, traceSha256: payload.traceSha256 }, null, 2));
