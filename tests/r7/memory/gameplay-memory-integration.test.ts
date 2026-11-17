import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameplayLoop } from '../../../src/gameplay-v2/loop';
import type { MemoryContext } from '../../../src/r7/memory';

test('real CLI saves personal observations; a new process restores and updates only the witness context', () => {
  const directory = mkdtempSync(join(tmpdir(), 'r7-live-memory-'));
  const state = join(directory, 'session.json');
  const cli = (input: string, fresh = false): void => {
    const result = spawnSync(process.execPath,
      ['dist/scripts/play-sprint.js', '--state', state, '--npc', '2', ...(fresh ? ['--fresh'] : [])],
      { input, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  };
  try {
    cli('travel npc_01 warehouse\nwithdraw npc_01 4\nwithdraw npc_01 1\nsave\nquit\n', true);
    const sidecar = `${state}.long-term-memory.json`;
    assert.equal(existsSync(sidecar), true);
    const first = GameplayLoop.load(state);
    const context = first.decisionContext('npc_01', { goal: 'deliver-meal', tokenBudget: 5000 });
    assert.ok(context.contextText.includes('来源缺货'));
    assert.ok(!first.decisionContext('npc_02', { tokenBudget: 5000 }).contextText.includes('来源缺货'));
    const source = first.longTermMemory.evidence('npc_01', context.evidenceIds, first.session.world.simTime);
    assert.ok(source.some(item => item.kind === 'out_of_stock' && item.originEventId?.includes('out_of_stock')));
    assert.deepEqual(GameplayLoop.load(state).decisionContext('npc_01', { goal: 'deliver-meal', tokenBudget: 5000 }), context);

    cli('restock 3\nsave\nquit\n');
    const restored = GameplayLoop.load(state);
    const after = restored.decisionContext('npc_01', { goal: 'deliver-meal', tokenBudget: 5000 });
    assert.ok(after.contextText.includes('最新亲见库存可用'));
    assert.ok(after.items.some(item => item.kind === 'experience' && item.applicability === 'contradicted'));
    const other = restored.decisionContext('npc_02', { tokenBudget: 5000 });
    assert.ok(!other.contextText.includes('库存可用'));
    const globalStatus = JSON.stringify(restored.status());
    assert.ok(globalStatus.includes('decisionMemory'));
    assert.ok(!globalStatus.includes('contextText'));

    // A pre-R7 save has no sidecar. Existing MemoryStore records are sufficient
    // to reconstruct exactly the same decision context and source ownership.
    const document = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(document.schema, 'frostecho.gameplay-decision-memory/1');
    rmSync(sidecar);
    const legacy = GameplayLoop.load(state);
    assert.deepEqual(legacy.decisionContext('npc_01', { goal: 'deliver-meal', tokenBudget: 5000 }), after);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('game-step supplies the real pre-action context while the default reference action remains unchanged', () => {
  const contexts: MemoryContext[] = [];
  const observed = GameplayLoop.create(2, { seed: 'same-reference' },
    { onDecisionContext: context => contexts.push(context) });
  const control = GameplayLoop.create(2, { seed: 'same-reference' });
  for (const loop of [observed, control]) loop.assign('npc_01', 'gather-food');
  assert.deepEqual(observed.step(), control.step());
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].actorId, 'npc_01');
  assert.deepEqual(observed.session.world, control.session.world);
  const after = observed.decisionContext('npc_01', { tokenBudget: 5000 });
  assert.ok(after.evidenceIds.length > contexts[0].evidenceIds.length);
  assert.ok(observed.longTermMemory.evidence('npc_01', after.evidenceIds,
    observed.session.world.simTime).some(item => item.kind === 'gathered'));
});

test('a personal MemoryStore message never enters another NPC context or the global status text', () => {
  const loop = GameplayLoop.create(2, { seed: 'private-memory' });
  loop.session.memories.get('npc_01')!.append({ eventId: 'private-secret', observerId: 'npc_01',
    occurredAt: 0, observedAt: 0, kind: 'private_message', subjectIds: ['npc_01'],
    payload: { text: 'only-a-knows-this-secret' }, source: 'player_statement', authority: 'player' });
  assert.ok(loop.decisionContext('npc_01').contextText.includes('only-a-knows-this-secret'));
  assert.ok(!loop.decisionContext('npc_02').contextText.includes('only-a-knows-this-secret'));
  assert.ok(!JSON.stringify(loop.status()).includes('only-a-knows-this-secret'));
  assert.ok(JSON.stringify(loop.status('npc_01')).includes('only-a-knows-this-secret'));
});
