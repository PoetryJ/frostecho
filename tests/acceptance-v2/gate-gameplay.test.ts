/**
 * R2 acceptance gate G2 (black box): the four-day playable slice through the
 * shipped CLI, including cross-process save/restore and 96 real hours.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

test('G2-a: assign/cancel-task/game-step/save and restore through the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-g2a-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state,
      'assign npc_01 gather-food\nassign npc_02 heating\ntask-status\ngame-step\nsave\nquit\n',
      ['--fresh', '--npc', '3', '--food', '6', '--days', '4']);
    const assigned = first.filter(row => row.command === 'assign');
    assert.equal(assigned.length, 2);
    const before = first.find(row => row.command === 'task-status')!.status;
    assert.equal(before.mode, 'reference-rules/1');
    assert.equal(before.tasks.length, 2);
    const step = first.find(row => row.command === 'game-step')!;
    assert.equal(step.mode, 'reference-rules/1');
    assert.ok(step.records.length >= 1);
    const restored = cli(state, 'task-status\nquit\n');
    const after = restored.find(row => row.command === 'task-status')!.status;
    assert.deepEqual(after.tasks.map((task: any) => task.taskId),
      before.tasks.map((task: any) => task.taskId));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2-b: 8 NPC x 4 days = 96h ending is decided by the authoritative state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-g2b-'));
  const state = join(dir, 's.json');
  try {
    const roster = [['npc_01', 'gather-food'], ['npc_02', 'gather-food'],
      ['npc_03', 'gather-food'], ['npc_04', 'gather-wood'], ['npc_05', 'gather-wood'],
      ['npc_06', 'heating'], ['npc_07', 'heating'], ['npc_08', 'leave-food']];
    const lines: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      for (const [actorId, kind] of roster) lines.push(`assign ${actorId} ${kind}`);
      lines.push('game-step', 'advance 1440');
    }
    lines.push('task-status', 'save', 'quit');
    const rows = cli(state, `${lines.join('\n')}\n`,
      ['--fresh', '--npc', '8', '--food', '12', '--days', '4', '--seed', 'gate-96']);
    const status = rows.find(row => row.command === 'task-status')!.status;
    assert.equal(status.hoursElapsed, 96);
    assert.equal(status.ending, 'survived');
    assert.equal(status.mode, 'reference-rules/1');
    for (const value of Object.values(status.resources as Record<string, number>)) {
      assert.ok(value >= 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
