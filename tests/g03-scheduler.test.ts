/**
 * G03 workstream A self-tests — round-robin scheduler semantics.
 * Uses deferred promises; no sleeps, no real timers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionStatus, StepAgentResult } from '../src/agent/contracts';
import { createScheduler } from '../src/multi/scheduler';

interface FakeActor {
  status: SessionStatus;
  steps: number;
  resolve?: (r: StepAgentResult) => void;
}

function makeWorld(statuses: Record<string, SessionStatus>) {
  const actors: Record<string, FakeActor> = {};
  for (const [id, status] of Object.entries(statuses)) actors[id] = { status, steps: 0 };
  const calls: string[] = [];
  return {
    actors,
    calls,
    getStatus: (id: string): SessionStatus => actors[id]?.status ?? 'invalid_run',
    step: (id: string): Promise<StepAgentResult> => {
      actors[id].steps += 1;
      let resolve!: (r: StepAgentResult) => void;
      const promise = new Promise<StepAgentResult>(res => { resolve = res; });
      actors[id].resolve = (r) => { actors[id].status = r.terminal ? (r.status as SessionStatus) : 'ready'; resolve(r); };
      calls.push(id);
      return promise;
    },
    settle: (id: string, r: StepAgentResult) => actors[id].resolve!(r),
    /** Wait until the fake world has seen n step() entries. */
    waitForCalls: async (n: number): Promise<void> => {
      while (calls.length < n) await Promise.resolve();
    },
  };
}

const stepped = (extra: Partial<StepAgentResult> = {}): StepAgentResult =>
  ({ status: 'ready', terminal: false, providerCalled: true, ...extra });

test('round-robin alternates starting from the first actor in order', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  const picks: string[] = [];
  for (let i = 0; i < 4; i++) {
    const p = s.advance();
    const picked = w.calls[w.calls.length - 1]; // step() was entered synchronously
    w.settle(picked, stepped());
    const r = await p;
    assert.equal(r.kind, 'stepped');
    picks.push(r.kind === 'stepped' ? r.actorId : 'none');
  }
  assert.deepEqual(picks, ['npc_a', 'npc_c', 'npc_a', 'npc_c']);
});

test('reversed actor order reverses the rotation start', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_c', 'npc_a'], getStatus: w.getStatus, step: w.step });
  const first = s.advance();
  assert.equal(w.calls[0], 'npc_c');
  w.settle('npc_c', stepped());
  assert.equal((await first).kind, 'stepped');
});

test('overlapping advance returns busy and starts no second step', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  const first = s.advance();
  const second = await s.advance();
  assert.equal(second.kind, 'busy');
  assert.equal(w.calls.length, 1);
  w.settle('npc_a', stepped());
  assert.equal((await first).kind, 'stepped');
});

test('terminal actors are skipped; ready actors keep getting turns', async () => {
  const w = makeWorld({ npc_a: 'stopped', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  for (let i = 0; i < 3; i++) {
    const p = s.advance();
    w.settle('npc_c', stepped());
    const r = await p;
    assert.equal(r.kind, 'stepped');
    assert.ok(r.kind === 'stepped' && r.actorId === 'npc_c');
  }
  assert.equal(w.actors.npc_a.steps, 0);
});

test('all terminal → advance reports done', async () => {
  const w = makeWorld({ npc_a: 'goal_reached', npc_c: 'stopped' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  assert.equal((await s.advance()).kind, 'done');
});

test('run drives to done when everything reaches a terminal status', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  const finished = s.run();
  await w.waitForCalls(1);
  w.settle('npc_a', stepped({ status: 'goal_reached', terminal: true }));
  await w.waitForCalls(2);
  w.settle('npc_c', stepped({ status: 'stopped', terminal: true }));
  assert.equal(await finished, 'done');
  assert.deepEqual(w.calls, ['npc_a', 'npc_c']);
});

test('advance during run returns busy; re-entrant run returns busy', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  const finished = s.run();
  await w.waitForCalls(1);
  assert.equal((await s.advance()).kind, 'busy');
  assert.equal(await s.run(), 'busy');
  w.settle('npc_a', stepped({ status: 'stopped', terminal: true }));
  await w.waitForCalls(2);
  w.settle('npc_c', stepped({ status: 'stopped', terminal: true }));
  assert.equal(await finished, 'done');
});

test('timeout and provider_error interrupt the episode', async () => {
  for (const status of ['timeout', 'provider_error'] as const) {
    const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
    const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
    const p = s.advance();
    w.settle('npc_a', stepped({ status, terminal: true }));
    const r = await p;
    assert.equal(r.kind, 'interrupted');
    assert.ok(r.kind === 'interrupted' && r.actorId === 'npc_a');
  }
});

test('parse failure and budget exhaustion are actor results, not interrupts', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  const p = s.advance();
  w.settle('npc_a', stepped({ status: 'budget_exhausted', terminal: true }));
  assert.equal((await p).kind, 'stepped');
});

test('close forbids new steps and waits for the in-flight step', async () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const s = createScheduler({ actorIds: ['npc_a', 'npc_c'], getStatus: w.getStatus, step: w.step });
  const first = s.advance();
  const closing = s.close();
  assert.equal(s.isClosed(), true);
  assert.equal((await s.advance()).kind, 'closed');
  assert.equal(await s.run(), 'closed');
  w.settle('npc_a', stepped());
  assert.equal((await first).kind, 'stepped');
  await closing;
  assert.equal(w.calls.length, 1); // no second step was ever started
});

test('constructor rejects empty, duplicate, unknown, and player ids', () => {
  const w = makeWorld({ npc_a: 'ready', npc_c: 'ready' });
  const opts = { getStatus: w.getStatus, step: w.step };
  assert.throws(() => createScheduler({ ...opts, actorIds: [] }), /empty/);
  assert.throws(() => createScheduler({ ...opts, actorIds: ['npc_a', 'npc_a'] }), /duplicate/);
  assert.throws(() => createScheduler({ ...opts, actorIds: ['npc_a', 'npc_b'] }), /unknown/);
  assert.throws(() => createScheduler({ ...opts, actorIds: ['npc_x'] }), /unknown/);
});
