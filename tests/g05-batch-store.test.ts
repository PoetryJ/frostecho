/**
 * G05-live workstream B — exclusive batch store and incremental persistence.
 *
 * Same batch name: second open fails without touching an old byte; two racing
 * opens yield exactly one store. Episodes are saved the moment they end (pass
 * or fail); a mid-run exit leaves the finished episodes and the attempt ledger
 * on disk, from which the summary is rebuilt; verification stays read-only.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BatchStoreError, NeedsBatchStore, readAttemptLedger } from '../src/needs/batch-store';
import { G05_SCENARIOS, runScenario } from '../src/needs/scenarios';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { verifyNeedsBatch } from '../src/needs/record';
import { rebuildSummary } from '../src/needs/eval';

const INIT = {
  mode: 'live' as const,
  matrixVersion: 'g05-r1-t123',
  chatBudget: { limit: 60 },
  requestDefaults: { model: 'm', temperature: 0, max_tokens: 1024, stream: false, enableThinking: true, timeoutMs: 120000, urlPresent: true },
};

function open(root: string, name: string, scenarios: readonly typeof G05_SCENARIOS[number][] = G05_SCENARIOS.slice(0, 2)): NeedsBatchStore {
  return NeedsBatchStore.open(root, name, { ...INIT, scenarios });
}

test('same batch name: second open fails and no old byte changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-store-'));
  try {
    const store = open(root, 'dup');
    writeFileSync(join(store.dir, 'sentinel.txt'), 'old evidence\n');
    const before = statSync(join(store.dir, 'plan.json')).mtimeMs;
    assert.throws(() => open(root, 'dup'), (err: unknown) => err instanceof BatchStoreError && err.code === 'exists');
    assert.equal(readFileSync(join(store.dir, 'sentinel.txt'), 'utf8'), 'old evidence\n');
    assert.equal(statSync(join(store.dir, 'plan.json')).mtimeMs, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two racing opens of one name: exactly one wins', () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-store-'));
  try {
    const tryOpen = (): { ok: true } | { ok: false; code: string } => {
      try {
        open(root, 'race');
        return { ok: true };
      } catch (err) {
        return { ok: false, code: (err as BatchStoreError).code };
      }
    };
    // Opening is synchronous here, but the mkdir exclusivity is the same guard
    // two processes would hit: exactly one store may exist per name.
    const results = [tryOpen(), tryOpen()];
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => !r.ok && r.code === 'exists').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the initial plan persists all 12 trajectories as not_run with the effective config', () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-store-'));
  try {
    const store = open(root, 'plan12', G05_SCENARIOS);
    const plan = JSON.parse(readFileSync(join(store.dir, 'plan.json'), 'utf8'));
    assert.equal(plan.schema, 'frostecho.g05.liveplan/1');
    assert.equal(plan.plannedScenarios.length, 12);
    assert.equal(plan.chatBudget.limit, 60);
    assert.equal(plan.requestDefaults.timeoutMs, 120000);
    assert.ok(plan.version.commit !== null || plan.version.sourceFingerprint.length > 0, 'source version is durable');
    assert.ok(!existsSync(join(store.dir, 'attempts')), 'no attempts exist yet');
    for (const entry of plan.plannedScenarios) {
      const trail = readdirSync(join(store.dir, 'plan-status', entry.scenarioId.replace(/\//g, '__'))).sort();
      assert.equal(trail.length, 1, `${entry.scenarioId} has exactly its initial status`);
      const status = JSON.parse(readFileSync(join(store.dir, 'plan-status', entry.scenarioId.replace(/\//g, '__'), trail[0]), 'utf8')) as { status: string };
      assert.equal(status.status, 'not_run', entry.scenarioId);
    }
    const batch = JSON.parse(readFileSync(join(store.dir, 'batch.json'), 'utf8')) as { episodes: string[]; notRun: string[] };
    assert.deepEqual(batch.episodes, []);
    assert.equal(batch.notRun.length, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('episodes are saved immediately, pass or fail; a failed episode never removes the finished ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-store-'));
  try {
    const store = open(root, 'episodes', [G05_SCENARIOS[0], G05_SCENARIOS[1]]);
    const first = await runScenario(G05_SCENARIOS[0], { providerFor: () => createReferenceProvider(), mode: 'reference' });
    store.saveEpisode(first.record);
    assert.ok(existsSync(join(store.dir, 'episodes', first.record.episodeId, 'game.json')), 'episode 1 saved at once');
    // A second episode with a bogus record body still persists verbatim.
    store.saveEpisode({ episodeId: 'g05-broken', schema: 'frostecho.g05.game/2', stopReason: 'interrupted', commands: [], events: [] } as never);
    assert.ok(existsSync(join(store.dir, 'episodes', 'g05-broken', 'game.json')));
    assert.equal(readdirSync(join(store.dir, 'episodes')).length, 2);
    // Write-once: saving the same episode again is refused.
    assert.throws(() => store.saveEpisode(first.record), BatchStoreError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mid-run exit: finished episodes and the attempt ledger survive; the summary rebuilds from disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-store-'));
  try {
    const store = open(root, 'crashy', [G05_SCENARIOS[0], G05_SCENARIOS[1]]);
    const first = await runScenario(G05_SCENARIOS[0], { providerFor: () => createReferenceProvider(), mode: 'reference' });
    store.saveEpisode(first.record);
    store.markScenarioStatus(G05_SCENARIOS[0].id, 'passed');
    store.beginAttempt({ attemptId: 'att-0001', seq: 1, episodeId: 'e', actorId: 'npc_a', cycle: 1, round: 1, at: new Date().toISOString(), requestConfig: { model: 'm', temperature: 0, max_tokens: 1024, stream: false, enableThinking: [true], timeoutMs: 1000 } });
    // No finishAttempt: the process "died" with the request in flight.
    const ledger = readAttemptLedger(store.dir);
    assert.equal(ledger.begins.length, 1);
    assert.equal(ledger.finishes.length, 0);
    const summary = rebuildSummary(store.dir, 'crashy', 'live', { limit: 60, spent: 1, blocked: 0 }, ['ca/t1/one-shot'], 1);
    assert.equal(summary.totals.episodes, 1);
    assert.equal(summary.totals.unresolvedAttempts, 1, 'a begin without a finish is unresolved, not zero');
    assert.equal(summary.totals.decisionAttempts >= 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify is read-only: repeated verification changes no byte', async () => {
  const root = mkdtempSync(join(tmpdir(), 'g05-store-'));
  const batchRoot = join(root, 'artifacts');
  try {
    const { runFixtureBatch } = await import('../src/needs/eval');
    await runFixtureBatch({ artifactsRoot: batchRoot, batchId: 'vread' });
    const dir = join(batchRoot, 'vread');
    const snap = (d: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (existsSync(p) && statSync(p).isFile()) out[name] = readFileSync(p, 'utf8');
        else Object.assign(out, snap(p));
      }
      return out;
    };
    const before = JSON.stringify(snap(dir));
    const first = verifyNeedsBatch(dir);
    const second = verifyNeedsBatch(dir);
    assert.equal(first.ok, true, first.issues.join('; '));
    assert.equal(second.ok, true, second.issues.join('; '));
    assert.equal(JSON.stringify(snap(dir)), before, 'verify touched nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
