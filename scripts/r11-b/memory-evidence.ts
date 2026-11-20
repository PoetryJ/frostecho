/**
 * R11-B evidence: the budget boundary, the exact input bytes/SHA, and the two
 * numbers that must never be confused.
 *
 * Every number below is produced by the shipped modules — the projection the
 * step bills (`visibleMemory` / `runStep`) and the renderer the encoder reads
 * (`renderRequest`). This script only measures and writes; it decides nothing.
 *
 *   npm run build && node dist/scripts/r11-b/memory-evidence.js \
 *     [--out artifacts/r11-b]
 *
 * The real tokenizer count is NOT computed here: Node has no tokenizer. The
 * blocks are written to `texts/` and `scripts/r11-b/tokenize_blocks.py` counts
 * them with the encoder's own tokenizer, writing `encoder-tokens.json`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChoiceRequest } from '../../src/decision/contracts';
import { renderRequest } from '../../src/r7/jev/render';
import { MEMORY_PROJECTION_ID, byteTokenCounter, renderMemoryBlock,
  sha256Of } from '../../src/r7/jev/token-budget';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { executeCandidate, notesFor, runStep, visibleMemory }
  from '../../src/r7/integration/step';
import { makeChoiceResult } from '../../src/decision/contracts';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { createCommitmentBridge } from '../../src/r7/integration/commitment-bridge';
import type { MemorySelection } from '../../src/r7/memory/window';
import { DEFAULT_WAREHOUSE_FOOD } from '../../src/survival/world-v2';

const BUDGETS = [0, 8, 32, 64, 96, 192, 640];
const SELECTIONS: MemorySelection[] = ['raw-last12', 'obligation-first'];

interface Env { runtime: R8Runtime; play: GameplayLoop; bridge: ReturnType<typeof createCommitmentBridge> }

function direct(env: Env, actorId: string, action: string,
  parameters: Record<string, unknown>): { status: string; eventIds: string[] } {
  const candidate = { id: `ev-${action}`, kind: action, description: action,
    parameters: { action, ...parameters }, preconditions: [], expectedEffects: {},
    utilityComponents: {} } as Parameters<typeof executeCandidate>[2];
  return executeCandidate(env.runtime, actorId, candidate,
    `${actorId}-ev-${action}-${env.runtime.world.version}`);
}

/** The three shapes the audit named: one long record, many, and one with notes. */
function oversizedSingle(): Env {
  const runtime = R8Runtime.create({ seed: 'r11b-ev-oversized' });
  const play = new GameplayLoop(runtime.session);
  runtime.session.memories.get('npc_01')!.append({
    eventId: 'large-realistic-commitment', observerId: 'npc_01', occurredAt: 480, observedAt: 480,
    kind: 'commitment_accepted', source: 'player_statement', authority: 'player',
    subjectIds: ['npc_01', 'player'], speakerId: 'player',
    payload: { text: '本次送饭任务的条件及解释。'.repeat(500), commitmentId: 'cpu-c1', revision: 1 },
  });
  return { runtime, play, bridge: createCommitmentBridge(runtime, play) };
}

function manyRecords(): Env {
  const runtime = R8Runtime.create({ seed: 'r11b-ev-many' });
  const play = new GameplayLoop(runtime.session);
  const store = runtime.session.memories.get('npc_01')!;
  for (let index = 0; index < 3; index += 1) {
    store.append({ eventId: `bulk-${index}`, observerId: 'npc_01', occurredAt: 480 + index,
      observedAt: 481 + index, kind: 'commitment_change_proposed', source: 'player_statement',
      authority: 'player', subjectIds: ['npc_01', 'player'], speakerId: 'player',
      payload: { text: `第${index}条长条件。`.repeat(300), commitmentId: `cpu-b${index}`,
        revision: index + 1 } });
  }
  for (let index = 0; index < 6; index += 1) {
    runtime.session.ingestTeamEvent('team_chatter', { index }, runtime.world.simTime);
  }
  return { runtime, play, bridge: createCommitmentBridge(runtime, play) };
}

