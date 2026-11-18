#!/usr/bin/env node
/**
 * R10-B evidence writer. Runs the three fixtures through the compiled encode
 * path and writes the raw numbers and the original input texts; it decides
 * nothing the tests do not also assert.
 *
 *   npm run build && node scripts/r10-b/emit-evidence.mjs [--out artifacts/r10-b]
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve('.');
const capture = require(join(root, 'dist/tests/r10-b/capture.js'));
const { byteTokenCounter, renderMemoryLine } = require(join(root, 'dist/src/r7/jev/token-budget.js'));
const { renderMemoryBlock } = require(join(root, 'dist/src/r7/jev/token-budget.js'));

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = resolve(outIndex >= 0 ? args[outIndex + 1] : 'artifacts/r10-b');
mkdirSync(join(out, 'texts'), { recursive: true });

const json = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
const text = (name, value) => writeFileSync(join(out, 'texts', name), value);
const legacy = input => {
  let tokens = 0;
  for (const char of input) tokens += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.25;
  return Math.ceil(tokens);
};
const armOf = (id, step) => ({
  arm: id,
  counterId: step.capture.budget.counterId,
  budgetTokens: step.capture.budget.memoryBudget,
  memoryTokens: step.capture.budget.memoryTokens,
  memoryBytes: Buffer.byteLength(step.capture.memoryBlock, 'utf8'),
  memoryFacts: step.capture.request.memoryFacts.length,
  kept: step.capture.budget.kept,
  dropped: step.capture.budget.dropped,
  legacyCaliber: legacy(step.capture.memoryBlock),
  perLineSum: step.capture.request.memoryFacts
    .reduce((sum, fact) => sum + byteTokenCounter.count(renderMemoryLine(fact)), 0),
  memoryBlockSha256: step.capture.memoryBlockSha256,
  renderSha256: step.capture.renderSha256,
  rendererId: step.capture.rendererId,
  envelope: step.capture.envelope.tokens,
  overBudget: step.capture.budget.memoryTokens > step.capture.budget.memoryBudget,
});

// 1. Budget caliber.
{
  const fixture = capture.budgetFixture();
  const raw = await capture.captureStep(fixture.runtime,
    { actorId: 'npc_01', memorySelection: 'raw-last12' });
  const ranked = await capture.captureStep(fixture.runtime,
    { actorId: 'npc_01', memorySelection: 'obligation-first' });
  json('token-budget.json', {
    schema: 'frostecho.r10b.token-budget/1',
    counter: { id: byteTokenCounter.id, definition: 'ceil(utf8 bytes / 3)',
      budgetTokens: 640, where: ['src/r7/integration/step.ts visibleMemory',
        'src/r7/jev/scorer-client.ts buildEnvelope tokens.memory'] },
    fixture: { seed: 'r10b-budget', actorId: 'npc_01', chatter: fixture.chatter },
    arms: [armOf('raw-last12', raw), armOf('obligation-first', ranked)],
    countsDifferByDesign: raw.capture.budget.kept !== ranked.capture.budget.kept,
    bothInsideBudget: raw.capture.budget.memoryTokens <= 640
      && ranked.capture.budget.memoryTokens <= 640,
  });
}

// 2. One record, one billing slot.
{
  const fixture = capture.shortageFixture();
  const receipt = fixture.receiptIds.at(-1);
  const before = await capture.captureStep(fixture.runtime,
    { actorId: 'npc_01', memoryNoteDedupe: false });
  const after = await capture.captureStep(fixture.runtime, { actorId: 'npc_01' });
  const note = after.record.memoryNotes.find(entry => entry.lesson === 'delay-should-be-reported');
  const ids = step => step.capture.request.memoryFacts
    .flatMap(fact => fact.payload.sourceEventIds ?? []);
  json('memory-double-booking.json', {
    schema: 'frostecho.r10b.memory-double-booking/1',
    fixture: { seed: 'r10b-double-booking', actorId: 'npc_01', stock: fixture.stock,
      receipts: fixture.receiptIds, outOfStock: receipt },
    note: note ?? null,
    before: { dedupe: false, memoryNoteSuppressed: before.capture.budget.suppressed,
      kept: before.capture.budget.kept, tokens: before.capture.budget.memoryTokens,
      factsKinds: before.capture.request.memoryFacts.map(fact => fact.kind),
      receiptInMemory: ids(before).includes(receipt),
      receiptInText: before.capture.text.includes(receipt),
      memoryBlockSha256: before.capture.memoryBlockSha256 },
    after: { dedupe: true, memoryNoteSuppressed: after.capture.budget.suppressed,
      kept: after.capture.budget.kept, tokens: after.capture.budget.memoryTokens,
      keptBefore: after.capture.budget.keptBefore,
      tokensBefore: after.capture.budget.tokensBefore,
      factsKinds: after.capture.request.memoryFacts.map(fact => fact.kind),
      receiptInMemory: ids(after).includes(receipt),
      receiptInText: after.capture.text.includes(receipt),
      memoryBlockSha256: after.capture.memoryBlockSha256 },
    saved: {
      records: before.capture.budget.kept - after.capture.budget.kept,
      bytes: Buffer.byteLength(before.capture.memoryBlock, 'utf8')
        - Buffer.byteLength(after.capture.memoryBlock, 'utf8'),
      tokens: after.capture.budget.tokensBefore - after.capture.budget.memoryTokens,
    },
    overlapRemaining: note
      ? note.sourceEventIds.filter(id => ids(after).includes(id)) : ['no note'],
    behaviourKept: after.capture.request.candidates
      .some(candidate => candidate.parameters.action === 'report-delay'),
  });
}

// 3. Unheard byte equality.
{
  const fixture = capture.cancellationFixture();
  const grab = actorId => capture.captureStep(fixture.runtime,
    { actorId, goalBridge: fixture.bridge });
  const u1 = await grab(fixture.unheardActor);
  const h1 = await grab(fixture.heardActor);
  const r1 = await grab(fixture.referenceActor);
  capture.cancelPrivately(fixture);
  const u2 = await grab(fixture.unheardActor);
  const h2 = await grab(fixture.heardActor);
  const r2 = await grab(fixture.referenceActor);
  const goals = step => {
    const line = step.capture.text.split('\n').find(entry => entry.startsWith('目标:'));
    return line.slice('目标:'.length).split(';').map(part => JSON.parse(part));
  };
  const bodies = step => step.capture.segments
    .filter(segment => segment.kind === 'candidate' && segment.index !== null)
    .map(segment => capture.candidateBody(segment.text));
  const entries = (from, to) => goals(from)
    .map((entry, index) => ({ index, before: entry, after: goals(to)[index] }))
    .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
  const changed = entries(h1, h2);
  const afterGoals = goals(h2);
  const unchanged = afterGoals
    .map((entry, index) => ({ index, entry }))
    .filter(({ index }) => !changed.some(row => row.index === index))
    .map(({ entry }) => ({ taskId: entry.taskId, type: entry.type, status: entry.status }));
  const removed = bodies(h1).filter(body => !bodies(h2).includes(body));
  const added = bodies(h2).filter(body => !bodies(h1).includes(body));
  const newFacts = h2.capture.request.memoryFacts
    .filter(fact => !h1.capture.request.memoryFacts.some(old => old.eventId === fact.eventId));

  text('unheard-before.txt', u1.capture.text);
  text('unheard-after.txt', u2.capture.text);
  text('heard-before.txt', h1.capture.text);
  text('heard-after.txt', h2.capture.text);
  text('reference-before.txt', r1.capture.text);
  text('reference-after.txt', r2.capture.text);

  const table = {
    schema: 'frostecho.r10b.unheard-bytes/1',
    rendererId: u1.capture.rendererId,
    counter: byteTokenCounter.id,
    // Commitment ids are `cm-${randomUUID()}` in the ledger, so the exact SHAs
    // bind THIS run; what reproduces is the relation (`identical`), which this
    // script machine-checks and exits non-zero on.
    exactHashesStableAcrossRuns: false,
    cancelled: { unheardCommitment: fixture.unheardCommitment,
      heardCommitment: fixture.heardCommitment, audience: [fixture.heardActor] },
    unheard: { actor: fixture.unheardActor,
      beforeSha256: u1.capture.renderSha256, afterSha256: u2.capture.renderSha256,
      identical: u1.capture.renderSha256 === u2.capture.renderSha256,
      beforeBytes: Buffer.byteLength(u1.capture.text, 'utf8'),
      afterBytes: Buffer.byteLength(u2.capture.text, 'utf8'),
      memoryBlockSha256: [u1.capture.memoryBlockSha256, u2.capture.memoryBlockSha256],
      envelopeHashes: [u1.capture.envelope.renderedTextSha256,
        u2.capture.envelope.renderedTextSha256],
      cancellationRecords: fixture.runtime.session.memories.get(fixture.unheardActor)
        .toJSON().records.filter(record => record.kind === 'commitment_cancelled').length },
    reference: { actor: fixture.referenceActor,
      beforeSha256: r1.capture.renderSha256, afterSha256: r2.capture.renderSha256,
      identical: r1.capture.renderSha256 === r2.capture.renderSha256 },
    heard: { actor: fixture.heardActor,
      beforeSha256: h1.capture.renderSha256, afterSha256: h2.capture.renderSha256,
      identical: h1.capture.renderSha256 === h2.capture.renderSha256,
      changedGoalEntries: changed.map(entry => ({ index: entry.index,
        commitmentId: entry.after.commitmentId,
        status: [entry.before.status, entry.after.status],
        ready: [entry.before.ready, entry.after.ready] })),
      unchangedGoalEntries: unchanged,
      candidatesRemoved: removed.map(body => body.slice(0, 120)),
      candidatesAdded: added.map(body => body.slice(0, 120)),
      memoryFactsAdded: newFacts.map(fact => ({ kind: fact.kind,
        commitmentId: fact.payload.commitmentId ?? null })),
      cancellationRecords: fixture.runtime.session.memories.get(fixture.heardActor)
        .toJSON().records.filter(record => record.kind === 'commitment_cancelled').length,
    },
  };
  json('unheard-bytes.json', table);
  if (!table.unheard.identical || !table.reference.identical) {
    console.error('R10-B: an actor that could not hear the cancellation changed its input');
    process.exit(1);
  }
  if (table.heard.identical || table.heard.changedGoalEntries.length !== 1) {
    console.error('R10-B: the hearer must change exactly one target line');
    process.exit(1);
  }
}

console.log(`wrote ${out}`);
