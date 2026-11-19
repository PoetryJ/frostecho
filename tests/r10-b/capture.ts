/**
 * B (R10) capture harness: every number in the three R10-B tests and in
 * `artifacts/r10-b/*` comes from here, and every text comes from the REAL
 * compiled encode path (`dist/src/r7/jev/render.js` + `buildEnvelope`), never
 * from a hand-written string.
 *
 * This module only captures; it asserts nothing. The tests assert, the emit
 * script records. Keeping them apart means the evidence file and the test
 * cannot disagree about what was measured.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeChoiceResult, type Candidate, type ChoiceRequest }
  from '../../src/decision/contracts';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { createCommitmentBridge } from '../../src/r7/integration/commitment-bridge';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { executeCandidate, runStep, type StepOptions, type StepRecord }
  from '../../src/r7/integration/step';
import { byteTokenCounter, renderMemoryBlock } from '../../src/r7/jev/token-budget';
import { DEFAULT_WAREHOUSE_FOOD } from '../../src/survival/world-v2';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Repo root, derived from the compiled location so cwd cannot change meaning. */
export function repoRoot(): string {
  const compiled = join(__dirname, '../../..');
  return existsSync(join(compiled, 'dist/src/r7/jev/render.js')) ? compiled : process.cwd();
}

/** The compiled modules the game really ships; a stale build fails the test. */
export function distModules(): {
  renderRequest: (request: ChoiceRequest) => { text: string; rendererId: string;
    segments: { kind: string; index: number | null; text: string }[] };
  buildEnvelope: (request: ChoiceRequest, counter?: { id: string;
    count(text: string): number }) => Record<string, unknown>;
} {
  const root = repoRoot();
  return {
    renderRequest: require(join(root, 'dist/src/r7/jev/render.js')).renderRequest,
    buildEnvelope: require(join(root, 'dist/src/r7/jev/scorer-client.js')).buildEnvelope,
  };
}

export interface EncodeCapture {
  request: ChoiceRequest;
  /** What the game text was: `renderRequest(request).text` from the built module. */
  text: string;
  rendererId: string;
  renderSha256: string;
  segments: { kind: string; index: number | null; text: string }[];
  /** Bytes the model service receives: `renderMemoryBlock(request.memoryFacts)`. */
  memoryBlock: string;
  memoryBlockSha256: string;
  /** Counts reported by the two sides that must agree. */
  budget: { counterId: string; memoryTokens: number; memoryBudget: number; kept: number;
    dropped: number; keptBefore: number; tokensBefore: number; suppressed: number };
  envelope: { renderedTextSha256: string; inputSha256: string;
    tokens: { counterId: string; total: number; memory: number; memoryFacts: number } };
}

export interface CapturedStep { record: StepRecord; capture: EncodeCapture }

/** Run one real step and capture exactly what would be encoded. */
export async function captureStep(runtime: R8Runtime,
  options: StepOptions & { actorId: string }): Promise<CapturedStep> {
  const { actorId, ...rest } = options;
  const box: { request: ChoiceRequest | null } = { request: null };
  const scorer = {
    identity: referenceAgencyScorer().identity,
    async score(request: ChoiceRequest) {
      box.request = request;
      return makeChoiceResult({ request, scorerId: 'r10-b-capture',
        scores: request.candidates.map(row => ({ candidateId: row.id, logit: 0 })),
        selectedId: null, disposition: 'abstain', reason: 'r10-b capture only' });
    },
  };
  const result = await runStep(runtime, scorer, { ...rest, actorIds: [actorId] });
  const record = result.records[0];
  const request = box.request;
  if (!request) throw new Error(`no request captured for ${actorId} (${record?.disposition})`);
  const dist = distModules();
  const rendered = dist.renderRequest(request);
  const envelope = dist.buildEnvelope(request) as EncodeCapture['envelope'];
  const memoryBlock = renderMemoryBlock(request.memoryFacts);
  return { record, capture: {
    request, text: rendered.text, rendererId: rendered.rendererId,
    renderSha256: sha256(rendered.text), segments: rendered.segments,
    memoryBlock, memoryBlockSha256: sha256(memoryBlock),
    budget: { counterId: record.memoryCounterId ?? 'missing',
      memoryTokens: record.memoryTokens ?? -1, memoryBudget: record.memoryBudget ?? -1,
      kept: record.memoryKept ?? -1, dropped: record.memoryDropped ?? -1,
      keptBefore: record.memoryKeptBefore ?? -1, tokensBefore: record.memoryTokensBefore ?? -1,
      suppressed: record.memoryNoteSuppressed ?? -1 },
    envelope: { renderedTextSha256: String(envelope.renderedTextSha256),
      inputSha256: String(envelope.inputSha256), tokens: envelope.tokens },
  } };
}

