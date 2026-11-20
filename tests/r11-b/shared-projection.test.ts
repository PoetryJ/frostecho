/**
 * R11-B point 3: ONE projection serves every front-end.
 *
 * The CLI, the web bridge (which drives the CLI), the data collector
 * (`captureStep`) and the four-day runner all decide through `runStep`. This
 * pins that the block the step bills is the block the renderer emits and the
 * block the encoder's envelope counts — measured on the shipped modules, not on
 * a copy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderRequest } from '../../src/r7/jev/render';
import { byteTokenCounter, renderMemoryBlock, sha256Of } from '../../src/r7/jev/token-budget';
import { runStep } from '../../src/r7/integration/step';
import { abstainScorer, shortageFixture } from './fixture';

function repoRoot(): string {
  const compiled = join(__dirname, '../../..');
  return existsSync(join(compiled, 'dist/src/r7/jev/render.js')) ? compiled : process.cwd();
}

test('the step, the renderer and the encoder envelope bill the same memory block', async () => {
  const { runtime } = shortageFixture('r11b-shared');
  const box: { request?: import('../../src/decision/contracts').ChoiceRequest } = {};
  const result = await runStep(runtime, abstainScorer(box), {
    actorIds: ['npc_01'], memoryTokenBudget: 640,
  });
  const record = result.records[0];
  const request = box.request!;
  const rendered = renderRequest(request);
  const segment = rendered.segments.find(entry => entry.kind === 'memory')!;
  const block = segment.text.replace(/^\n记忆:\n/, '');

  assert.equal(block, renderMemoryBlock(request.memoryFacts));
  assert.equal(record.memoryBlockSha256, sha256Of(block));
  assert.equal(record.memorySegmentSha256, sha256Of(segment.text));
  assert.equal(record.memoryBytes, Buffer.byteLength(block, 'utf8'));
  assert.equal(record.memorySegmentBytes, Buffer.byteLength(segment.text, 'utf8'));
  assert.equal(record.memoryTokens, byteTokenCounter.count(block));

  // The compiled collector path (`tests/r10-b/capture.ts`, used by the data
  // collection scripts) reads the same envelope builder the service uses.
  const dist = require(join(repoRoot(), 'dist/src/r7/jev/scorer-client.js')) as {
    buildEnvelope: (request: unknown, counter?: unknown) => { tokens: {
      counterId: string; memory: number } } };
  const envelope = dist.buildEnvelope(request);
  assert.equal(envelope.tokens.counterId, record.memoryCounterId);
  assert.equal(envelope.tokens.memory, record.memoryTokens);
});

test('two steps on the same state bill the same bytes (reproducible input)', async () => {
  const { runtime } = shortageFixture('r11b-repeat');
  const first = await runStep(runtime, abstainScorer(), { actorIds: ['npc_01'],
    memoryTokenBudget: 640 });
  const second = await runStep(runtime, abstainScorer(), { actorIds: ['npc_01'],
    memoryTokenBudget: 640 });
  assert.equal(first.records[0].memoryBlockSha256, second.records[0].memoryBlockSha256);
  assert.equal(first.records[0].memorySegmentSha256, second.records[0].memorySegmentSha256);
  assert.equal(first.records[0].memoryBytes, second.records[0].memoryBytes);
  assert.equal(first.records[0].memoryTokens, second.records[0].memoryTokens);
});