function withNotes(): Env {
  const runtime = R8Runtime.create({ seed: 'r11b-ev-notes' });
  const play = new GameplayLoop(runtime.session);
  runtime.session.submitWorldCommand({ commandId: 'ev-move', type: 'move',
    actorId: 'npc_01', to: 'warehouse' } as
    Parameters<typeof runtime.session.submitWorldCommand>[0]);
  const stock = runtime.world.spatial?.stocks.warehouse.food ?? DEFAULT_WAREHOUSE_FOOD;
  const env = { runtime, play, bridge: createCommitmentBridge(runtime, play) };
  direct(env, 'npc_01', 'withdraw', { place: 'warehouse', amount: stock });
  direct(env, 'npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  return env;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface TextFile { file: string; sha256: string; bytes: number }

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = resolve(outIndex >= 0 ? args[outIndex + 1] : join('artifacts', 'r11-b'));
  mkdirSync(join(out, 'texts'), { recursive: true });

  const fixtures: { id: string; env: Env }[] = [
    { id: 'oversized-single', env: oversizedSingle() },
    { id: 'many-records', env: manyRecords() },
    { id: 'shortage-with-notes', env: withNotes() },
  ];

  const matrix: Record<string, unknown>[] = [];
  const texts: TextFile[] = [];
  const writeText = (name: string, text: string): TextFile => {
    writeFileSync(join(out, 'texts', name), text, 'utf8');
    const entry = { file: `texts/${name}`, sha256: sha(text), bytes: Buffer.byteLength(text, 'utf8') };
    texts.push(entry);
    return entry;
  };

  for (const fixture of fixtures) {
    const { runtime } = fixture.env;
    for (const budget of BUDGETS) {
      for (const selection of SELECTIONS) {
        const memory = visibleMemory(runtime, 'npc_01', 12, selection, budget);
        const file = memory.kept === 0 ? null
          : writeText(`${fixture.id}.b${budget}.${selection}.memory.txt`, memory.block);
        matrix.push({
          fixture: fixture.id, budget, selection,
          units: memory.units, unitId: memory.unitId, unitKind: memory.unitKind,
          budgetUnits: memory.budgetUnits,
          withinBudget: memory.units <= memory.budgetUnits,
          kept: memory.kept, dropped: memory.dropped, suppressed: memory.suppressed,
          blockBytes: memory.bytes, segmentBytes: memory.segmentBytes,
          blockSha256: memory.blockSha256, segmentSha256: memory.segmentSha256,
          truncated: memory.truncated,
          trims: memory.truncatedFacts.map(entry => ({
            pointer: entry.pointer, level: entry.level, originalSha256: entry.originalSha256,
            occurredAt: entry.occurredAt, droppedFields: entry.droppedFields,
            omittedTextChars: entry.omittedTextChars })),
          kinds: memory.facts.map(fact => fact.kind),
          encoder: memory.encoder,
          text: file,
        });
      }
    }
  }

  // The step path every front-end uses: the record it writes must agree with
  // the rendered segment, byte for byte, including the input SHA.
  const steps: Record<string, unknown>[] = [];
  for (const fixture of fixtures) {
    for (const selection of SELECTIONS) {
      const box: { request?: ChoiceRequest } = {};
      const scorer = {
        identity: referenceAgencyScorer().identity,
        score(request: ChoiceRequest) {
          box.request = request;
          return makeChoiceResult({ request, scorerId: 'r11b-evidence',
            scores: request.candidates.map(row => ({ candidateId: row.id, logit: 0 })),
            disposition: 'abstain', selectedId: null, reason: 'evidence capture only' });
        },
      };
      const result = await runStep(fixture.env.runtime, scorer, { actorIds: ['npc_01'],
        memorySelection: selection, memoryTokenBudget: 640, goalBridge: fixture.env.bridge,
        notes: id => notesFor(fixture.env.runtime, id) });
      const record = result.records[0];
      const request = box.request!;
      const rendered = renderRequest(request);
      const segment = rendered.segments.find(entry => entry.kind === 'memory');
      const block = renderMemoryBlock(request.memoryFacts);
      const inputFile = writeText(`${fixture.id}.${selection}.input.txt`, rendered.text);
      steps.push({
        fixture: fixture.id, selection, actorId: 'npc_01',
        projectionId: MEMORY_PROJECTION_ID,
        input: { bytes: Buffer.byteLength(rendered.text, 'utf8'),
          sha256: sha(rendered.text), file: inputFile.file },
        inputSha256Recorded: record.inputSha256,
        renderSha256Recorded: record.renderSha256,
        memory: {
          units: record.memoryTokens, unitId: record.memoryCounterId,
          unitKind: record.memoryUnitKind, budget: record.memoryBudget,
          bytes: record.memoryBytes, kept: record.memoryKept, dropped: record.memoryDropped,
          blockSha256: record.memoryBlockSha256, segmentSha256: record.memorySegmentSha256,
          segmentBytes: record.memorySegmentBytes,
          encoderId: record.memoryEncoderId, encoderTokens: record.memoryEncoderTokens,
          encoderStatus: record.memoryEncoderStatus,
          truncated: record.memoryTruncated,
          trims: record.memoryTruncatedFacts?.map(entry => ({ pointer: entry.pointer,
            level: entry.level, droppedFields: entry.droppedFields })) ?? [],
          cursor: record.memoryCursor,
        },
        agreesWithRender: Boolean(segment)
          && segment!.text === `\n记忆:\n${block}`
          && record.memoryBlockSha256 === sha256Of(block)
          && record.memorySegmentSha256 === sha256Of(segment!.text)
          && record.memoryBytes === Buffer.byteLength(block, 'utf8')
          && record.memoryTokens === byteTokenCounter.count(block),
        renderer: rendered.rendererId,
        segmentBytes: segment ? Buffer.byteLength(segment.text, 'utf8') : 0,
      });
    }
  }

  const document = {
    schema: 'frostecho.r11b.memory-evidence/1',
    projectionId: MEMORY_PROJECTION_ID,
    counter: { id: byteTokenCounter.id, definition: 'ceil(utf8 bytes / 3)',
      kind: 'estimated-token' },
    note: 'units are an ESTIMATE. The real tokenizer count is in encoder-tokens.json, '
      + 'produced by tokenize_blocks.py with the encoder\'s own tokenizer.',
    budgets: BUDGETS, selections: SELECTIONS,
    matrix, steps, texts,
  };
  writeFileSync(join(out, 'memory-budget.json'), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(out, 'tokenizer-inputs.json'), `${JSON.stringify({
    schema: 'frostecho.r11b.tokenizer-inputs/1', texts }, null, 2)}\n`);
  const within = matrix.every(row => row.withinBudget === true);
  const agreeing = steps.every(row => row.agreesWithRender === true);
  const summary = { cases: matrix.length, withinBudget: within,
    stepRecordsAgreeWithRender: agreeing, steps: steps.length };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ out, ...summary }, null, 2));
  if (!within || !agreeing) process.exitCode = 1;
}

void main();
