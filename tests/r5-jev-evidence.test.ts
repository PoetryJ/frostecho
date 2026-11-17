/**
 * R5: the TS shadow bridge must not accept empty/reused/mis-bound evidence as
 * real. Every path keeps selectedId=null (zero world execution).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJevShadowAdapter, type JevPolicyManifest } from
  '../src/decision/jev-shadow-adapter';
import { buildPlanningRequest, type PlanningView } from '../src/planning/candidates';

function request() {
  const view: PlanningView = {
    actorId: 'npc_a',
    npcs: [{ id: 'npc_a', hunger: 30, stamina: 60, health: 100, san: 70, alive: true }],
    resources: { food: 3, firewood: 3, power: 30, medicine: 1 },
    furnace: { lit: true, fuel: 40, warmth: 18 },
    weather: 'snow',
  };
  return buildPlanningRequest({ view, promises: [], stateVersion: 4,
    requestId: 'r5-evidence', memorySnapshotHash: 'h', memoryPolicyVersion: 'memory-policy/1' });
}

const BASE = {
  model: 'fixture/r5', head: 'shared-scalar/1', adapter: 'jev-choice/1',
  tokenizer: 'fixture-tok/1', renderer: 'jev04-render/3',
};

function ref(path: string) {
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

function write(root: string, name: string, payload: Record<string, unknown>): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function manifestWith(root: string, protocol: string, partition: string): JevPolicyManifest {
  const req = request();
  const policy = {
    model: BASE.model, head: BASE.head, tokenizer: BASE.tokenizer,
    renderer: BASE.renderer, task: req.task, k: req.candidates.length,
    memory_policy_version: req.memoryPolicyVersion ?? 'memory-policy/1',
  };
  const payload = (name: string) => ({
    schema: 'frostecho.jev04.evidence/1', partition,
    protocol_version: protocol, valid: true, policy,
    sampleIds: [`${name}-1`, `${name}-2`, `${name}-3`],
    ...(name === 'cert' ? { upper: 0.02, n: 120 } : {}),
    ...(name === 'calT' ? { temperature: 1.1, tau: 0.8 } : {}),
    ...(name === 'select' ? { tau: 0.8, accepted: 120 } : {}),
  });
  const paths: Record<string, unknown> = {};
  for (const name of ['calT', 'select', 'cert']) {
    paths[name] = ref(write(root, `${name}.json`, payload(name)));
  }
  return {
    schema: 'frostecho.jev04.policy-manifest/1',
    registrations: [{
      ...BASE, task: req.task, K: req.candidates.length,
      policy: 'softmax-accept/1', memoryPolicy: 'memory-policy/1',
      evidence: { ...paths, protocolVersion: protocol, sealed: true },
    }],
  };
}

const identity = { kind: 'real-model' as const, ...BASE };
const predict = () => [{ candidateId: 'c-eat', logit: 4, probability: 0.9 }];

test('R5-J1: empty evidence files are shadow-only, never real', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-jev-'));
  try {
    const req = request();
    const path = write(dir, 'empty.json', {});
    const manifest: JevPolicyManifest = {
      schema: 'frostecho.jev04.policy-manifest/1',
      registrations: [{
        ...BASE, task: req.task, K: req.candidates.length,
        policy: 'softmax-accept/1', memoryPolicy: 'memory-policy/1',
        evidence: { calT: ref(path), select: ref(path), cert: ref(path),
          protocolVersion: 'jev04-risk/1', sealed: true },
      }],
    };
    const adapter = createJevShadowAdapter({ manifest, identity, predict });
    const result = await adapter.score(req);
    assert.equal(result.selectedId, null);
    assert.match(result.reason, /shadow_only_no_sealed_evidence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-J2: a reused calT/select/cert partition is not sealed evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-jev-'));
  try {
    const manifest = manifestWith(dir, 'jev04-risk/1', 'calT');
    const adapter = createJevShadowAdapter({ manifest, identity, predict });
    const result = await adapter.score(request());
    assert.equal(result.selectedId, null);
    assert.match(result.reason, /shadow_only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-J3: a wrong risk protocol is not sealed evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-jev-'));
  try {
    const manifest = manifestWith(dir, 'other/1', 'calT');
    const adapter = createJevShadowAdapter({ manifest, identity, predict });
    const result = await adapter.score(request());
    assert.equal(result.selectedId, null);
    assert.match(result.reason, /shadow_only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-J4: a fixture artifact with a real registration is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-jev-'));
  try {
    const manifest = manifestWith(dir, 'jev04-risk/1', 'calT');
    const adapter = createJevShadowAdapter({ manifest,
      identity: { ...identity, kind: 'fixture' }, predict });
    const result = await adapter.score(request());
    assert.equal(result.disposition, 'unavailable');
    assert.match(result.reason, /fixture_artifact_may_not_pose_as_real/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-J5: a non-finite logit keeps the bridge at selectedId=null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-jev-'));
  try {
    const manifest = manifestWith(dir, 'jev04-risk/1', 'calT');
    const adapter = createJevShadowAdapter({ manifest, identity,
      predict: () => [{ candidateId: 'c-eat', logit: Number.POSITIVE_INFINITY }] });
    const result = await adapter.score(request());
    assert.equal(result.disposition, 'unavailable');
    assert.equal(result.selectedId, null);
    assert.match(result.reason, /nonfinite_logit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
