import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { integrationExit, judgeGate, normalizeLinkedState, resolvePython } from '../scripts/verify-r6';

test('a missing gate is blocked and a failed gate makes the summary nonzero', () => {
  assert.equal(judgeGate(undefined, 'abc'), 'blocked');
  assert.equal(judgeGate({ status: 'pass', head: 'other' }, 'abc'), 'fail');
  assert.equal(judgeGate({ status: 'pass', head: 'abc' }, 'abc'), 'pass');
  assert.equal(integrationExit(['pass', 'fail']), 1);
  assert.equal(integrationExit(['pass', 'blocked']), 1);
  assert.equal(integrationExit(['pass', 'pass']), 0);
});

test('scrambling only task.commitmentId fails the linked comparison', () => {
  const honest = {
    council: { councils: [{ requests: [{ requestId: 'req-1', commitmentId: 'cm-real', actorId: 'npc_01', goal: 'supply-warehouse' }] }] },
    commitments: { commitments: [{ commitmentId: 'cm-real', promisorId: 'npc_01', goal: 'supply-warehouse', createdAt: 0, revision: 1, changes: [] }] },
    tasks: [{ taskId: 'task-1', actorId: 'npc_01', commitmentId: 'cm-real', status: 'done' }],
    session: { memories: {} },
  };
  const renamed = JSON.parse(JSON.stringify(honest));
  renamed.commitments.commitments[0].commitmentId = 'cm-other';
  renamed.council.councils[0].requests[0].commitmentId = 'cm-other';
  renamed.tasks[0].commitmentId = 'cm-other';
  assert.deepEqual(normalizeLinkedState(honest), normalizeLinkedState(renamed));
  const scrambled = JSON.parse(JSON.stringify(honest));
  scrambled.tasks[0].commitmentId = 'cm-not-the-request';
  assert.notDeepEqual(normalizeLinkedState(honest), normalizeLinkedState(scrambled));
});

test('python resolution keeps an absolute path that contains spaces', () => {
  const spaced = join(tmpdir(), 'py dir r61');
  const executable = join(spaced, 'python.exe');
  mkdirSync(spaced, { recursive: true });
  try {
    symlinkSync(resolvePython(['node'], {}), executable);
    const chosen = resolvePython(['node', '--python', executable], {});
    assert.equal(chosen, executable);
    const run = spawnSync(chosen, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '1');
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});
