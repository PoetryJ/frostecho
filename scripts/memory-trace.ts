/**
 * Cross-process memory trace:
 *   day 1: A promises to leave food -> player revokes, A hears it, B does not
 *          -> save store and exit
 *   day 2: new process restores -> A's plan is invalidated, B still believes
 *          the promise is active until it directly hears the retraction
 *
 * Run:
 *   node dist/scripts/memory-trace.js day1
 *   node dist/scripts/memory-trace.js day2
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MemoryStore, type MemoryRecordInput } from '../src/memory/store';

const OUT = join(process.cwd(), 'artifacts/sprint-1116/memory-trace');
const STORE = join(OUT, 'store.json');

function record(input: MemoryRecordInput): MemoryRecordInput {
  return input;
}

function write(name: string, value: unknown): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface Plan {
  planId: string;
  owner: string;
  promiseId: string;
  dependencyRevision: number;
  steps: string[];
  state: 'planned' | 'invalidated';
  invalidatedBy?: string;
}

function planFor(owner: string, promiseId: string, revision: number, steps: string[]): Plan {
  return { planId: `plan-${owner}-${promiseId}`, owner, promiseId, dependencyRevision: revision,
    steps, state: 'planned' };
}

function applyPlan(plan: Plan, status: string, revision: number): Plan {
  if (status !== 'active') {
    return { ...plan, state: 'invalidated', invalidatedBy: `promise:${status}@r${revision}` };
  }
  return plan;
}

function day1(): void {
  const store = new MemoryStore();
  // Both A and B were present when A promised to leave food.
  for (const observer of ['npc_a', 'npc_b']) {
    store.append(record({
      eventId: 'e-promise-1', observerId: observer, occurredAt: 100, observedAt: 100,
      kind: 'promise_made', subjectIds: ['npc_a', 'player'],
      payload: { promiseId: 'p-leave-food', fromId: 'npc_a', toId: 'player', text: '给玩家留一份饭' },
      source: 'engine', authority: 'npc', relatedRequestId: 'req-1',
    }));
  }
  // Player revokes privately to A only. B is not in the room.
  store.append(record({
    eventId: 'e-retract-1', observerId: 'npc_a', occurredAt: 110, observedAt: 110,
    kind: 'promise_retract', subjectIds: ['npc_a', 'player'],
    payload: { promiseId: 'p-leave-food', byId: 'player', text: '不用留了，今晚我不回来吃' },
    source: 'player_statement', authority: 'player', retracts: ['e-promise-1'],
  }));
  // A third party claiming to revoke must not change the authoritative promise.
  store.append(record({
    eventId: 'e-retract-third', observerId: 'npc_a', occurredAt: 115, observedAt: 115,
    kind: 'promise_retract', subjectIds: ['npc_c'],
    payload: { promiseId: 'p-leave-food', byId: 'npc_c', text: '我替他取消' },
    source: 'engine', authority: 'third_party',
  }));

  const plans = [
    planFor('npc_a', 'p-leave-food', 1, ['cook-extra-portion', 'leave-box-in-dorm']),
    planFor('npc_b', 'p-leave-food', 1, ['keep-soup-warm']),
  ];
  const queryA = store.query({ observerId: 'npc_a', now: 120, text: '留饭', goalRef: 'req-1', topK: 4 });
  const queryB = store.query({ observerId: 'npc_b', now: 120, text: '留饭', goalRef: 'req-1', topK: 4 });
  const promiseA = queryA.promises.find(view => view.promiseId === 'p-leave-food');
  const promiseB = queryB.promises.find(view => view.promiseId === 'p-leave-food');

  const out = {
    schema: 'frostecho.memory-trace/1',
    phase: 'day1',
    simTime: 120,
    process: 'pid=' + process.pid,
    queryA: { promises: queryA.promises, queryStatus: queryA.queryStatus,
      hash: queryA.memorySnapshotHash, evidenceIds: queryA.evidenceIds },
    queryB: { promises: queryB.promises, queryStatus: queryB.queryStatus,
      hash: queryB.memorySnapshotHash, evidenceIds: queryB.evidenceIds },
    plans: plans.map(plan => plan.owner === 'npc_a'
      ? applyPlan(plan, promiseA?.status ?? 'unresolved', promiseA?.lastRevision ?? 0) : plan),
    relation: store.relation('npc_a', 'npc_a', 'player'),
    memoryPolicyVersion: store.policyVersion,
    note: 'A heard the player retraction; B did not. Process will exit after writing the store.',
  };
  write('day1.json', out);
  write('store.json', store.toJSON());
  console.log(JSON.stringify(out, null, 2));
}

function day2(): void {
  const store = MemoryStore.fromJSON(JSON.parse(readFileSync(STORE, 'utf8')));
  const rebuilt = store.rebuild();
  const before = { hash: store.snapshotHash(), rebuiltHash: rebuilt.snapshotHash() };

  // New process: A still knows the retraction, B still does not.
  const day2StartA = store.query({ observerId: 'npc_a', now: 200, text: '留饭', goalRef: 'req-1', topK: 4 });
  const day2StartB = store.query({ observerId: 'npc_b', now: 200, text: '留饭', goalRef: 'req-1', topK: 4 });

  // Player tells B directly on day 2. B's knowledge changes only now.
  store.append(record({
    eventId: 'e-retract-2', observerId: 'npc_b', occurredAt: 210, observedAt: 210,
    kind: 'promise_retract', subjectIds: ['npc_b', 'player'],
    payload: { promiseId: 'p-leave-food', byId: 'player', text: '不用留了（当面告知 B）' },
    source: 'player_statement', authority: 'player', retracts: ['e-promise-1'],
  }));
  const afterB = store.query({ observerId: 'npc_b', now: 220, text: '留饭', goalRef: 'req-1', topK: 4 });

  const promiseA = day2StartA.promises.find(view => view.promiseId === 'p-leave-food');
  const promiseB = day2StartB.promises.find(view => view.promiseId === 'p-leave-food');
  const promiseBAfter = afterB.promises.find(view => view.promiseId === 'p-leave-food');
  const planA = applyPlan(planFor('npc_a', 'p-leave-food', 1, ['cook-extra-portion', 'leave-box-in-dorm']),
    promiseA?.status ?? 'unresolved', promiseA?.lastRevision ?? 0);
  const planBBefore = planFor('npc_b', 'p-leave-food', 1, ['keep-soup-warm']);
  const planBAfter = applyPlan(planBBefore, promiseBAfter?.status ?? 'unresolved', promiseBAfter?.lastRevision ?? 0);

  const out = {
    schema: 'frostecho.memory-trace/1',
    phase: 'day2',
    simTime: 220,
    process: 'pid=' + process.pid,
    restored: before,
    day2Start: {
      A: { status: promiseA?.status, evidenceIds: day2StartA.evidenceIds, hash: day2StartA.memorySnapshotHash },
      B: { status: promiseB?.status, evidenceIds: day2StartB.evidenceIds, hash: day2StartB.memorySnapshotHash },
    },
    planA,
    planBBefore,
    afterDirectCommunication: { B: { status: promiseBAfter?.status,
      evidenceIds: afterB.evidenceIds, hash: afterB.memorySnapshotHash } },
    planBAfter,
    relationA: store.relation('npc_a', 'npc_a', 'player'),
    note: 'Restore rebuilds indexes; A acts on the cancellation, B only after direct communication.',
  };
  write('day2.json', out);
  write('store-after-day2.json', store.toJSON());
  console.log(JSON.stringify(out, null, 2));
}

const phase = process.argv[2];
if (phase === 'day1') day1();
else if (phase === 'day2') day2();
else {
  console.error('usage: memory-trace.js day1|day2');
  process.exit(2);
}