/** Direct (zero-duration) command through the ONE executor; never a second queue. */
export function direct(runtime: R8Runtime, actorId: string, action: string,
  parameters: Record<string, unknown>): { status: string; eventIds: string[] } {
  const id = `${actorId}-r10b-${action}-${runtime.world.version}`;
  const candidate: Candidate = { id: `r10b-${action}`, kind: action as Candidate['kind'],
    description: action, parameters: { action, ...parameters }, preconditions: [],
    expectedEffects: {}, utilityComponents: {} };
  return executeCandidate(runtime, actorId, candidate, id);
}

export function move(runtime: R8Runtime, actorId: string, to: string, tag: string): void {
  runtime.session.submitWorldCommand({ commandId: `r10b-move-${tag}`, type: 'move',
    actorId, to } as Parameters<typeof runtime.session.submitWorldCommand>[0]);
}

/** Fixture 1: obligations + unrelated chatter, so the two arms really differ. */
export function budgetFixture(): {
  runtime: R8Runtime; play: GameplayLoop; chatter: number } {
  const runtime = R8Runtime.create({ seed: 'r10b-budget' });
  const play = new GameplayLoop(runtime.session);
  play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  for (let index = 0; index < 20; index += 1)
    runtime.session.ingestTeamEvent('team_chatter', { index }, runtime.world.simTime);
  return { runtime, play, chatter: 20 };
}

/** Fixture 2: a witnessed shortage, which is both a note source and a memory. */
export function shortageFixture(): {
  runtime: R8Runtime; play: GameplayLoop; receiptIds: string[]; stock: number } {
  const runtime = R8Runtime.create({ seed: 'r10b-double-booking' });
  const play = new GameplayLoop(runtime.session);
  move(runtime, 'npc_01', 'warehouse', 'a');
  const stock = runtime.world.spatial?.stocks.warehouse.food ?? DEFAULT_WAREHOUSE_FOOD;
  const outcome = direct(runtime, 'npc_01', 'withdraw', { place: 'warehouse', amount: stock });
  const empty = direct(runtime, 'npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  return { runtime, play, receiptIds: [...outcome.eventIds, ...empty.eventIds], stock };
}

export interface CancellationFixture {
  runtime: R8Runtime;
  play: GameplayLoop;
  bridge: ReturnType<typeof createCommitmentBridge>;
  unheardActor: string;
  unheardCommitment: string;
  heardActor: string;
  heardCommitment: string;
  /** The hearer's other target (an accepted task) that must not move. */
  otherTargetTaskId: string;
  referenceActor: string;
  referenceCommitment: string;
}

/**
 * Fixture 3: one private cancellation spoken only to `npc_02`. `npc_01` owns the
 * cancelled promise and is absent; `npc_02` owns two promises and hears only one
 * of them end; `npc_03` is the untouched reference.
 */
export function cancellationFixture(): CancellationFixture {
  const runtime = R8Runtime.create({ seed: 'r10b-unheard' });
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  move(runtime, 'npc_01', 'warehouse', 'u');
  move(runtime, 'npc_02', 'warehouse', 'h1');
  move(runtime, 'npc_03', 'warehouse', 'r');
  const unheard = play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const heard = play.requestCommitment('npc_02', 'deliver-meal', { verdict: 'accept' });
  // A second target for the SAME actor: the engine allows one live commitment
  // per promisor, so the second target is an accepted task in the same goal
  // line. The cancellation must leave it byte-identical.
  const proposed = runtime.dispatch('tasks', 'propose', 'player',
    { type: 'COLLECT_WOOD', assigneeId: 'npc_02' });
  const taskId = proposed.events.map(event => String(event.payload.taskId)).at(-1)!;
  runtime.dispatch('tasks', 'respond', 'npc_02', { taskId, verdict: 'accept' });
  const reference = play.requestCommitment('npc_03', 'deliver-meal', { verdict: 'accept' });
  return {
    runtime, play, bridge,
    unheardActor: 'npc_01', unheardCommitment: unheard.commitment.commitmentId,
    heardActor: 'npc_02', heardCommitment: heard.commitment.commitmentId,
    otherTargetTaskId: taskId,
    referenceActor: 'npc_03', referenceCommitment: reference.commitment.commitmentId,
  };
}

/** Cancel both promises; only the hearer is told. */
export function cancelPrivately(fixture: CancellationFixture): void {
  fixture.play.cancelCommitment(fixture.heardCommitment,
    { heardBy: [fixture.heardActor], reason: '玩家改主意' });
  fixture.play.cancelCommitment(fixture.unheardCommitment,
    { heardBy: [fixture.heardActor], reason: '玩家改主意' });
}

/** Deterministic line helpers used by the byte-level comparison. */
export function splitSegments(segments: { kind: string; index: number | null; text: string }[]):
  Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const segment of segments) {
    const key = segment.kind === 'candidate' ? `candidate:${segment.index}` : segment.kind;
    out[key] = segment.text.split('\n').filter(line => line.length > 0);
  }
  return out;
}

/** Candidate text without its ordinal, so a removal does not look like a rewrite. */
export function candidateBody(text: string): string {
  return text.replace(/^\n\d+\. /, '');
}

export { byteTokenCounter };
