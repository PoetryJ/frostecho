/**
 * R11-B point 2: a save carries the memory, and a restore rebuilds it.
 *
 * The task is not "add a second memory system". The records, the relations they
 * imply, the conditional notes distilled from them and the decision-memory
 * cursor must all come back equal — and the bounded window must bill the same
 * bytes in the new process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { notesFor, visibleMemory } from '../../src/r7/integration/step';
import { shortageFixture, tempDir } from './fixture';

const hash = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

test('records, relations, note dependencies and the cursor survive a new process', () => {
  const { runtime, play } = shortageFixture('r11b-restore');
  runtime.advanceWorld(runtime.world.simTime + 90);
  runtime.session.ingestTeamEvent('team_chatter', { tag: 'after' }, runtime.world.simTime);

  const actors = ['npc_01', 'npc_02'];
  const snapshot = (r: R8Runtime, p: GameplayLoop) => {
    p.syncLongTermMemory();
    const knowledge = r.session.knowledge();
    return {
      records: Object.fromEntries(actors.map(id => [id, hash(
        r.session.memories.get(id)!.toJSON().records)])),
      recordCounts: Object.fromEntries(actors.map(id => [id,
        r.session.memories.get(id)!.toJSON().records.length])),
      relations: Object.fromEntries(actors.map(id => [id, hash(knowledge[id]?.relation ?? null)])),
      promises: Object.fromEntries(actors.map(id => [id, hash(knowledge[id]?.promises ?? [])])),
      notes: Object.fromEntries(actors.map(id => [id, hash(notesFor(r, id))])),
      experience: hash(p.experience.toJSON()),
      cursors: p.memoryCursors(),
      decisionMemory: hash(p.longTermMemory.serialize()),
      projection: visibleMemory(r, 'npc_01', 12, 'obligation-first', 640).blockSha256,
    };
  };

  const before = snapshot(runtime, play);
  // The notes really exist, otherwise the dependency comparison is vacuous.
  assert.ok(notesFor(runtime, 'npc_01').length >= 1);
  assert.ok(before.cursors.npc_01 > 0);

  const path = join(tempDir('restore'), 'd2.session.json');
  play.save(path);
  runtime.save(path);

  const restoredRuntime = R8Runtime.load(path);
  const restoredPlay = GameplayLoop.fromSidecars(restoredRuntime.session, path);
  const after = snapshot(restoredRuntime, restoredPlay);

  assert.deepEqual(after.records, before.records, 'personal records');
  assert.deepEqual(after.recordCounts, before.recordCounts);
  assert.deepEqual(after.relations, before.relations, 'relations rebuilt from records');
  assert.deepEqual(after.promises, before.promises);
  assert.deepEqual(after.notes, before.notes, 'conditional note dependencies');
  assert.equal(after.experience, before.experience);
  assert.deepEqual(after.cursors, before.cursors, 'ingest cursor');
  assert.equal(after.decisionMemory, before.decisionMemory, 'decision memory');
  assert.equal(after.projection, before.projection, 'same billed memory bytes');

  // The cursor is the saved one, not "0 because we forgot": every actor's
  // cursor equals the number of records it holds.
  for (const id of actors) assert.equal(after.cursors[id], after.recordCounts[id]);

  // Re-ingesting is idempotent: a second sync adds nothing.
  const events = restoredPlay.longTermMemory.serialize().events.length;
  restoredPlay.syncLongTermMemory();
  assert.equal(restoredPlay.longTermMemory.serialize().events.length, events);
});
