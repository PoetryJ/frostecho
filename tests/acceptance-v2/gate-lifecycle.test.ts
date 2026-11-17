/**
 * R2 acceptance gate G1 (black box, real subprocess): lifecycle, cancel
 * revocation and promise instances through the shipped CLI only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function cli(state: string, input: string, extra: string[] = []): Record<string, any>[] {
  const run = spawnSync(process.execPath,
    ['dist/scripts/play-sprint.js', '--state', state, ...extra],
    { input, encoding: 'utf8', cwd: process.cwd() });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('G1-a: piped step/save/quit settles the step and saves its effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-g1a-'));
  const state = join(dir, 's.json');
  try {
    const rows = cli(state, 'promise npc_01\nstep\nsave\nquit\n', ['--fresh', '--npc', '2']);
    const step = rows.find(row => row.command === 'step');
    assert.ok(step?.jobId);
    assert.ok(step.outcomes.length >= 1);
    const save = rows.find(row => row.command === 'save')!;
    assert.ok(save.version > 0);
    assert.equal(save.pending, 0);
    const doc = JSON.parse(readFileSync(state, 'utf8'));
    assert.ok(Object.keys(doc.outcomes).length >= 1);
    assert.ok(doc.world.version > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1-b: EOF without quit drains the queue and exits cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-g1b-'));
  try {
    const rows = cli(join(dir, 's.json'), 'promise npc_01\nstep\n', ['--fresh', '--npc', '2']);
    const exit = rows.find(row => row.event === 'exit');
    assert.ok(exit);
    assert.equal(exit.completed, exit.jobs);
    assert.equal(rows.some(row => row.event === 'incomplete'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1-c: a cancel accepted before the queued step revokes its choice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-g1c-'));
  try {
    const rows = cli(join(dir, 's.json'),
      'promise npc_01\nstep npc_01\ncancel npc_01\nknowledge\nsave\nquit\n',
      ['--fresh', '--npc', '2', '--food', '2']);
    const step = rows.find(row => row.command === 'step')!;
    assert.equal(step.decisions[0].executed, false);
    const knowledge = rows.find(row => row.command === 'knowledge')!;
    assert.equal(knowledge.knowledge.npc_01.promises[0].status, 'cancelled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G1-d: promise -> cancel -> promise creates a new live instance after restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-g1d-'));
  const state = join(dir, 's.json');
  try {
    const rows = cli(state,
      'promise npc_01\ncancel npc_01\npromise npc_01\nknowledge\nsave\nquit\n',
      ['--fresh', '--npc', '2', '--food', '2']);
    const knowledge = rows.find(row => row.command === 'knowledge')!;
    assert.deepEqual(knowledge.knowledge.npc_01.promises.map((p: any) => p.status), ['active']);
    const restored = cli(state, 'knowledge\nquit\n');
    const after = restored.find(row => row.command === 'knowledge')!;
    assert.equal(after.knowledge.npc_01.promises[0].status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
