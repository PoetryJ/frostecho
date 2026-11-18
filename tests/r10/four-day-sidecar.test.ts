/**
 * R10 (A): the four-day path must persist the same board set as the CLI.
 *
 * The bug this locks down: the runner called only `runtime.save()`, which
 * writes the session and the R8 domains but NOT the task/commitment/council
 * boards. After a restore the world and the NPCs came back while every promise
 * silently vanished, so "restored" meant "a world without obligations".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '../../src/decision/contracts';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { createCommitmentBridge } from '../../src/r7/integration/commitment-bridge';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { auditSettlement, FOUR_DAY_SIDECAR_SUFFIXES, fourDaySidecarPaths,
  loadFourDaySidecars, requireFourDaySidecars, saveFourDaySidecars }
  from '../../src/r7/integration/sidecar';

function restCandidate(id = 'rest-60'): Candidate {
  return { id, kind: 'rest', description: '原地休息 60 分钟',
    parameters: { action: 'rest', minutes: 60 }, preconditions: [],
    expectedEffects: {}, utilityComponents: {} };
}

test('the four-day save writes every CLI sidecar and a restore keeps promises alive', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frostecho-r10-sidecar-'));
  try {
    const base = join(directory, 'state.json');
    const runtime = R8Runtime.create({ seed: 'r10-sidecar' });
    const play = new GameplayLoop(runtime.session);
    const requested = play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
    const commitmentId = requested.commitment.commitmentId;
    const taskId = requested.task!.taskId;
    const begun = runtime.beginIntent({ intentId: 'npc_01-rest-1', commandId: 'cmd-rest-1',
      actorId: 'npc_01', candidate: restCandidate(), minutes: 60 });
    assert.ok('intent' in begun);
    const demandId = begun.intent.demandId;

    const paths = saveFourDaySidecars(runtime, play, base);
    // The exact CLI file set, not a subset.
    assert.deepEqual(Object.keys(paths).sort(), ['commitments', 'council', 'experience',
      'longTermMemory', 'runtime', 'session', 'tasks']);
    assert.equal(FOUR_DAY_SIDECAR_SUFFIXES.length, 7);
    for (const path of Object.values(paths)) assert.ok(existsSync(path), path);

    // The raw bytes really carry the promise and its work row.
    const savedCommitments = JSON.parse(readFileSync(paths.commitments, 'utf8')) as {
      commitments: { commitmentId: string; status: string; revision: number }[] };
    assert.deepEqual(savedCommitments.commitments.map(row => row.commitmentId), [commitmentId]);
    const savedTasks = JSON.parse(readFileSync(paths.tasks, 'utf8')) as
      { taskId: string; status: string }[];
    assert.equal(savedTasks.find(row => row.taskId === taskId)?.status, 'active');
    const savedRuntime = JSON.parse(readFileSync(paths.runtime, 'utf8')) as {
      intents: { intentId: string; demandId: string; status: string; dueAt: number }[] };
    const savedIntent = savedRuntime.intents.find(row => row.intentId === 'npc_01-rest-1')!;
    assert.equal(savedIntent.demandId, demandId);
    assert.equal(savedIntent.status, 'working');

    // Restore through the CLI composition: R8 is the authority, boards ride on it.
    const restored = loadFourDaySidecars(base);
    const row = restored.play.commitments.find(commitmentId)!;
    assert.equal(row.status, 'active');
    assert.equal(row.revision, savedCommitments.commitments[0].revision);
    assert.equal(restored.play.board.find(taskId)?.status, 'active');
    const active = restored.runtime.activeIntent('npc_01')!;
    assert.equal(active.intentId, 'npc_01-rest-1');
    assert.equal(active.demandId, demandId, 'the demand identity survives the process boundary');
    assert.equal(restored.runtime.busyUntil('npc_01'), active.dueAt);

    // The bridge re-registers guards and replays only what the ledger still
    // owes; the active promise must not be fulfilled by that replay.
    createCommitmentBridge(restored.runtime, restored.play);
    assert.equal(restored.play.commitments.find(commitmentId)!.status, 'active');
    assert.equal(restored.play.commitments.find(commitmentId)!.evidenceEventIds.length, 0);

    // The queued work settles once, on the authoritative clock, and does not
    // touch the promise it was never bound to.
    restored.runtime.advanceWorld(active.dueAt);
    const entries = restored.runtime.workLog
      .filter(entry => entry.intentId === 'npc_01-rest-1');
    assert.equal(entries.length, 1, 'one terminal record, not a re-settlement');
    assert.equal(entries[0].status, 'applied');
    assert.equal(entries[0].eventIds.length, 1);
    assert.equal(entries[0].settledAt, active.dueAt);
    assert.equal(restored.runtime.committedEvents()
      .filter(event => event.type === 'rested' && event.actorId === 'npc_01').length, 1);
    assert.equal(restored.play.commitments.find(commitmentId)!.status, 'active');
    const audit = auditSettlement(restored.runtime, restored.play);
    assert.deepEqual(audit.duplicates, { settledTwice: [], projectedTwice: [],
      duplicateFulfilments: [] });
    assert.equal(audit.ok, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a save that lost the commitment board is refused, not restored as a world without promises', () => {
  const directory = mkdtempSync(join(tmpdir(), 'frostecho-r10-sidecar-missing-'));
  try {
    const base = join(directory, 'state.json');
    const runtime = R8Runtime.create({ seed: 'r10-sidecar-missing' });
    const play = new GameplayLoop(runtime.session);
    play.requestCommitment('npc_02', 'supply-warehouse', { verdict: 'accept' });
    const paths = saveFourDaySidecars(runtime, play, base);
    assert.equal(requireFourDaySidecars(base).commitments, paths.commitments);

    // Simulate the R9-era runner: session + R8 sidecar only.
    const stripped = join(directory, 'stripped.json');
    copyFileSync(paths.session, stripped);
    copyFileSync(paths.runtime, `${stripped}.r8.json`);
    writeFileSync(`${stripped}.tasks.json`, readFileSync(paths.tasks));
    assert.throws(() => loadFourDaySidecars(stripped),
      /missing_four_day_sidecar:.*\.commitments\.json/);
    // The refusal is about a missing board, not about an unreadable world.
    assert.equal(existsSync(`${stripped}.r8.json`), true);
    assert.equal(existsSync(fourDaySidecarPaths(stripped).commitments), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
