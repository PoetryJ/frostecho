/**
 * R10-B point 3: the byte-level negative control for a private cancellation.
 *
 * An actor that never heard a cancellation must receive the SAME input text,
 * byte for byte, before and after it. A hearer must change exactly the one
 * target line that belongs to that promise — and nothing else.
 *
 * This runs the real encode path from `dist` (`render.js` + the envelope the
 * scorer service receives), never a hand-written string: if the built renderer
 * and the captured text diverge, the test fails on identity, not on wording.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelPrivately, candidateBody, cancellationFixture, captureStep, sha256,
} from './capture';

function goalEntries(text: string): Record<string, unknown>[] {
  const line = text.split('\n').find(entry => entry.startsWith('目标:'));
  assert.ok(line, 'a decision input must carry its goal line');
  return line.slice('目标:'.length).split(';').map(part => JSON.parse(part));
}

function candidateBodies(segments: { kind: string; index: number | null; text: string }[]):
  string[] {
  return segments.filter(segment => segment.kind === 'candidate' && segment.index !== null)
    .map(segment => candidateBody(segment.text));
}

test('an unheard cancellation leaves the input byte-identical; a heard one moves one target', async () => {
  const fixture = cancellationFixture();
  const grab = (actorId: string) => captureStep(fixture.runtime,
    { actorId, goalBridge: fixture.bridge });

  const unheardBefore = await grab(fixture.unheardActor);
  const heardBefore = await grab(fixture.heardActor);
  const referenceBefore = await grab(fixture.referenceActor);
  cancelPrivately(fixture);
  const unheardAfter = await grab(fixture.unheardActor);
  const heardAfter = await grab(fixture.heardActor);
  const referenceAfter = await grab(fixture.referenceActor);

  // The mechanism must be real: the hearer holds the record, the absent actor
  // holds nothing — otherwise the equality below would prove nothing.
  const records = (actorId: string) => fixture.runtime.session.memories.get(actorId)!
    .toJSON().records.filter(record => record.kind === 'commitment_cancelled');
  assert.equal(records(fixture.unheardActor).length, 0);
  assert.ok(records(fixture.heardActor).length >= 1);

  // 1. Unheard: identical bytes, identical hash, identical envelope hash.
  assert.equal(unheardAfter.capture.renderSha256, unheardBefore.capture.renderSha256);
  assert.equal(unheardAfter.capture.text, unheardBefore.capture.text);
  assert.equal(unheardAfter.capture.envelope.renderedTextSha256,
    unheardBefore.capture.envelope.renderedTextSha256);
  assert.equal(unheardAfter.capture.memoryBlockSha256, unheardBefore.capture.memoryBlockSha256);
  // 2. A second control: an untouched actor is also byte-identical, so equality
  //    is not an artefact of a renderer that ignores every cancellation.
  assert.equal(referenceAfter.capture.renderSha256, referenceBefore.capture.renderSha256);
  // 3. And the renderer is not frozen: the hearer's text must change.
  assert.notEqual(heardAfter.capture.renderSha256, heardBefore.capture.renderSha256);

  // 4. Heard: exactly ONE goal entry changed, and it is the cancelled promise.
  const beforeGoals = goalEntries(heardBefore.capture.text);
  const afterGoals = goalEntries(heardAfter.capture.text);
  assert.equal(afterGoals.length, beforeGoals.length);
  const changed = beforeGoals
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => JSON.stringify(entry) !== JSON.stringify(afterGoals[index]));
  assert.equal(changed.length, 1, 'a private cancellation may move one target only');
  const target = changed[0];
  assert.equal(afterGoals[target.index].commitmentId, fixture.heardCommitment);
  assert.equal(target.entry.status, 'active');
  assert.equal(afterGoals[target.index].status, 'cancelled');
  assert.equal(target.entry.ready, true);
  assert.equal(afterGoals[target.index].ready, false);
  // The actor's OTHER target (an accepted task) is untouched, byte for byte.
  const other = afterGoals.find(entry => entry.taskId === fixture.otherTargetTaskId);
  assert.ok(other, 'the untouched second target must still be listed');
  assert.deepEqual(other, beforeGoals.find(entry => entry.taskId === fixture.otherTargetTaskId));
  // The observation and the question do not move either.
  for (const kind of ['observation', 'question']) {
    const pick = (segments: { kind: string; text: string }[]) =>
      segments.filter(segment => segment.kind === kind).map(segment => segment.text).join('');
    assert.equal(pick(heardAfter.capture.segments), pick(heardBefore.capture.segments));
  }

  // 5. The candidate block loses ONLY the option bound to that promise.
  const beforeBodies = candidateBodies(heardBefore.capture.segments);
  const afterBodies = candidateBodies(heardAfter.capture.segments);
  const added = afterBodies.filter(body => !beforeBodies.includes(body));
  const removed = beforeBodies.filter(body => !afterBodies.includes(body));
  assert.deepEqual(added, [], 'a cancellation may not invent an option');
  assert.ok(removed.length > 0);
  for (const body of removed)
    assert.ok(body.includes(`commitmentId=${fixture.heardCommitment}`),
      `only the cancelled promise's option may disappear: ${body.slice(0, 60)}`);
  // No option of the untouched target was touched.
  assert.equal(afterBodies.filter(body => body.includes(fixture.otherTargetTaskId)).length,
    beforeBodies.filter(body => body.includes(fixture.otherTargetTaskId)).length);

  // 6. Memory: the only admitted change is the cancellation of THAT promise
  //    (when the window has room), and nothing was evicted to make room.
  const factKey = (fact: { eventId: string }) => fact.eventId;
  const beforeFacts = new Map(heardBefore.capture.request.memoryFacts
    .map(fact => [factKey(fact), fact]));
  const afterFacts = new Map(heardAfter.capture.request.memoryFacts
    .map(fact => [factKey(fact), fact]));
  const newFacts = [...afterFacts.keys()].filter(key => !beforeFacts.has(key));
  const goneFacts = [...beforeFacts.keys()].filter(key => !afterFacts.has(key));
  assert.deepEqual(goneFacts, [], 'the window must not evict another record to fit the news');
  for (const key of newFacts) {
    const fact = afterFacts.get(key)!;
    assert.equal(fact.kind, 'commitment_cancelled');
    assert.equal((fact.payload as { commitmentId?: string }).commitmentId,
      fixture.heardCommitment);
  }

  // 7. Text identity is the built renderer's, not this test's.
  assert.equal(sha256(unheardAfter.capture.text), unheardAfter.capture.renderSha256);
  assert.equal(unheardBefore.capture.envelope.inputSha256.length, 64);
});
