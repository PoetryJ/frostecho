/**
 * R11-B: the first record has no budget exemption.
 *
 * R10 reproduced `budget=64 -> 6580 tokens / 19748 bytes` because the window
 * skipped the ceiling while `chosen.length === 0`. Here the same oversized
 * record must arrive as a deterministic, truncated line whose provenance
 * (evidence ref, original time, authority, revision, truncation mark) survives
 * and whose billed block is the exact text the model receives.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { byteTokenCounter, renderMemoryBlock } from '../../src/r7/jev/token-budget';
import { captureStep } from './capture';

const LONG = '本次送饭任务的条件及解释。'.repeat(500);

function runtimeWithRecord(seed: string, text: string): R8Runtime {
  const runtime = R8Runtime.create({ seed });
  runtime.session.memories.get('npc_01')!.append({
    eventId: 'large-realistic-commitment', observerId: 'npc_01',
    occurredAt: 480, observedAt: 480, kind: 'commitment_accepted',
    source: 'player_statement', authority: 'player',
    subjectIds: ['npc_01', 'player'], speakerId: 'player',
    payload: { text, commitmentId: 'cpu-c1', revision: 1 },
  });
  return runtime;
}

function memorySegment(segments: { kind: string; text: string }[]): string {
  const segment = segments.find(entry => entry.kind === 'memory');
  return segment ? segment.text.replace(/^\n记忆:\n/, '') : '';
}

test('an oversized FIRST record is fitted inside budget 64, never rendered whole', async () => {
  const runtime = runtimeWithRecord('r11-budget-first', LONG);
  const { capture } = await captureStep(runtime,
    { actorId: 'npc_01', memorySelection: 'raw-last12', memoryTokenBudget: 64 });

  assert.equal(capture.budget.kept, 1, 'the record must still be visible');
  assert.ok(capture.budget.memoryTokens <= 64,
    `billed ${capture.budget.memoryTokens} > 64`);
  // The billed number is the counter applied to the emitted block.
  assert.equal(capture.budget.memoryTokens, byteTokenCounter.count(capture.memoryBlock));
  assert.equal(capture.memoryBlock, memorySegment(capture.segments));
  // The whole long text never reaches the renderer.
  assert.ok(Buffer.byteLength(capture.memoryBlock, 'utf8') < 300,
    `rendered ${Buffer.byteLength(capture.memoryBlock, 'utf8')} bytes`);
  // Provenance survives the cut: the pointer, the original time and an
  // explicit truncation mark are part of the admitted fact.
  const fact = capture.request.memoryFacts[0];
  const payload = fact.payload as Record<string, unknown>;
  assert.equal(payload.truncated, true);
  assert.equal(payload.pointer, 'large-realistic-commitment');
  assert.equal(payload.occurredAt, 480);
  assert.equal(String(payload.text ?? '').length < 100, true,
    'the whole 6500-char text must not survive the trim');
});

test('budget 0 keeps nothing and bills nothing', async () => {
  const runtime = runtimeWithRecord('r11-budget-zero', LONG);
  const { capture } = await captureStep(runtime,
    { actorId: 'npc_01', memorySelection: 'raw-last12', memoryTokenBudget: 0 });
  assert.equal(capture.budget.kept, 0);
  assert.equal(capture.budget.memoryTokens, 0);
  assert.equal(capture.memoryBlock, '');
  assert.equal(capture.budget.dropped, 1);
});

test('both memory arms obey the same ceiling on an oversized record', async () => {
  for (const selection of ['raw-last12', 'obligation-first'] as const) {
    const runtime = runtimeWithRecord(`r11-budget-${selection}`, LONG);
    const { capture } = await captureStep(runtime,
      { actorId: 'npc_01', memorySelection: selection, memoryTokenBudget: 64 });
    assert.ok(capture.budget.memoryTokens <= 64,
      `${selection} billed ${capture.budget.memoryTokens}`);
    assert.equal(capture.budget.memoryTokens, byteTokenCounter.count(capture.memoryBlock));
    assert.equal(capture.memoryBlock, memorySegment(capture.segments));
  }
});

test('a small record under the same budget keeps its full text (no gratuitous cut)', async () => {
  const runtime = R8Runtime.create({ seed: 'r11-budget-small' });
  runtime.session.memories.get('npc_01')!.append({
    eventId: 'small-promise', observerId: 'npc_01', occurredAt: 480, observedAt: 480,
    kind: 'commitment_accepted', source: 'player_statement', authority: 'player',
    subjectIds: ['npc_01', 'player'], speakerId: 'player',
    payload: { text: '把饭送到仓库', commitmentId: 'cpu-c1', revision: 1 },
  });
  const { capture } = await captureStep(runtime,
    { actorId: 'npc_01', memorySelection: 'raw-last12', memoryTokenBudget: 640 });
  assert.equal(capture.budget.kept, 1);
  const payload = capture.request.memoryFacts[0].payload as Record<string, unknown>;
  assert.equal(payload.trunc, undefined);
  assert.equal(payload.text, '把饭送到仓库');
  assert.ok(capture.budget.memoryTokens <= 640);
});
