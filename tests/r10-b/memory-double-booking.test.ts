/**
 * R10-B point 2: one record, one billing slot.
 *
 * An experience note is distilled from one of the actor's own records. If that
 * record is ALSO listed as a memory entry, the same evidence is paid for twice:
 * once out of the 640-token memory budget, once as the option the note adds.
 * Turning `memoryNoteDedupe` off reproduces the old accounting deliberately, so
 * the before/after below are measured on the same fixture, not claimed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byteTokenCounter, renderMemoryLine } from '../../src/r7/jev/token-budget';
import { captureStep, direct, shortageFixture } from './capture';

test('a record consumed by a note is never also billed as a memory entry', async () => {
  const fixture = shortageFixture();
  // The witnessed shortage is a real receipt: the note's provenance is that id.
  const receipt = fixture.receiptIds.at(-1)!;
  const before = await captureStep(fixture.runtime,
    { actorId: 'npc_01', memoryNoteDedupe: false });
  const after = await captureStep(fixture.runtime, { actorId: 'npc_01' });

  // 1. The note exists and carries the record it was distilled from.
  const note = after.record.memoryNotes?.find(entry => entry.lesson === 'delay-should-be-reported');
  assert.ok(note, 'the witnessed shortage must produce the delay lesson');
  assert.deepEqual(note.sourceEventIds, [receipt]);
  assert.equal(note.observedAt, 480);

  // 2. BEFORE: the same event id is in both channels — that is the duplicate.
  const overlap = (capture: typeof before): string[] => {
    const inMemory = new Set(capture.capture.request.memoryFacts
      .flatMap(fact => (fact.payload as { sourceEventIds?: string[] }).sourceEventIds ?? []));
    return note.sourceEventIds.filter(id => inMemory.has(id));
  };
  assert.deepEqual(overlap(before), [receipt]);
  assert.equal(before.capture.budget.suppressed, 0);

  // 3. AFTER: the note owns the slot; the record is gone from the memory window.
  assert.deepEqual(overlap(after), []);
  assert.equal(after.capture.budget.suppressed, 1);
  assert.equal(after.capture.budget.kept, after.capture.budget.keptBefore - 1);
  assert.equal(after.capture.budget.keptBefore, before.capture.budget.kept);
  assert.equal(after.capture.budget.tokensBefore, before.capture.budget.memoryTokens);
  assert.ok(after.capture.budget.memoryTokens < after.capture.budget.tokensBefore);
  // The saved bytes are exactly the line that left plus its join newline, so
  // nothing else was cut to make room.
  const removed = before.capture.request.memoryFacts
    .find(fact => (fact.payload as { sourceEventIds?: string[] }).sourceEventIds
      ?.includes(receipt))!;
  assert.equal(Buffer.byteLength(before.capture.memoryBlock, 'utf8')
    - Buffer.byteLength(after.capture.memoryBlock, 'utf8'),
  Buffer.byteLength(renderMemoryLine(removed), 'utf8') + 1);

  // 4. The duplicate is visible in the text, and only in the old accounting.
  assert.ok(before.capture.text.includes(receipt));
  assert.equal(after.capture.text.includes(receipt), false);
  // The note id is a mapping handle, never a prompt token (CONTRACT §3); the
  // lesson reaches the model as the option it adds, not as a rendered id.
  assert.equal(after.capture.text.includes(note.noteId), false);
  assert.ok(after.capture.text.includes('说明延误并给出新时点'));

  // 5. Behaviour is preserved: the note still adds its option in both arms.
  for (const arm of [before, after])
    assert.ok(arm.capture.request.candidates
      .some(candidate => candidate.parameters.action === 'report-delay'),
    'the delay lesson must still be proposable after de-duplication');
  // 6. Both numbers are the counter applied to the emitted block.
  assert.equal(after.capture.budget.memoryTokens,
    byteTokenCounter.count(after.capture.memoryBlock));
  assert.equal(after.capture.envelope.tokens.memory, after.capture.budget.memoryTokens);

  // 7. The refusal path is untouched: a second withdraw still yields a receipt,
  //    so the evidence above is not an artefact of a broken fixture.
  const again = direct(fixture.runtime, 'npc_01', 'withdraw',
    { place: 'warehouse', amount: 1 });
  assert.equal(again.status, 'applied');
  assert.ok(again.eventIds.length > 0, 'a real receipt must back the fixture');
});
