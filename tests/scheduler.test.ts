import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FairScheduler, fairOrder, type ScheduledTask } from '../src/scheduler-v2/scheduler';

function task(actorId: string, taskId: string, delay: number, version = 1): ScheduledTask<string> {
  return { actorId, taskId, stateVersion: version,
    run: () => new Promise(resolve => setTimeout(() => resolve(taskId), delay)) };
}

test('round-robin order is fair across actors', () => {
  const tasks = ['a', 'b', 'c'].flatMap(actor => [1, 2, 3].map(index =>
    task(actor, `${actor}${index}`, 0)));
  assert.deepEqual(fairOrder(tasks), ['a1', 'b1', 'c1', 'a2', 'b2', 'c2', 'a3', 'b3', 'c3']);
});

test('a slow actor does not delay the other actors', async () => {
  const scheduler = new FairScheduler();
  const completed: string[] = [];
  scheduler.add(task('slow', 'slow-1', 60));
  scheduler.add(task('fast', 'fast-1', 1));
  await scheduler.run({ timeoutMs: 500, onOutcome: outcome => {
    if (outcome.status === 'completed') completed.push(outcome.actorId);
  } });
  assert.deepEqual(completed, ['fast', 'slow']);
});

test('only one decision is in flight per actor', async () => {
  const scheduler = new FairScheduler();
  let concurrent = 0;
  let max = 0;
  for (let index = 0; index < 4; index += 1) {
    scheduler.add({ actorId: 'a', taskId: `a${index}`, stateVersion: 1, async run() {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await new Promise(resolve => setTimeout(resolve, 2));
      concurrent -= 1;
      return index;
    } });
  }
  await scheduler.run();
  assert.equal(max, 1);
});

test('a timeout is reported without blocking later tasks', async () => {
  const scheduler = new FairScheduler();
  scheduler.add(task('a', 'slow', 100));
  scheduler.add(task('a', 'next', 1));
  const outcomes = await scheduler.run({ timeoutMs: 10 });
  const statuses = outcomes.map(outcome => `${outcome.taskId}:${outcome.status}`);
  assert.ok(statuses.includes('slow:timed_out'));
  assert.ok(statuses.includes('next:completed'));
});

test('late results are rejected against the current state version', async () => {
  const scheduler = new FairScheduler();
  scheduler.add(task('a', 'late', 1, 1));
  const outcomes = await scheduler.run({ currentVersion: () => 2 });
  assert.equal(outcomes[0].status, 'late');
});

test('cancelled tasks never run', async () => {
  const scheduler = new FairScheduler();
  let ran = 0;
  scheduler.add({ actorId: 'a', taskId: 'cancel-me', stateVersion: 1,
    async run() { ran += 1; return 'x'; } });
  scheduler.cancel('cancel-me');
  const outcomes = await scheduler.run();
  assert.equal(ran, 0);
  assert.equal(outcomes[0].status, 'cancelled');
});
