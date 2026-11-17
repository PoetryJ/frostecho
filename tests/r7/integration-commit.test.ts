import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeChoiceResult } from '../../src/decision/contracts';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { runStep } from '../../src/r7/integration/step';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';

test('queued R8 work revoked before start never invokes the scorer', async () => {
  const runtime = R8Runtime.create({ seed: 'queued-revocation' });
  const actor = runtime.context().actorIds[0];
  const captured = runtime.session.generationFor(actor);
  runtime.session.playerCancel(actor);
  let called = 0;
  const reference = referenceAgencyScorer();
  const result = await runStep(runtime, { identity: reference.identity, score: request => {
    called++; return reference.score(request);
  } }, { actorIds: [actor], expectedGenerations: { [actor]: captured } });
  assert.equal(called, 0);
  assert.equal(result.executed, 0);
  assert.equal(result.records[0].reason, 'generation_changed_before_start');
});

test('new visible information without a world version change invalidates an in-flight score', async () => {
  const runtime = R8Runtime.create({ seed: 'information-revocation' });
  const actor = runtime.context().actorIds[0];
  const reference = referenceAgencyScorer();
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const resultPromise = runStep(runtime, { identity: reference.identity, score: async request => {
    ready(); await new Promise<void>(resolve => { release = resolve; });
    return reference.score(request);
  } }, { actorIds: [actor] });
  await started;
  const version = runtime.world.version;
  runtime.session.ingestTeamEvent('test-new-information', { foodSource: 'changed' }, runtime.world.simTime);
  assert.equal(runtime.world.version, version);
  release();
  const result = await resultPromise;
  assert.equal(result.executed, 0);
  assert.equal(runtime.world.version, version);
  assert.equal(result.records[0].executionStatus, 'stale');
  assert.equal(result.records[0].inputSha256?.length, 64);
});

test('repeated abstentions have distinct persisted input identities without advancing the world', async () => {
  const runtime = R8Runtime.create({ seed: 'abstention-ids' });
  const actor = runtime.context().actorIds[0];
  const reference = referenceAgencyScorer();
  const scorer = { identity: reference.identity, score: (request: Parameters<typeof makeChoiceResult>[0]['request']) =>
    makeChoiceResult({ request, scorerId: 'test-abstain', disposition: 'abstain',
      reason: 'no decision', selectedId: null, scores: [] }) };
  const first = await runStep(runtime, scorer, { actorIds: [actor] });
  const second = await runStep(runtime, scorer, { actorIds: [actor] });
  assert.notEqual(first.records[0].requestId, second.records[0].requestId);
  assert.equal(first.executed + second.executed, 0);
  assert.equal(runtime.world.version, 0);
});
