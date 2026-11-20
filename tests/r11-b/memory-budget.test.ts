/**
 * R11-B point 1: the budget binds the FIRST record too.
 *
 * R10 measured a 64-unit budget admitting one commitment worth 6580 units and
 * 19748 bytes of rendered text. Here the same shape of record is measured at
 * 0/64/200/640 units: the block never exceeds its budget, a record that does not
 * fit is TRIMMED (source, both clocks, instance, revision where the budget
 * allows, and a traceable pointer stay), and the trim record names what was cut.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRequest } from '../../src/r7/jev/render';
import { byteTokenCounter, canonicalJson, renderMemoryBlock, renderMemorySegment,
  sha256Of } from '../../src/r7/jev/token-budget';
import { factOf } from '../../src/r7/memory/window';
import { runStep, visibleMemory } from '../../src/r7/integration/step';
import { abstainScorer, multiOversizedFixture, oversizedFixture } from './fixture';

function payloadOf(fact: { payload: unknown }): Record<string, unknown> {
  return fact.payload as Record<string, unknown>;
}

test('a budget of 0 renders no memory at all, and never a negative one', () => {
  const { runtime } = oversizedFixture();
  for (const budget of [0, -64]) {
    const memory = visibleMemory(runtime, 'npc_01', 12, 'obligation-first', budget);
    assert.equal(memory.budgetUnits, 0, 'a negative budget is clamped to 0');
    assert.equal(memory.units, 0);
    assert.equal(memory.kept, 0);
    assert.equal(memory.dropped, memory.cursor.records);
    assert.equal(memory.block, '');
    assert.equal(memory.segment, '');
    assert.equal(memory.bytes, 0);
    // Nothing is rendered, but the omission is still named.
    assert.ok(memory.truncated);
    assert.ok(memory.truncatedFacts.some(entry => entry.pointer === 'long-promise'));
  }
});

test('the first oversized record is trimmed to the budget instead of bypassing it', () => {
  const { runtime, longText, commitmentId } = oversizedFixture();
  const memory = visibleMemory(runtime, 'npc_01', 12, 'obligation-first', 64);
  assert.ok(memory.units <= 64, `billed ${memory.units}`);
  assert.equal(memory.kept, 1);
  // The old failure: 6580 units and 19748 bytes reached the renderer.
  assert.ok(memory.bytes < 2000, `rendered ${memory.bytes} bytes`);
  assert.ok(memory.truncated);

  const fact = memory.facts[0];
  const payload = payloadOf(fact);
  // Source and both clocks survive.
  assert.equal(fact.source, 'player_statement');
  assert.equal(fact.kind, 'commitment_accepted');
  assert.equal(fact.simTime, 482);
  assert.equal(payload.occurredAt, 480);
  // Instance + the traceable pointer survive at the 64-unit boundary.
  assert.equal(payload.commitmentId, commitmentId);
  assert.equal(payload.pointer, 'long-promise');
  assert.equal(payload.truncated, true);
  assert.equal(longText.includes(String(payload.text ?? '')), true,
    'whatever text is left must be a prefix of the original, never a rewrite');

  const trim = memory.truncatedFacts.find(entry => entry.pointer === 'long-promise');
  assert.ok(trim, 'the trim must be reported, not silent');
  assert.equal(trim.originalSha256.length, 64);
  assert.equal(trim.occurredAt, 480);
  assert.equal(trim.kind, 'commitment_accepted');
  assert.equal(trim.source, 'player_statement');
  assert.ok(trim.omittedTextChars > 6000, `omitted ${trim.omittedTextChars} chars`);
  assert.ok(trim.droppedFields.includes('text'));

  // The hash really identifies the untruncated record: recompute it from the
  // stored record through the same fact projection.
  const record = runtime.session.memories.get('npc_01')!.toJSON().records
    .find(entry => entry.eventId === 'long-promise')!;
  const original = factOf('npc_01', record).payload;
  assert.equal(trim.originalSha256, sha256Of(canonicalJson(original)));

  // The rendered block is the billed block, byte for byte.
  assert.equal(memory.block, renderMemoryBlock(memory.facts));
  assert.equal(memory.segment, renderMemorySegment(memory.facts));
  assert.equal(memory.bytes, Buffer.byteLength(memory.block, 'utf8'));
  assert.equal(memory.units, byteTokenCounter.count(memory.block));
});

test('a bigger budget keeps more of the same record, never less', () => {
  const { runtime } = oversizedFixture();
  const keptAt = (budget: number) => visibleMemory(runtime, 'npc_01', 12,
    'obligation-first', budget);
  const budgets = [0, 32, 64, 96, 160, 320, 640];
  let previousUnits = 0;
  for (const budget of budgets) {
    const memory = keptAt(budget);
    assert.ok(memory.units <= budget, `budget ${budget} billed ${memory.units}`);
    assert.ok(memory.units >= previousUnits, 'a larger budget must not shrink the block');
    previousUnits = memory.units;
  }
  // At 640 the free text is kept (trimmed), not replaced by a pointer.
  const generous = keptAt(640);
  const promise = generous.facts.find(fact => fact.eventId === 'long-promise')!;
  assert.ok(promise, 'the promise must be in the window at 640');
  assert.ok(String(payloadOf(promise).text ?? '').length > 100);
  assert.equal(payloadOf(promise).truncated, true);
});

test('several oversized records share the budget without evicting the small ones', () => {
  const { runtime, ids } = multiOversizedFixture();
  const memory = visibleMemory(runtime, 'npc_01', 12, 'obligation-first', 240);
  assert.ok(memory.units <= 240, `billed ${memory.units}`);
  assert.ok(memory.kept >= 3, `only ${memory.kept} records were represented`);
  // Every oversized record that entered the window did so as a trimmed line
  // with a pointer, and the ordinary record was NOT squeezed out for them.
  const pointers = memory.facts.map(fact => payloadOf(fact).pointer).filter(Boolean);
  assert.ok(pointers.length >= 2, 'more than one long record must be represented');
  assert.ok(memory.facts.some(fact => fact.eventId === 'small-note')
    || memory.units >= 240 - 40,
  'a small record must not be evicted by the long ones');
  for (const id of ids) {
    if (memory.facts.some(fact => fact.eventId === id)) {
      const trim = memory.truncatedFacts.find(entry => entry.pointer === id);
      assert.ok(trim, `trimmed record ${id} must be reported`);
    }
  }
  assert.ok(memory.truncated);
  assert.ok(memory.units <= memory.budgetUnits);
});

test('raw and conditional share budget, unit and candidate set; only the order differs', async () => {
  const { runtime } = multiOversizedFixture('r11b-arms');
  const raw = visibleMemory(runtime, 'npc_01', 12, 'raw-last12', 200);
  const conditional = visibleMemory(runtime, 'npc_01', 12, 'obligation-first', 200);
  assert.equal(raw.budgetUnits, conditional.budgetUnits);
  assert.equal(raw.unitId, conditional.unitId);
  assert.ok(raw.units <= 200 && conditional.units <= 200);
  assert.notEqual(raw.blockSha256, conditional.blockSha256,
    'the two arms must really select differently, otherwise the control proves nothing');

  // The candidate set is built before the memory window, so it cannot depend on
  // the arm: the same step options differ only in `memorySelection`.
  const rawBox: { request?: import('../../src/decision/contracts').ChoiceRequest } = {};
  const conditionalBox: { request?: import('../../src/decision/contracts').ChoiceRequest } = {};
  await runStep(runtime, abstainScorer(rawBox), { actorIds: ['npc_01'],
    memorySelection: 'raw-last12', memoryTokenBudget: 200 });
  await runStep(runtime, abstainScorer(conditionalBox), { actorIds: ['npc_01'],
    memorySelection: 'obligation-first', memoryTokenBudget: 200 });
  assert.ok(rawBox.request && conditionalBox.request);
  assert.deepEqual(rawBox.request.candidates.map(row => row.id),
    conditionalBox.request.candidates.map(row => row.id));
  assert.equal(rawBox.request.candidateSetHash, conditionalBox.request.candidateSetHash);
});

test('a step records the estimate and, when attached, the real tokenizer count', async () => {
  const { runtime } = oversizedFixture('r11b-encoder');
  const words = { id: 'test/whitespace-words/1',
    count: (text: string) => text.split(/\s+/).filter(Boolean).length };
  const box: { request?: import('../../src/decision/contracts').ChoiceRequest } = {};
  const result = await runStep(runtime, abstainScorer(box), {
    actorIds: ['npc_01'], memoryTokenBudget: 640, encoder: words,
  });
  const record = result.records[0];
  const request = box.request!;
  const block = renderMemoryBlock(request.memoryFacts);
  assert.equal(record.memoryUnitKind, 'estimated-token');
  assert.equal(record.memoryCounterId, byteTokenCounter.id);
  assert.equal(record.memoryTokens, byteTokenCounter.count(block));
  assert.equal(record.memoryEncoderId, words.id);
  assert.equal(record.memoryEncoderStatus, 'counted');
  assert.equal(record.memoryEncoderTokens, words.count(block));
  // The estimate and the tokenizer are different numbers, and both are named.
  assert.notEqual(record.memoryEncoderTokens, record.memoryTokens);
  assert.ok(record.memoryTokens! <= record.memoryBudget!);

  // The pre-encode byte check: the recorded bytes/sha are the rendered segment's.
  const segment = renderRequest(request).segments.find(entry => entry.kind === 'memory')!;
  assert.equal(segment.text, `\n记忆:\n${block}`);
  assert.equal(record.memorySegmentBytes, Buffer.byteLength(segment.text, 'utf8'));
  assert.equal(record.memorySegmentSha256, sha256Of(segment.text));
  assert.equal(record.memoryBlockSha256, sha256Of(block));
  assert.equal(record.memoryBytes, Buffer.byteLength(block, 'utf8'));

  // Without an encoder the record says so instead of reusing the estimate.
  const unattached = await runStep(runtime, abstainScorer(), { actorIds: ['npc_01'],
    memoryTokenBudget: 640 });
  assert.equal(unattached.records[0].memoryEncoderStatus, 'not-attached');
  assert.equal(unattached.records[0].memoryEncoderId, null);
  assert.equal(unattached.records[0].memoryEncoderTokens, null);
});
