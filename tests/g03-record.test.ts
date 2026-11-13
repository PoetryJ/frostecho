/**
 * G03 workstream C self-tests — scenarios, reference step counts, fixture
 * batch end-to-end (12 episodes), on-disk evidence verification, and the
 * corrupted-record probe. Offline reference policy only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { createMultiGame } from '../src/multi/game';
import { runG03Batch, verifyG03Batch, episodeIdFor } from '../src/multi/eval';
import { judgeMultiScenario, loadMultiScenario, MULTI_SCENARIO_IDS } from '../src/multi/scenarios';
import { verifyMultiEpisode, writeMultiEpisode, summarizeMultiBatchDir, countChatRequests, chatRequestsByActor } from '../src/multi/record';
import type { MultiRecord } from '../src/multi/contracts';

function playScenario(scenarioId: 'm1' | 'm2' | 'm3', order: 'ac' | 'ca'): Promise<MultiRecord> {
  const scenario = loadMultiScenario(scenarioId);
  const actorIds = order === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
  const game = createMultiGame({
    episodeId: `unit-${scenarioId}-${order}`,
    initialState: structuredClone(scenario.initialState),
    actorIds,
    providerFor: () => createReferenceProvider(),
    mode: 'fixture',
    thinking: false,
  });
  let intervened = false;
  if (scenario.playerIntervention !== null) {
    for (const actorId of actorIds) {
      const session = game.sessions[actorId];
      session.onDeciding = () => {
        if (!intervened) {
          intervened = true;
          game.playerLine(scenario.playerIntervention!.line);
        }
      };
    }
  }
  const outcomeP = game.run();
  return outcomeP.then(kind => {
    const record = game.snapshot();
    record.scenarioId = scenarioId;
    record.scenarioPass = judgeMultiScenario(scenarioId, record).pass;
    void kind;
    return record;
  });
}

test('M1 both orders: 4 reference decisions, both NPCs reach 70, player stays 20', async () => {
  for (const order of ['ac', 'ca'] as const) {
    const record = await playScenario('m1', order);
    assert.equal(record.turns.length, 4, `${order} step count`);
    assert.equal(record.finalState.npcs.npc_a.hunger, 70);
    assert.equal(record.finalState.npcs.npc_c.hunger, 70);
    assert.equal(record.finalState.npcs.npc_b.hunger, 20);
    assert.equal(record.finalState.food.kitchen, 0);
    assert.equal(judgeMultiScenario('m1', record).pass, true, `${order} verdict`);
    assert.equal(record.actors.npc_a.goalReached, true);
    assert.equal(record.actors.npc_c.goalReached, true);
  }
});

test('M2 both orders: 4 reference decisions, first-scheduled NPC wins and reversal flips the winner', async () => {
  const ac = await playScenario('m2', 'ac');
  assert.equal(ac.turns.length, 4);
  assert.equal(ac.finalState.npcs.npc_a.hunger, 70);
  assert.equal(ac.finalState.npcs.npc_c.hunger, 40);
  assert.equal(ac.actors.npc_a.goalReached, true);
  assert.equal(ac.actors.npc_c.goalReached, false);
  assert.equal(ac.actors.npc_c.status, 'stopped');
  assert.equal(judgeMultiScenario('m2', ac).pass, true);

  const ca = await playScenario('m2', 'ca');
  assert.equal(ca.turns.length, 4);
  assert.equal(ca.finalState.npcs.npc_c.hunger, 70);
  assert.equal(ca.finalState.npcs.npc_a.hunger, 40);
  assert.equal(ca.actors.npc_c.goalReached, true);
  assert.equal(ca.actors.npc_a.goalReached, false);
  assert.equal(judgeMultiScenario('m2', ca).pass, true);
});

test('M3 both orders: player steals the food, 3 reference decisions, NO_FOOD contention recorded', async () => {
  for (const order of ['ac', 'ca'] as const) {
    const record = await playScenario('m3', order);
    assert.equal(record.turns.length, 3, `${order} step count`);
    assert.equal(record.finalState.npcs.npc_a.hunger, 40);
    assert.equal(record.finalState.npcs.npc_c.hunger, 40);
    assert.equal(record.finalState.npcs.npc_b.hunger, 50);
    assert.equal(record.finalState.food.kitchen, 0);
    assert.equal(record.actors.npc_a.goalReached, false);
    assert.equal(record.actors.npc_c.goalReached, false);
    assert.equal(judgeMultiScenario('m3', record).pass, true, `${order} verdict`);
    const rejected = record.commands.filter(e => e.command.actorId !== 'npc_b' && e.command.type === 'eat' && e.result.status !== 'accepted');
    assert.equal(rejected.length, 1, `${order} exactly one rejected NPC eat`);
  }
});

test('chat request counting follows transport presence (fixture has none), decisions follow providerCalls', async () => {
  const record = await playScenario('m1', 'ac');
  // Reference provider performs no HTTP calls, so no turn carries transport (§4).
  assert.equal(countChatRequests(record), 0);
  assert.deepEqual(chatRequestsByActor(record), {});
  // Decisions are still accounted per actor via providerCalls.
  assert.equal(record.actors.npc_a.providerCalls, 2);
  assert.equal(record.actors.npc_c.providerCalls, 2);
  assert.equal(record.turns.filter(t => t.step !== null && t.step !== undefined).length, 4);
});

test('episode evidence round-trip verifies on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g03-episode-'));
  try {
    const record = await playScenario('m2', 'ac');
    writeMultiEpisode(dir, record);
    const verification = verifyMultiEpisode(join(dir, 'episodes', record.episodeId));
    assert.equal(verification.ok, true, verification.issues.join('; '));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupted record probe: tampered final state, deleted replay file, array root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'g03-corrupt-'));
  try {
    const record = await playScenario('m1', 'ac');
    const episodeDir = join(dir, 'episodes', record.episodeId);
    writeMultiEpisode(dir, record);

    // 1. tamper finalState in game.json
    const tampered = structuredClone(record);
    tampered.finalState.npcs.npc_a.hunger = 70;
    tampered.finalState.food.kitchen = 1; // conservation violation
    writeFileSync(join(episodeDir, 'game.json'), JSON.stringify(tampered));
    assert.equal(verifyMultiEpisode(episodeDir).ok, false);

    // 2. restore, then delete replay.json
    writeMultiEpisode(dir, record);
    rmSync(join(episodeDir, 'replay.json'));
    const v2 = verifyMultiEpisode(episodeDir);
    assert.equal(v2.ok, false);
    assert.ok(v2.issues.some(i => i.includes('replay.json missing')));

    // 3. restore, then make game.json an array root
    writeMultiEpisode(dir, record);
    writeFileSync(join(episodeDir, 'game.json'), '[]');
    const v3 = verifyMultiEpisode(episodeDir);
    assert.equal(v3.ok, false);
    assert.ok(v3.issues.some(i => i.includes('root')));
    assert.equal(v3.record, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fixture batch: 12 episodes, all pass, summary rebuilds from disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g03-batch-'));
  const batch = 'fixture-12';
  try {
    const result = await runG03Batch({ artifactsRoot: root, batch, mode: 'fixture' });
    assert.equal(result.exitCode, 0, result.message);
    assert.equal(result.batchDir, join(root, batch));
    const summary = summarizeMultiBatchDir(join(root, batch));
    assert.equal(summary.rows.length, 12);
    assert.equal(summary.totals.passed, 12);
    assert.equal(summary.totals.notRun, 0);
    assert.equal(summary.totals.interrupted, 0);
    assert.equal(summary.totals.totalChatRequests, 0); // reference policy: no HTTP transport
    // Total recorded decisions across all 12 episodes: (4+4+3) × 2 orders × 2 thinking = 44
    let totalTurns = 0;
    for (const scenarioId of MULTI_SCENARIO_IDS) {
      for (const order of ['ac', 'ca'] as const) {
        for (const thinking of [false, true]) {
          const id = episodeIdFor(scenarioId, order, thinking);
          const row = summary.rows.find(r => r.episodeId === id);
          assert.ok(row, `missing row ${id}`);
          assert.equal(row.pass, true, `${id} should pass`);
          assert.equal(row.valid, true, `${id} evidence should verify: ${row.issues.join('; ')}`);
          const { verifyMultiEpisode } = await import('../src/multi/record');
          const episode = verifyMultiEpisode(join(root, batch, 'episodes', id));
          assert.ok(episode.record !== null);
          totalTurns += episode.record.turns.length;
        }
      }
    }
    assert.equal(totalTurns, 44);
    // verify-only CLI path agrees
    const verify = verifyG03Batch(join(root, batch));
    assert.equal(verify.exitCode, 0, verify.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch directory collision is a precondition failure (exit 2)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g03-collide-'));
  try {
    mkdirSync(join(root, 'dup'), { recursive: true });
    const result = await runG03Batch({ artifactsRoot: root, batch: 'dup', mode: 'fixture' });
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
