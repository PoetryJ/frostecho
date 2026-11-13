/**
 * R3 (M): trusted-policy gate negatives on the TS shadow path.
 * The fake `real` artifact from the audit repro (identity agreeing with the
 * request on every field) must be refused; fixture must never pose as real.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJevShadowAdapter, loadJevPolicyManifest,
  type JevPolicyManifest } from '../src/decision/jev-shadow-adapter';
import { buildPlanningRequest, type PlanningView } from '../src/planning/candidates';

function view(): PlanningView {
  return {
    actorId: 'npc_a',
    npcs: [{ id: 'npc_a', hunger: 30, stamina: 60, health: 100, san: 70, alive: true }],
    resources: { food: 3, firewood: 3, power: 30, medicine: 1 },
    furnace: { lit: true, fuel: 40, warmth: 18 },
    weather: 'snow',
  };
}

const BASE_REQUEST = buildPlanningRequest({
  view: view(),
  promises: [],
  stateVersion: 4,
  requestId: 'req-r3-gate',
  memorySnapshotHash: 'hash-1',
  memoryPolicyVersion: 'memory-policy/1',
});

function request() {
  return BASE_REQUEST;
}

function manifest(overrides: Record<string, unknown> = {}): JevPolicyManifest {
  return {
    schema: 'frostecho.jev04.policy-manifest/1',
    registrations: [{
      model: 'fixture/r3', head: 'shared-scalar/1', adapter: 'jev-choice/1',
      tokenizer: 'fixture-tok/1', renderer: 'jev04-render/3',
      task: BASE_REQUEST.task, K: BASE_REQUEST.candidates.length,
      policy: 'softmax-accept/1', memoryPolicy: 'memory-policy/1',
      ...overrides,
    }],
  };
}

const identity = {
  kind: 'recorded-logits' as const,
  model: 'fixture/r3', head: 'shared-scalar/1', adapter: 'jev-choice/1',
  tokenizer: 'fixture-tok/1', renderer: 'jev04-render/3',
};

test('R3-M1: unregistered identity fails closed even when self-consistent', async () => {
  // Audit repro shape: artifact and request agree on every field, but the
  // identity was never registered in the trusted manifest.
  const rogue = { ...identity, model: 'rogue/self-consistent' };
  const adapter = createJevShadowAdapter({ manifest: manifest(), identity: rogue });
  const result = await adapter.score(request());
  assert.equal(result.disposition, 'unavailable');
  assert.match(result.reason, /policy_not_registered/);
});

test('R3-M2: task/K/memoryPolicy drift is refused', async () => {
  const drifted = manifest();
  drifted.registrations[0].K = 9;
  const adapter = createJevShadowAdapter({ manifest: drifted, identity });
  const result = await adapter.score(request());
  assert.equal(result.disposition, 'unavailable');
  assert.match(result.reason, /identity_drift.*K drift/);
});

test('R3-M3: non-finite logits fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-gate-'));
  try {
    const logitsFile = join(dir, 'logits.json');
    writeFileSync(logitsFile, JSON.stringify({
      note: 'recorded logits; fake encoder wiring; no real model',
      logits: [{ candidateId: 'c-eat', logit: Number.NaN }],
    }));
    const adapter = createJevShadowAdapter({ manifest: manifest(), identity,
      logitsFile });
    const result = await adapter.score(request());
    assert.equal(result.disposition, 'unavailable');
    assert.match(result.reason, /nonfinite_logit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-M4: recorded-logits success is shadow-only with the source labelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-gate-'));
  try {
    const logitsFile = join(dir, 'logits.json');
    writeFileSync(logitsFile, JSON.stringify({
      note: 'recorded logits; fake encoder wiring; no real model',
      logits: [{ candidateId: 'c-eat', logit: 2.5, probability: 0.9 }],
    }));
    const adapter = createJevShadowAdapter({ manifest: manifest(), identity,
      logitsFile });
    const result = await adapter.score(request());
    assert.equal(result.disposition, 'abstain');
    assert.equal(result.selectedId, null);
    assert.match(result.reason, /shadow_only_recorded_logits.*fake encoder wiring/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-M5: fixture artifact may never pose as the model line', async () => {
  const adapter = createJevShadowAdapter({
    manifest: manifest(),
    identity: { ...identity, kind: 'fixture' },
  });
  const result = await adapter.score(request());
  assert.equal(result.disposition, 'unavailable');
  assert.match(result.reason, /fixture_artifact_may_not_pose_as_real/);
});

test('R3-M6: logits file must label its fake wiring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-gate-'));
  try {
    const logitsFile = join(dir, 'logits.json');
    writeFileSync(logitsFile, JSON.stringify({
      note: 'totally real model output',
      logits: [],
    }));
    assert.throws(() => createJevShadowAdapter({ manifest: manifest(), identity,
      logitsFile }), /recorded fake wiring/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-M7: manifest loader rejects foreign schemas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-gate-'));
  try {
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify({ schema: 'other/1', registrations: [] }));
    assert.throws(() => loadJevPolicyManifest(path), /unsupported manifest schema/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
