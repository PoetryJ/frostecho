/**
 * G05 workstream C — the official 12-trajectory matrix as an offline system
 * test: run the fixture batch into a temp directory, judge every trajectory,
 * then settle the same batch read-only through verifyNeedsBatch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { G05_SCENARIOS } from '../src/needs/scenarios';
import { runFixtureBatch } from '../src/needs/eval';
import { verifyNeedsBatch } from '../src/needs/record';

test('the G05 matrix is 12 trajectories: two chains of six, four model-based and eight zero-call', () => {
  assert.equal(G05_SCENARIOS.length, 12);
  const byChain = { ac: G05_SCENARIOS.filter(s => s.chain === 'ac'), ca: G05_SCENARIOS.filter(s => s.chain === 'ca') };
  assert.equal(byChain.ac.length, 6);
  assert.equal(byChain.ca.length, 6);
  const modelBased = G05_SCENARIOS.filter(s => s.expected.totalCalls > 0);
  const zeroCall = G05_SCENARIOS.filter(s => s.expected.totalCalls === 0);
  assert.equal(modelBased.length, 4, 'exactly four trajectories need the model');
  assert.equal(zeroCall.length, 8, 'eight trajectories must finish with zero calls');
  for (const s of G05_SCENARIOS) {
    assert.ok(s.steps.at(-1)?.kind !== 'run' || s.expected.totalCalls > 0, `${s.id}: run step implies model calls`);
    assert.ok(s.steps.some(st => st.kind === 'run') || s.expected.totalCalls === 0, `${s.id}: no run step implies zero calls`);
  }
});

test('fixture batch: every trajectory passes and settles read-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-matrix-'));
  try {
    const batchId = 'matrix-test';
    const result = await runFixtureBatch({ artifactsRoot: root, batchId });
    assert.equal(result.summary.totals.episodes, 12);
    assert.equal(result.scenarioPass, 12, result.runs.filter(r => !r.scenarioPass).map(r => `${r.scenario.id}: ${r.issues.join('; ')}`).join(' | '));
    assert.equal(result.totalCalls, 28, 'the matrix costs exactly 28 reference decisions');
    // Zero-call trajectories stayed at zero; model-based ones spent their plan.
    for (const run of result.runs) {
      const calls = Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0);
      assert.equal(calls, run.scenario.expected.totalCalls, run.scenario.id);
    }
    const verification = verifyNeedsBatch(join(root, batchId));
    assert.ok(verification.ok, verification.issues.join('; '));
    assert.equal(verification.episodes, 12);
    assert.equal(verification.httpCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('G05 records carry the need ledger and the g05 schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-matrix-'));
  try {
    const result = await runFixtureBatch({ artifactsRoot: root, batchId: 'schema-test', chains: ['ac'] });
    const expired = result.runs.find(r => r.scenario.id === 'ac/recurring-need-expired');
    assert.ok(expired !== undefined);
    assert.equal(expired.record.schema, 'frostecho.g05.game/1');
    assert.equal(expired.record.needPolicy, 'recurring');
    assert.deepEqual(expired.record.needs?.map(n => [n.actorId, n.period, n.outcome, n.decisionsUsed]), [['npc_a', 1, 'expired', 10]]);
    const loop = result.runs.find(r => r.scenario.id === 'ac/oneshot-feed-loop');
    assert.ok(loop !== undefined);
    assert.equal(loop.record.needPolicy, 'one-shot');
    assert.deepEqual(loop.record.needs?.map(n => [n.actorId, n.period, n.outcome]), [['npc_a', 1, 'satisfied']]);
    assert.ok(loop.record.cycles.npc_a.some(c => (c.reason ?? '').startsWith('need cycle')), 'need cycle recorded with its reason');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
