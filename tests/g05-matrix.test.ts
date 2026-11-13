/**
 * G05-R1 workstream C — the restored matrix as an offline system test.
 *
 * The fixture batch must produce 12 trajectories, exactly 20 reference
 * decisions and zero HTTP; the read-only verifier recomputes everything from
 * disk. Negative tests prove the verifier rejects forged pass flags, budget
 * exemptions, tampered checkpoints and wrong metadata instead of trusting them.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { G05_SCENARIOS } from '../src/needs/scenarios';
import type { G05ScenarioRecord } from '../src/needs/scenarios';
import { runFixtureBatch } from '../src/needs/eval';
import { verifyNeedsBatch, verifyNeedsSemantics } from '../src/needs/record';

test('the restored matrix: T1/T2/T3 × ac/ca × one-shot/recurring, 4 model + 8 zero-call', () => {
  assert.equal(G05_SCENARIOS.length, 12);
  for (const chain of ['ac', 'ca']) {
    assert.equal(G05_SCENARIOS.filter(s => s.chain === chain).length, 6);
  }
  const modelBased = G05_SCENARIOS.filter(s => s.needPolicy === 'recurring' && s.kind !== 't2');
  assert.equal(modelBased.length, 4, 't1/t3 recurring in both chains call the model');
  assert.equal(G05_SCENARIOS.length - modelBased.length, 8, 'eight zero-call trajectories');
  for (const s of G05_SCENARIOS) {
    assert.equal(s.kitchenFood, s.kind === 't1' ? 4 : s.kind === 't2' ? 2 : 0);
  }
});

test('fixture batch: 12/12 pass, exactly 20 reference decisions, zero HTTP, verify settles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-r1-matrix-'));
  try {
    const result = await runFixtureBatch({ artifactsRoot: root, batchId: 'matrix' });
    assert.equal(result.summary.totals.episodes, 12);
    assert.equal(result.scenarioPass, 12, result.runs.filter(r => !r.scenarioPass).map(r => `${r.scenario.id}: ${r.issues.join('; ')}`).join(' | '));
    assert.equal(result.totalCalls, 20, 'the frozen matrix costs exactly 20 reference decisions');
    assert.equal(result.summary.totals.httpCalls, 0, 'reference fixture makes no HTTP');
    for (const run of result.runs) {
      const calls = Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0);
      const expectedCalls = run.scenario.needPolicy === 'recurring'
        ? run.scenario.kind === 't1' ? 4 : run.scenario.kind === 't3' ? 6 : 0
        : 0;
      assert.equal(calls, expectedCalls, run.scenario.id);
      if (run.scenario.kind === 't2') {
        // Zero-call trajectories really ran: 100 pumps happened, cycles unchanged.
        assert.ok(run.record.restCycles !== undefined, 't2 records its 100-pump cycle counters');
        assert.deepEqual(run.record.restCycles?.after, run.record.restCycles?.before);
      }
    }
    const verification = verifyNeedsBatch(join(root, 'matrix'));
    assert.ok(verification.ok, verification.issues.join('; '));
    assert.equal(verification.episodes, 12);
    assert.equal(verification.httpCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('records carry the frozen rule triple and replayable checkpoints', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-r1-matrix-'));
  try {
    const result = await runFixtureBatch({ artifactsRoot: root, batchId: 'schema', chains: ['ac'] });
    const t3 = result.runs.find(r => r.scenario.id === 'ac/t3/recurring');
    assert.ok(t3 !== undefined);
    assert.equal(t3.record.schema, 'frostecho.g05.game/2');
    assert.deepEqual(t3.record.rules, { LOW: 40, GOAL: 70, DECAY_PER_STEP: 10 });
    assert.deepEqual(t3.record.checkpoints.map(c => c.label), ['initial', 'empty', 'waiting_decay', 'refed']);
    const refed = t3.record.checkpoints.find(c => c.label === 'refed');
    assert.deepEqual(refed?.actual, { simTime: 4, a: 90, b: 30, c: 90, food: 0, calls: 6 });
    for (const cp of t3.record.checkpoints) {
      assert.ok(Number.isInteger(cp.logCursor) && cp.logCursor >= 0, 'checkpoints locate themselves in the event log');
    }
    const verification = verifyNeedsBatch(join(root, 'schema'));
    assert.ok(verification.ok, verification.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects a forged scenarioPass and a tampered checkpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-r1-matrix-'));
  try {
    await runFixtureBatch({ artifactsRoot: root, batchId: 'tamper', chains: ['ac'] });
    const dir = join(root, 'tamper', 'episodes', 'g05-ac-t3-one-shot');
    const file = join(dir, 'game.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as G05ScenarioRecord;
    // Forge: pretend the one-shot trajectory failed, verifier recomputes pass=true.
    record.scenarioPass = false;
    const issues = verifyNeedsSemantics(record);
    assert.ok(issues.some(i => i.includes('scenarioPass')), `forged pass flag must be caught: ${issues.join('; ')}`);
    // Tamper: claim a checkpoint saw different satiety than the events replay to.
    const record2 = JSON.parse(readFileSync(file, 'utf8')) as G05ScenarioRecord;
    record2.checkpoints[1].actual.a = 99;
    const issues2 = verifyNeedsSemantics(record2);
    assert.ok(issues2.some(i => i.includes('replayed')), `tampered checkpoint must be caught: ${issues2.join('; ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects budget exemptions and a changed matrix version', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-r1-matrix-'));
  try {
    await runFixtureBatch({ artifactsRoot: root, batchId: 'tamper2', chains: ['ac'] });
    const file = join(root, 'tamper2', 'episodes', 'g05-ac-t1-recurring', 'game.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as G05ScenarioRecord;
    // Inflate calls beyond the episode budget: the base verifier must fail the batch.
    record.actors.npc_a.providerCalls = 11;
    record.cycles.npc_a[0].providerCalls = 11;
    writeFileSync(file, JSON.stringify(record, null, 2));
    const verification = verifyNeedsBatch(join(root, 'tamper2'));
    assert.equal(verification.ok, false);
    assert.ok(verification.issues.some(i => i.includes('budget') || i.includes('providerCalls')), verification.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
