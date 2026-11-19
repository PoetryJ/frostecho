/**
 * R10-B point 1: ONE counter for both memory arms AND for the encoder.
 *
 * Before this, the 640-token budget was charged with a private per-character
 * heuristic against a hand-copied fact line, so the budget and the bytes the
 * model received were different quantities. Here both arms are billed by the
 * same injectable counter, on the block the renderer really emits, and the
 * encoder reports the same number from the same counter.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byteTokenCounter, renderMemoryLine } from '../../src/r7/jev/token-budget';
import { budgetFixture, captureStep, distModules, sha256 }
  from './capture';

/** The memory segment text of a rendered request, without its `记忆:` header. */
function segmentBlock(segments: { kind: string; text: string }[]): string {
  const segment = segments.find(entry => entry.kind === 'memory');
  return segment ? segment.text.replace(/^\n记忆:\n/, '') : '';
}

test('both memory arms are billed by the same counter and stay inside 640', async () => {
  const fixture = budgetFixture();
  const raw = await captureStep(fixture.runtime,
    { actorId: 'npc_01', memorySelection: 'raw-last12' });
  const ranked = await captureStep(fixture.runtime,
    { actorId: 'npc_01', memorySelection: 'obligation-first' });

  // 1. Same budget, same caliber, both sides under the ceiling.
  assert.equal(raw.capture.budget.memoryBudget, 640);
  assert.equal(ranked.capture.budget.memoryBudget, 640);
  assert.equal(raw.capture.budget.counterId, byteTokenCounter.id);
  assert.equal(ranked.capture.budget.counterId, byteTokenCounter.id);
  assert.ok(raw.capture.budget.memoryTokens <= 640,
    `raw arm billed ${raw.capture.budget.memoryTokens}`);
  assert.ok(ranked.capture.budget.memoryTokens <= 640,
    `ranked arm billed ${ranked.capture.budget.memoryTokens}`);

  for (const arm of [raw, ranked]) {
    // 2. The billed number is the counter applied to the exact bytes the model
    //    reads, not to a paraphrase of them.
    assert.equal(arm.capture.budget.memoryTokens,
      byteTokenCounter.count(arm.capture.memoryBlock));
    assert.equal(arm.capture.memoryBlock, segmentBlock(arm.capture.segments));
    // 3. The encoder uses the same counter: its number equals the budget's.
    assert.equal(arm.capture.envelope.tokens.counterId, byteTokenCounter.id);
    assert.equal(arm.capture.envelope.tokens.memory, arm.capture.budget.memoryTokens);
    assert.equal(arm.capture.envelope.tokens.memoryFacts,
      arm.capture.request.memoryFacts.length);
    // 4. The captured text is the built renderer's text, not a re-implementation.
    assert.equal(sha256(arm.capture.text), arm.capture.renderSha256);
    assert.equal(arm.capture.envelope.renderedTextSha256, arm.capture.renderSha256);
  }

  // 5. Equal counts are NOT expected: the arms select different records and
  //    records differ in size. This is the design, not a regression.
  assert.notEqual(raw.capture.budget.kept, ranked.capture.budget.kept);

  // 6. The caliber really changed: the previous heuristic (one token per CJK
  //    character, a quarter per other character, applied to a hand-written copy
  //    of the line) is a DIFFERENT number from the bytes the model receives.
  const legacy = (text: string): number => {
    let tokens = 0;
    for (const char of text) tokens += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.25;
    return Math.ceil(tokens);
  };
  for (const arm of [raw, ranked])
    assert.notEqual(legacy(arm.capture.memoryBlock),
      byteTokenCounter.count(arm.capture.memoryBlock),
      'the old caliber must not coincide with the measured bytes');
});

test('the counter is replaceable and both sides follow the replacement', async () => {
  const fixture = budgetFixture();
  const doubled = { id: 'test/utf8-bytes-x2', count: (text: string) => 2 * byteTokenCounter.count(text) };
  const swapped = await captureStep(fixture.runtime,
    { actorId: 'npc_01', memorySelection: 'raw-last12', tokenCounter: doubled });
  assert.equal(swapped.capture.budget.counterId, doubled.id);
  assert.ok(swapped.capture.budget.memoryTokens <= 640);
  assert.equal(swapped.capture.budget.memoryTokens, doubled.count(swapped.capture.memoryBlock));
  const dist = distModules();
  const envelope = dist.buildEnvelope(swapped.capture.request, doubled) as {
    tokens: { counterId: string; memory: number } };
  assert.equal(envelope.tokens.counterId, 'test/utf8-bytes-x2');
  assert.equal(envelope.tokens.memory, swapped.capture.budget.memoryTokens);
  // Same request, default counter: half the bytes per token, so the naive
  // default would have accepted text the doubled counter rejects as over budget.
  const plain = dist.buildEnvelope(swapped.capture.request) as { tokens: { memory: number } };
  assert.notEqual(plain.tokens.memory, envelope.tokens.memory);
  assert.ok(swapped.capture.budget.memoryTokens <= 640
    && plain.tokens.memory * 2 >= swapped.capture.budget.memoryTokens);
});
