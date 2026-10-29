import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Engine, initialWorld } from '../src';
import {
  DEFAULT_LIVE_ARTIFACT_DIR, LIVE_RUN_COUNT, createReferenceProvider, liveArtifactDir, liveExitCode, liveTimeoutMs,
  replayMatches, runAgent, summarizeLiveDir, writeLiveRun,
} from '../src/agent';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-record-'));
}

test('live artifact defaults and timeout override stay optional', () => {
  assert.equal(LIVE_RUN_COUNT, 3);
  assert.equal(DEFAULT_LIVE_ARTIFACT_DIR, 'artifacts/g01-live');
  assert.equal(liveArtifactDir({}), 'artifacts/g01-live');
  assert.equal(liveArtifactDir({ FROSTECHO_LIVE_ARTIFACT_DIR: '   ' }), 'artifacts/g01-live');
  assert.equal(liveArtifactDir({ FROSTECHO_LIVE_ARTIFACT_DIR: 'custom/out' }), 'custom/out');
  assert.equal(liveTimeoutMs({}, 15000), 15000);
  assert.equal(liveTimeoutMs({ FROSTECHO_LIVE_TIMEOUT_MS: '250' }, 15000), 250);
  assert.equal(liveTimeoutMs({ FROSTECHO_LIVE_TIMEOUT_MS: '0' }, 15000), 15000);
  assert.equal(liveTimeoutMs({ FROSTECHO_LIVE_TIMEOUT_MS: 'nope' }, 15000), 15000);
});

test('summary is regenerated from step records and drops secrets', async () => {
  const result = await runAgent({
    world: new Engine(initialWorld()),
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'record-1',
    now: () => 0,
  });
  assert.equal(replayMatches(result), true);
  const dir = tempDir();
  const secret = 'sekret-xyz';
  const url = 'http://127.0.0.1:9/v1/chat/completions';
  const tainted = structuredClone(result);
  tainted.error = `failed ${secret} via ${url}`;
  tainted.steps = tainted.steps.map(step => ({ ...step, raw: `${step.raw} ${secret}` }));
  for (let i = 1; i <= 3; i++) {
    const copy = structuredClone(tainted);
    copy.runId = `record-${i}`;
    writeLiveRun(dir, i, copy, { model: 'live-model', apiKeyPresent: true, timeoutMs: 15000, secrets: [secret, url] });
  }
  const summary = summarizeLiveDir(dir);
  assert.equal(liveExitCode(summary), 0);
  const steps = JSON.parse(readFileSync(join(dir, 'run-1', 'steps.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(dir, 'run-1', 'meta.json'), 'utf8'));
  const onDisk = readFileSync(join(dir, 'summary.json'), 'utf8') + readFileSync(join(dir, 'run-1', 'steps.json'), 'utf8') + readFileSync(join(dir, 'run-1', 'meta.json'), 'utf8');
  assert.equal(onDisk.includes(secret), false);
  assert.equal(onDisk.includes(url), false);
  assert.match(onDisk, /\[redacted\]/);
  assert.equal(meta.apiKey, 'present');
  assert.equal(meta.model, 'live-model');
  assert.deepEqual(summary.runs[0].raw, steps.map((step: { raw: string }) => step.raw));
  assert.equal(summary.runs[0].stepCount, steps.length);
  assert.deepEqual(summary.runs[0].sampling, meta.sampling);
  assert.equal(summary.requestCount, 6);

  steps[0].raw = '{"type":"stop"}';
  writeFileSync(join(dir, 'run-1', 'steps.json'), JSON.stringify(steps, null, 2) + '\n');
  const reread = summarizeLiveDir(dir);
  assert.equal(reread.runs[0].raw[0], '{"type":"stop"}');
  assert.equal(reread.runs[0].stepCount, steps.length);
  assert.notEqual(reread.runs[0].raw[0], tainted.steps[0].raw);

  const finalState = JSON.parse(readFileSync(join(dir, 'run-2', 'final-state.json'), 'utf8'));
  finalState.npcs.npc_a.hunger = 0;
  writeFileSync(join(dir, 'run-2', 'final-state.json'), JSON.stringify(finalState, null, 2) + '\n');
  const broken = summarizeLiveDir(dir);
  assert.equal(broken.runs[1].replayMatches, false);
  assert.equal(broken.runs[1].finalHunger, 0);
  assert.equal(liveExitCode(broken), 1);

  const replayFile = JSON.parse(readFileSync(join(dir, 'run-3', 'replay.json'), 'utf8'));
  replayFile.matches = false;
  writeFileSync(join(dir, 'run-3', 'replay.json'), JSON.stringify(replayFile) + '\n');
  const flagged = summarizeLiveDir(dir);
  assert.equal(flagged.runs[2].replayMatches, false);
  assert.equal(liveExitCode(flagged), 1);
  assert.equal(liveExitCode({ ...flagged, runs: [] }), 1);
});

test('summary recomputes the goal and rejects metadata that disagrees with the records', async () => {
  const result = await runAgent({
    world: new Engine(initialWorld()),
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'audit-1',
    now: () => 0,
  });
  const dir = tempDir();
  writeLiveRun(dir, 1, result, { model: 'live-model', apiKeyPresent: false, timeoutMs: 15000, secrets: [] });
  writeLiveRun(dir, 2, result, { model: 'live-model', apiKeyPresent: false, timeoutMs: 15000, secrets: [] });
  writeLiveRun(dir, 3, result, { model: 'live-model', apiKeyPresent: false, timeoutMs: 15000, secrets: [] });

  const metaPath = join(dir, 'run-1', 'meta.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.goalReached = false;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  const recomputed = summarizeLiveDir(dir);
  assert.equal(recomputed.runs[0].goalReached, true);
  assert.equal(recomputed.runs[0].computedGoalReached, true);
  assert.equal(recomputed.runs[0].finalHunger, 70);
  assert.equal(recomputed.runs[0].metadataMismatch, true);
  assert.match(recomputed.runs[0].metadataError ?? '', /goalReached/);
  assert.equal(recomputed.metadataMismatch, true);
  assert.equal(liveExitCode(recomputed), 1);

  meta.goalReached = true;
  meta.providerCalls = 99;
  meta.requestStats.providerCalls = 99;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  const calls = summarizeLiveDir(dir);
  const steps = JSON.parse(readFileSync(join(dir, 'run-1', 'steps.json'), 'utf8'));
  assert.equal(calls.runs[0].providerCalls, steps.length);
  assert.equal(calls.runs[0].computedProviderCalls, steps.length);
  assert.notEqual(calls.runs[0].providerCalls, 99);
  assert.equal(calls.requestCount, steps.length + 2 + 2);
  assert.match(calls.error ?? '', /providerCalls/);
  assert.equal(liveExitCode(calls), 1);
});
