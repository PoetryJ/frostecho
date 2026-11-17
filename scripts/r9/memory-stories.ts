/**
 * R9 (B): four long-horizon memory/commitment stories on the real CPU path.
 *
 * Each story is a complete playable episode, not a probe:
 *   1. heard vs unheard cancellation  (private player statement + relay)
 *   2. source change without agreement (proposal is NOT the agreement)
 *   3. old failure condition lifted    (stale lesson must expire)
 *   4. two promises competing for one meal (no repeated invalid action)
 *
 * Every story contains an interference event, an exit at D2 08:00 with a new
 * process restoring the same authoritative state, and a final fulfilled /
 * exited result. The bounded memory is reported in both arms (raw-last12 as the
 * frozen control, obligation-first as the new policy) with the same count
 * budget, plus the per-record evidence (source, observedAt, speaker, heardBy).
 *
 * Run: node dist/scripts/r9/memory-stories.js --out artifacts/r9/memory-stories
 * Exit code 1 means at least one story failed its own expectation; the
 * partial artifacts are still written.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PlaySession } from '../../src/application-v2/session';
import type { Candidate, ChoiceRequest } from '../../src/decision/contracts';
import { makeChoiceResult } from '../../src/decision/contracts';
import { CouncilBoard } from '../../src/council-v2/council';
import { ExperienceStore } from '../../src/memory/experience';
import { CommitmentBoard, type Commitment } from '../../src/gameplay-v2/commitments';
import { GameplayLoop } from '../../src/gameplay-v2/loop';
import { TaskBoard } from '../../src/gameplay-v2/tasks';
import { applicableNotes, type MemoryPolicyId } from '../../src/r7/agency/options';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { createCommitmentBridge,
  type CommitmentGoalBridge } from '../../src/r7/integration/commitment-bridge';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { executeCandidate, latestStockCondition, notesFor, runStep,
  visibleMemory, type MemorySelection } from '../../src/r7/integration/step';
import { DEFAULT_WAREHOUSE_FOOD, type LocationId } from '../../src/survival/world-v2';

const DAY2_START = 1920; // absolute minute: day 2, 08:00

interface Env {
  runtime: R8Runtime;
  play: GameplayLoop;
  bridge: CommitmentGoalBridge;
  dir: string;
  story: string;
  events: string[];
  steps: Record<string, unknown>[];
}

interface StoryResult {
  story: string;
  passed: boolean;
  checks: { name: string; passed: boolean; detail: unknown }[];
  outcome: Record<string, unknown>;
  memory: Record<string, unknown>;
  files: string[];
}

const results: StoryResult[] = [];
let outRoot = '';

function forced(pick: (request: ChoiceRequest) => Candidate | undefined) {
  return { identity: referenceAgencyScorer().identity, score(request: ChoiceRequest) {
    const candidate = pick(request);
    return makeChoiceResult({ request, scorerId: 'r9-story-scripted',
      scores: request.candidates.map(row => ({ candidateId: row.id,
        logit: Number(row.id === candidate?.id) })),
      disposition: candidate ? 'accept' : 'abstain', selectedId: candidate?.id ?? null,
      reason: candidate ? `scripted:${candidate.id}` : 'no scripted candidate' });
  } };
}

function newEnv(story: string, seed: string): Env {
  const dir = join(outRoot, story);
  mkdirSync(dir, { recursive: true });
  const runtime = R8Runtime.create({ seed });
  const play = new GameplayLoop(runtime.session);
  const bridge = createCommitmentBridge(runtime, play);
  return { runtime, play, bridge, dir, story, events: [], steps: [] };
}

function move(env: Env, actorId: string, to: LocationId): void {
  const result = env.runtime.session.submitWorldCommand({ commandId: `${actorId}-move-${to}-${env.runtime.world.version}`,
    type: 'move', actorId, to });
  if (result.status !== 'applied') throw new Error(`move ${actorId}->${to}: ${result.reason}`);
}

function directAction(env: Env, actorId: string, action: string,
  parameters: Record<string, unknown>): { status: string; reason: string; eventIds: string[] } {
  const candidate: Candidate = { id: `direct-${env.runtime.world.version}-${action}`,
    kind: action as Candidate['kind'], description: `direct ${action}`,
    parameters: { action, ...parameters }, preconditions: [], expectedEffects: {},
    utilityComponents: {} };
  return executeCandidate(env.runtime, actorId, candidate,
    `${actorId}-direct-${env.runtime.world.version}-${action}`);
}

/** One real decision through the shared step contract; the clock settles it. */
async function step(env: Env, actorId: string, pick: (request: ChoiceRequest) => Candidate | undefined,
  selection: MemorySelection = 'obligation-first'): Promise<{ record: Record<string, unknown> | null;
    memory: ReturnType<typeof visibleMemory> | null; request: ChoiceRequest | null }> {
  const captured: { memory?: ReturnType<typeof visibleMemory>;
    request?: ChoiceRequest } = {};
  const result = await runStep(env.runtime, forced(request => {
    // Capture the exact bounded memory this actor was given (both arms).
    captured.memory = visibleMemory(env.runtime, actorId, 12, selection);
    captured.request = request;
    return pick(request);
  }), { actorIds: [actorId], memorySelection: selection, goalBridge: env.bridge });
  const record = (result.records[0] ?? null) as unknown as Record<string, unknown> | null;
  if (record?.executionStatus === 'working') {
    const until = env.runtime.busyUntil(actorId);
    if (until !== null) env.runtime.advanceWorld(until);
  }
  if (record) env.steps.push(record);
  return { record, memory: captured.memory ?? null, request: captured.request ?? null };
}

function candidatesOf(env: Env, actorId: string): { goals: Record<string, unknown>[];
  candidates: Candidate[] } {
  const view = env.bridge.view(actorId);
  return { goals: view.goals as Record<string, unknown>[], candidates: view.candidates };
}

/** Committed receipts of one type for one actor (the real evidence). */
function receiptsOf(env: Env, actorId: string, type: string) {
  return env.runtime.committedEvents().filter(event => event.actorId === actorId
    && event.type === type);
}

/** Status of one step result, safe when the step produced no request at all. */
function statusOf(entry: { record: Record<string, unknown> | null }): string {
  return String(entry.record?.executionStatus ?? 'none');
}

function memoryOf(env: Env, actorId: string) {
  return env.runtime.session.memories.get(actorId)!.toJSON().records;
}

function newProcess(env: Env): Env {
  const path = join(env.dir, 'd2-exit.session.json');
  env.play.save(path);
  env.runtime.save(path);
  const runtime = R8Runtime.load(path);
  const play = gameplayOn(runtime, path);
  return { ...env, runtime, play, bridge: createCommitmentBridge(runtime, play) };
}

/** Rebuild the P loop on the SAME restored session (never a second session). */
function gameplayOn(runtime: R8Runtime, path: string): GameplayLoop {
  const read = (suffix: string): Record<string, unknown> | null => {
    const file = `${path}.${suffix}.json`;
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null;
  };
  const tasks = read('tasks');
  const commitments = read('commitments');
  const council = read('council');
  const experience = read('experience');
  return new GameplayLoop(runtime.session,
    tasks ? TaskBoard.fromJSON(tasks as never) : new TaskBoard(),
    { ...(commitments ? { commitments: CommitmentBoard.fromJSON(commitments as never) } : {}),
      ...(council ? { council: CouncilBoard.fromJSON(council as never) } : {}),
      ...(experience ? { experience: ExperienceStore.fromJSON(experience as never) } : {}) });
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stateFingerprint(env: Env, actorIds: string[]): string {
  return hash({ commitments: env.play.commitments.toJSON(), tasks: env.play.board.toJSON(),
    memories: actorIds.map(id => memoryOf(env, id).map(record => ({
      eventId: record.eventId, kind: record.kind, observedAt: record.observedAt,
      source: record.source, speakerId: record.speakerId,
      heardBy: (record.payload as Record<string, unknown>).heardBy ?? null }))),
    clock: env.runtime.world.simTime });
}

function chatter(env: Env, count: number, tag: string): void {
  for (let index = 0; index < count; index += 1) {
    env.runtime.session.ingestTeamEvent('team_chatter', { tag, index },
      env.runtime.world.simTime);
  }
}

function note(name: string, passed: boolean, detail: unknown = null): StoryResult['checks'][number] {
  return { name, passed, detail };
}

function saveStory(env: Env, story: string, result: StoryResult): void {
  result.files.push(join(env.dir, `${story}.json`));
  writeFileSync(join(env.dir, `${story}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(env.dir, `${story}.steps.jsonl`),
    `${env.steps.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

/** Fill the warehouse shortage: everyone who can, takes the public stock. */
function emptyWarehouse(env: Env, actorId: string): { consumed: number; receipts: string[] } {
  // The warehouse is lazily created at its documented default; before the
  // first spatial command the world has no `spatial` block at all.
  const stock = env.runtime.world.spatial?.stocks.warehouse.food ?? DEFAULT_WAREHOUSE_FOOD;
  if (stock <= 0) return { consumed: 0, receipts: [] };
  move(env, actorId, 'warehouse');
  const outcome = directAction(env, actorId, 'withdraw',
    { place: 'warehouse', amount: stock });
  return { consumed: stock, receipts: outcome.eventIds };
}

function memoryArmReport(env: Env, actorId: string, policy: MemoryPolicyId) {
  const raw = visibleMemory(env.runtime, actorId, 12, 'raw-last12');
  const ranked = visibleMemory(env.runtime, actorId, 12, 'obligation-first');
  const context = { place: 'warehouse', taskState: 'declined',
    stock: latestStockCondition(env.runtime, actorId) };
  const notes = notesFor(env.runtime, actorId);
  return {
    raw: { kinds: raw.facts.map(fact => fact.kind), kept: raw.kept,
      dropped: raw.dropped, bytes: raw.bytes },
    obligationFirst: { kinds: ranked.facts.map(fact => fact.kind), kept: ranked.kept,
      dropped: ranked.dropped, bytes: ranked.bytes },
    keptOnlyByNewPolicy: ranked.facts.map(fact => fact.kind)
      .filter(kind => !raw.facts.map(fact => fact.kind).includes(kind)),
    notesTotal: notes.length,
    notesApplicable: applicableNotes(notes, policy, context).map(entry => entry.noteId),
    condition: context.stock,
    observedAt: ranked.facts.map(fact => ({ kind: fact.kind, observedAt: fact.simTime,
      source: fact.source, speakerId: (fact.payload as Record<string, unknown>).speakerId ?? null,
      heardBy: (fact.payload as Record<string, unknown>).heardBy ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Story 1: heard / unheard cancellation
// ---------------------------------------------------------------------------
async function story1(): Promise<void> {
  const env = newEnv('story1-heard-unheard-cancel', 'r9-story1');
  const checks: StoryResult['checks'] = [];
  move(env, 'npc_01', 'village');
  move(env, 'npc_02', 'warehouse');
  // Two meal promises; the player ends both but speaks only to npc_02.
  const own = env.play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const other = env.play.requestCommitment('npc_02', 'deliver-meal', { verdict: 'accept' });
  const commitmentId = own.commitment.commitmentId;
  const otherId = other.commitment.commitmentId;
  const before = stateFingerprint(env, ['npc_01', 'npc_02']);

  // Interference: the warehouse is restocked in public while npc_01 is away,
  // and the team chatters; none of it is the cancellation.
  env.runtime.session.submitWorldCommand({ commandId: 'restock-noise', type: 'restock',
    place: 'warehouse', resource: 'food', amount: 2, source: 'player' });
  chatter(env, 6, 's1-noise');

  const cancelled = env.play.cancelCommitment(commitmentId, { heardBy: ['npc_02'],
    reason: '玩家改主意，不送了' });
  env.play.cancelCommitment(otherId, { heardBy: ['npc_02'], reason: '玩家改主意，不送了' });
  const heard = candidatesOf(env, 'npc_02');
  const unheard = candidatesOf(env, 'npc_01');
  checks.push(note('the present NPC heard the cancellation and stops',
    heard.goals.length === 1
    && heard.goals.every(goal => goal.status === 'cancelled' && goal.observedTerminal === true)
    && heard.candidates.length === 0,
    { goals: heard.goals.map(goal => ({ status: goal.status, belief: goal.belief })) }));
  checks.push(note('the absent NPC never heard it and still holds a live goal',
    unheard.goals[0]?.status === 'active' && unheard.candidates.length > 0,
    { goals: unheard.goals.map(goal => ({ status: goal.status, belief: goal.belief })),
      candidates: unheard.candidates.map(row => row.parameters.bridgeStep) }));

  // It keeps working: walk back to the warehouse, then take the meal.
  const actions: { step: unknown; status: string }[] = [];
  for (const pick of [
    (request: ChoiceRequest) => request.candidates.find(row => row.parameters.bridgeStep === 'to-warehouse'),
    (request: ChoiceRequest) => request.candidates.find(row => row.parameters.bridgeStep === 'withdraw'),
  ]) {
    const record = await step(env, 'npc_01', pick);
    actions.push({ step: record.record?.selectedId ?? null, status: statusOf(record) });
  }
  const receiptsWhileUnheard = env.runtime.committedEvents()
    .filter(event => event.actorId === 'npc_01').map(event => event.eventId);
  const unheardCancellationInMemory = memoryOf(env, 'npc_01')
    .filter(record => record.kind === 'commitment_cancelled');
  checks.push(note('unheard cancellation did not stop the work (real receipts)',
    actions.length === 2 && receiptsWhileUnheard.length >= 1
    && unheardCancellationInMemory.length === 0,
    { actions, receipts: receiptsWhileUnheard,
      cancellationsKnownToNpc01: unheardCancellationInMemory.length }));

  // D2 exit + new process.
  env.runtime.advanceWorld(DAY2_START);
  const fingerprintBeforeExit = stateFingerprint(env, ['npc_01', 'npc_02']);
  const restored = newProcess(env);
  const fingerprintAfterExit = stateFingerprint(restored, ['npc_01', 'npc_02']);
  checks.push(note('D2 exit restores the same commitment + memory state',
    fingerprintBeforeExit === fingerprintAfterExit,
    { before: fingerprintBeforeExit.slice(0, 16), after: fingerprintAfterExit.slice(0, 16),
      commitment: restored.play.commitments.find(commitmentId)?.status,
      clock: restored.runtime.world.simTime }));
  const stillUnheard = candidatesOf(restored, 'npc_01');
  checks.push(note('after the restart the absent NPC still acts on its belief',
    stillUnheard.candidates.length > 0 && stillUnheard.goals[0]?.belief === 'unheard-cancellation',
    { candidates: stillUnheard.candidates.map(row => row.parameters.bridgeStep) }));

  // A relay is legitimate only from an NPC that actually heard it.
  const illegalRelay = restored.play.relayCancellation(commitmentId,
    { tellerId: 'npc_05', audience: ['npc_01'] });
  checks.push(note('an NPC that never heard the cancellation cannot relay it',
    illegalRelay === null, { relay: illegalRelay }));
  const relay = restored.play.relayCancellation(commitmentId,
    { tellerId: 'npc_02', audience: ['npc_01'] });
  restored.play.relayCancellation(otherId, { tellerId: 'npc_02', audience: ['npc_01'] });
  const afterRelay = candidatesOf(restored, 'npc_01');
  checks.push(note('after the relay the promisor stops (no candidacy, no fulfilment)',
    relay !== null && afterRelay.candidates.length === 0
    && restored.play.commitments.find(commitmentId)?.status === 'cancelled',
    { told: relay?.told ?? null, candidates: afterRelay.candidates.length,
      status: restored.play.commitments.find(commitmentId)?.status }));
  const eventsBefore = restored.runtime.committedEvents().length;
  const postRelay = await step(restored, 'npc_01',
    request => request.candidates.find(row => String(row.parameters.bridgeStep ?? '').length > 0));
  checks.push(note('the stop is observable: the next step offers no commitment action',
    restored.runtime.committedEvents().length === eventsBefore
    && (postRelay.request?.candidates ?? []).every(row =>
      row.parameters.bridgeStep === undefined)
    && afterRelay.candidates.length === 0,
    { offered: (postRelay.request?.candidates ?? []).map(row => row.kind),
      record: postRelay.record?.executionStatus ?? null,
      selected: postRelay.record?.selectedId ?? null }));

  // Provenance: the player statement is a player statement, the relay is an
  // NPC statement about it, and both keep who heard them.
  const records = memoryOf(restored, 'npc_01');
  const cancellationRecords = records.filter(record => record.kind === 'commitment_cancelled');
  checks.push(note('cancellation provenance is player_statement, relay is npc, audience recorded',
    cancellationRecords.length === 2
    && cancellationRecords.every(record => record.source === 'player_statement'
      && record.authority === 'npc' && record.speakerId === 'npc_02'
      && String((record.payload as Record<string, unknown>).heardBy) === 'npc_01'
      && String((record.payload as Record<string, unknown>).toldBy) === 'npc_02'),
    cancellationRecords.map(record => ({ source: record.source, authority: record.authority,
      speakerId: record.speakerId, observedAt: record.observedAt,
      payload: record.payload }))));

  const memory = memoryArmReport(restored, 'npc_01', 'conditional-experience');
  const result: StoryResult = { story: env.story, passed: checks.every(check => check.passed),
    checks,
    outcome: { commitmentStatus: restored.play.commitments.find(commitmentId)?.status,
      fulfilled: restored.play.commitments.find(commitmentId)?.status === 'fulfilled',
      firstCancelEvent: cancelled.event.type,
      actionsBeforeHeard: actions.length, actionsAfterRelay: 0,
      fingerprint: { before, after: fingerprintAfterExit } },
    memory, files: [] };
  saveStory(restored, env.story, result);
  results.push(result);
}

// ---------------------------------------------------------------------------
// Story 2: a requested source change is not an agreement
// ---------------------------------------------------------------------------
async function story2(): Promise<void> {
  const env = newEnv('story2-source-change-not-agreed', 'r9-story2');
  const checks: StoryResult['checks'] = [];
  move(env, 'npc_03', 'warehouse');
  emptyWarehouse(env, 'npc_03');
  move(env, 'npc_01', 'warehouse');
  const requested = env.play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const commitmentId = requested.commitment.commitmentId;

  // The promisor sees the empty warehouse itself: a real out_of_stock receipt.
  const shortage = directAction(env, 'npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  const proposal = await step(env, 'npc_01', request => request.candidates
    .find(row => row.parameters.bridgeStep === 'propose-alt-source'));
  const pending = env.play.commitments.find(commitmentId)!;
  checks.push(note('the promisor proposes an alternative source and waits (pending-change)',
    statusOf(proposal) === 'applied' && pending.status === 'pending-change'
    && pending.changes.some(change => change.kind === 'alt-source' && change.status === 'open'),
    { status: pending.status, changes: pending.changes.map(change => change.status),
      shortageReceipt: shortage.eventIds }));

  const pendingCandidates = candidatesOf(env, 'npc_01');
  checks.push(note('no alternative-source action is offered before the answer',
    pendingCandidates.candidates.every(row => row.parameters.bridgeStep !== 'gather')
    && pendingCandidates.candidates.some(row => row.parameters.bridgeStep === 'await-answer'),
    { steps: pendingCandidates.candidates.map(row => row.parameters.bridgeStep) }));

  // Interference: a player rumour of a restock is a statement, not a fact.
  env.runtime.session.tellRestock('npc_01');
  chatter(env, 8, 's2-noise');
  const rumour = memoryOf(env, 'npc_01').filter(record => record.kind === 'restock_rumor');
  checks.push(note('a rumour stays a player statement (never an engine stock fact)',
    rumour.length === 1 && rumour[0].source === 'player_statement'
    && rumour[0].authority === 'player', rumour.map(record => ({ source: record.source,
      authority: record.authority, observedAt: record.observedAt }))));

  // D2 exit before the beneficiary answers.
  env.runtime.advanceWorld(DAY2_START);
  const before = stateFingerprint(env, ['npc_01']);
  const restored = newProcess(env);
  const after = stateFingerprint(restored, ['npc_01']);
  const restoredPending = restored.play.commitments.find(commitmentId)!;
  checks.push(note('the unanswered proposal and its revision survive the restart',
    before === after && restoredPending.status === 'pending-change'
    && restoredPending.changes.filter(change => change.status === 'open').length === 1,
    { status: restoredPending.status, changes: restoredPending.changes.map(change => change.status) }));

  // Still no un-agreed source action after the restart.
  const stillPending = candidatesOf(restored, 'npc_01');
  checks.push(note('after the restart the un-agreed source is still not actionable',
    stillPending.candidates.every(row => row.parameters.bridgeStep !== 'gather'),
    { steps: stillPending.candidates.map(row => row.parameters.bridgeStep) }));

  // The beneficiary rejects: the ORIGINAL terms stay, with no new source.
  const rejected = restored.play.respondChange(commitmentId, 'reject', { reason: '不同意改源' });
  const afterReject = restored.play.commitments.find(commitmentId)!;
  const originalPath = candidatesOf(restored, 'npc_01');
  checks.push(note('a rejection restores the original terms and never adds the source',
    rejected.event.type === 'commitment_change_rejected' && afterReject.status === 'active'
    && !afterReject.conditions.includes('source:gather')
    && originalPath.candidates.every(row => row.parameters.bridgeStep !== 'gather')
    && originalPath.candidates.some(row => row.parameters.bridgeStep === 'withdraw'
      || row.parameters.bridgeStep === 'rejected-source-shortage'),
    { conditions: afterReject.conditions,
      steps: originalPath.candidates.map(row => row.parameters.bridgeStep) }));

  // Restock is witnessed by the NPC standing there, then the original promise
  // is fulfilled by its own delivery receipt.
  restored.runtime.session.submitWorldCommand({ commandId: 'restock-after-reject',
    type: 'restock', place: 'warehouse', resource: 'food', amount: 2, source: 'player' });
  const witnessed = memoryOf(restored, 'npc_01').filter(record => record.kind === 'stock_restocked');
  const withdraw = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'withdraw'));
  const toKitchen = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'to-kitchen'));
  const deliver = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'deliver'));
  const fulfilled = restored.play.commitments.find(commitmentId)!;
  const delivered = receiptsOf(restored, 'npc_01', 'meal_delivered');
  checks.push(note('the original promise is fulfilled on its own delivery receipt',
    witnessed.length === 1 && statusOf(withdraw) === 'applied'
    && toKitchen.record !== null && delivered.length === 1
    && fulfilled.status === 'fulfilled' && fulfilled.evidenceEventIds.length === 1,
    { status: fulfilled.status, evidence: fulfilled.evidenceEventIds,
      receipts: delivered.map(event => event.eventId),
      withdraw: statusOf(withdraw), deliver: statusOf(deliver) }));

  // Control arm: with an explicit acceptance the same source DOES become real.
  const control = newEnv('story2-common-source-change-agreed', 'r9-story2-agree');
  move(control, 'npc_03', 'warehouse');
  emptyWarehouse(control, 'npc_03');
  move(control, 'npc_01', 'warehouse');
  const controlRequest = control.play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const controlId = controlRequest.commitment.commitmentId;
  directAction(control, 'npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  await step(control, 'npc_01', request => request.candidates
    .find(row => row.parameters.bridgeStep === 'propose-alt-source'));
  control.play.respondChange(controlId, 'accept', { reason: '同意改源' });
  const agreed = control.play.commitments.find(controlId)!;
  const agreedCandidates = candidatesOf(control, 'npc_01');
  move(control, 'npc_01', 'village');
  const gather = await step(control, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'gather'));
  const gatheredReceipt = receiptsOf(control, 'npc_01', 'gathered');
  checks.push(note('an explicit acceptance is what makes the new source executable',
    agreed.status === 'active' && agreed.conditions.includes('source:gather')
    && agreedCandidates.candidates.some(row => row.parameters.bridgeStep === 'gather')
    && gatheredReceipt.length === 1 && control.runtime.workLog.at(-1)?.status === 'applied',
    { status: agreed.status, conditions: agreed.conditions,
      steps: agreedCandidates.candidates.map(row => row.parameters.bridgeStep),
      receipts: gatheredReceipt.map(event => event.eventId) }));

  const memory = memoryArmReport(restored, 'npc_01', 'conditional-experience');
  const result: StoryResult = { story: env.story, passed: checks.every(check => check.passed),
    checks,
    outcome: { statusResponded: rejected.event.type, finalStatus: fulfilled.status,
      evidence: fulfilled.evidenceEventIds, conditionStock: latestStockCondition(restored.runtime, 'npc_01'),
      agreedArmStatus: gatheredReceipt.length === 1 ? 'gather-executed' : 'blocked' },
    memory, files: [] };
  saveStory(restored, env.story, result);
  results.push(result);
}

// ---------------------------------------------------------------------------
// Story 3: the old failure condition is lifted
// ---------------------------------------------------------------------------
async function story3(): Promise<void> {
  const env = newEnv('story3-old-failure-lifted', 'r9-story3');
  const checks: StoryResult['checks'] = [];
  move(env, 'npc_03', 'warehouse');
  emptyWarehouse(env, 'npc_03');
  move(env, 'npc_01', 'warehouse');
  const requested = env.play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const commitmentId = requested.commitment.commitmentId;
  directAction(env, 'npc_01', 'withdraw', { place: 'warehouse', amount: 1 });
  const shortageMemory = memoryArmReport(env, 'npc_01', 'conditional-experience');
  checks.push(note('the witnessed shortage is a conditional lesson (not a permanent rule)',
    shortageMemory.notesTotal === 1 && shortageMemory.notesApplicable.length === 1
    && shortageMemory.condition === 'shortage',
    { notes: shortageMemory.notesTotal, applicable: shortageMemory.notesApplicable }));

  chatter(env, 20, 's3-noise-a');
  env.runtime.advanceWorld(DAY2_START);
  const restored = newProcess(env);
  const afterRestart = memoryArmReport(restored, 'npc_01', 'conditional-experience');
  checks.push(note('the conditional lesson survives the D2 restart',
    afterRestart.notesApplicable.length === 1, { applicable: afterRestart.notesApplicable }));

  // Interference after the restart, then the condition really changes.
  chatter(restored, 4, 's3-noise-b');
  restored.runtime.session.submitWorldCommand({ commandId: 'restock-lift', type: 'restock',
    place: 'warehouse', resource: 'food', amount: 3, source: 'player' });
  chatter(restored, 15, 's3-noise-c');

  const lifted = memoryArmReport(restored, 'npc_01', 'conditional-experience');
  const staleArm = memoryArmReport(restored, 'npc_01', 'unconditioned-experience');
  checks.push(note('the witnessed restock lifts the shortage lesson for this actor',
    lifted.condition === 'restocked'
    && lifted.notesApplicable.length > 0
    && lifted.notesApplicable.every(id => id === 'note-restock-npc_01'),
    { condition: lifted.condition, applicable: lifted.notesApplicable }));
  checks.push(note('the unconditioned arm keeps the stale lesson (real contrast)',
    staleArm.notesApplicable.includes('note-shortage-npc_01')
    && staleArm.notesApplicable.length > lifted.notesApplicable.length,
    { applicable: staleArm.notesApplicable }));
  checks.push(note('the new memory policy keeps the condition change inside the same budget',
    lifted.obligationFirst.kinds.includes('stock_restocked')
    && !lifted.raw.kinds.includes('stock_restocked')
    && lifted.obligationFirst.kept === lifted.raw.kept,
    { raw: lifted.raw.kinds, obligationFirst: lifted.obligationFirst.kinds,
      bytes: { raw: lifted.raw.bytes, obligationFirst: lifted.obligationFirst.bytes } }));

  // Two arms from the SAME post-restock state, in separate processes:
  //  - conditional arm: the shortage lesson expired, so go to the warehouse;
  //  - stale arm: the old lesson still says "gather first".
  const forkPath = join(restored.dir, 'stale-arm.session.json');
  restored.play.save(forkPath);
  restored.runtime.save(forkPath);

  // The conditional arm goes straight back to the original path and fulfils.
  const withdraw = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'withdraw'));
  const toKitchen = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'to-kitchen'));
  const deliver = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'deliver'));
  const fulfilled = restored.play.commitments.find(commitmentId)!;
  const delivered = receiptsOf(restored, 'npc_01', 'meal_delivered');
  checks.push(note('the lifted condition leads to a real fulfilment',
    statusOf(withdraw) === 'applied' && toKitchen.record !== null
    && delivered.length === 1 && fulfilled.status === 'fulfilled',
    { status: fulfilled.status, evidence: fulfilled.evidenceEventIds,
      receipts: delivered.map(event => event.eventId) }));

  const forkRuntime = R8Runtime.load(forkPath);
  const forkPlay = gameplayOn(forkRuntime, forkPath);
  const fork = { ...restored, runtime: forkRuntime, play: forkPlay,
    bridge: createCommitmentBridge(forkRuntime, forkPlay) };
  move(fork, 'npc_01', 'village');
  const wasted = await step(fork, 'npc_01',
    request => request.candidates.find(row => row.parameters.action === 'gather'));
  const wastedLog = forkRuntime.workLog.at(-1);
  checks.push(note('the stale lesson costs a real gathering trip in the control arm',
    wasted.request !== null && wastedLog?.status === 'applied'
    && receiptsOf(fork, 'npc_01', 'gathered').length === 1
    && receiptsOf(fork, 'npc_01', 'meal_delivered').length === 0,
    { status: statusOf(wasted), workStatus: wastedLog?.status ?? null,
      kind: wastedLog?.kind ?? null,
      minutes: (wastedLog?.endsAt ?? 0) - (wastedLog?.startedAt ?? 0) }));

  const result: StoryResult = { story: env.story, passed: checks.every(check => check.passed),
    checks,
    outcome: { conditionBefore: shortageMemory.condition, conditionAfter: lifted.condition,
      finalStatus: fulfilled.status, evidence: fulfilled.evidenceEventIds,
      staleArmWastedMinutes: (forkRuntime.workLog.at(-1)?.endsAt ?? 0)
        - (forkRuntime.workLog.at(-1)?.startedAt ?? 0) },
    memory: { lifted, staleArm }, files: [] };
  saveStory(restored, env.story, result);
  results.push(result);
}

// ---------------------------------------------------------------------------
// Story 4: two promises, one meal
// ---------------------------------------------------------------------------
async function story4(): Promise<void> {
  const env = newEnv('story4-two-promises-one-meal', 'r9-story4');
  const checks: StoryResult['checks'] = [];
  move(env, 'npc_03', 'warehouse');
  const stock = env.runtime.world.spatial?.stocks.warehouse.food ?? DEFAULT_WAREHOUSE_FOOD;
  if (stock > 1) {
    directAction(env, 'npc_03', 'withdraw', { place: 'warehouse', amount: stock - 1 });
  }
  move(env, 'npc_01', 'warehouse');
  move(env, 'npc_02', 'warehouse');
  const first = env.play.requestCommitment('npc_01', 'deliver-meal', { verdict: 'accept' });
  const second = env.play.requestCommitment('npc_02', 'deliver-meal', { verdict: 'accept' });
  checks.push(note('two promises are live at once (different promisors, same resource)',
    first.commitment.status === 'active' && second.commitment.status === 'active',
    { first: first.commitment.status, second: second.commitment.status }));

  // npc_01 wins the last meal, npc_02 meets an observable shortage.
  const take = await step(env, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'withdraw'));
  const miss = await step(env, 'npc_02',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'withdraw'));
  const stockOut = env.runtime.committedEvents()
    .filter(event => event.actorId === 'npc_02' && event.type === 'out_of_stock');
  const pendingSecond = env.play.commitments.find(second.commitment.commitmentId)!;
  checks.push(note('the losing promise records a real shortage and proposes a change',
    statusOf(take) === 'applied' && statusOf(miss) === 'applied'
    && stockOut.length === 1 && pendingSecond.status === 'pending-change',
    { receipts: stockOut.map(event => event.eventId), status: pendingSecond.status }));

  // Interference + D2 exit while the proposal is unanswered.
  chatter(env, 6, 's4-noise');
  env.runtime.advanceWorld(DAY2_START);
  const before = stateFingerprint(env, ['npc_01', 'npc_02']);
  const restored = newProcess(env);
  const after = stateFingerprint(restored, ['npc_01', 'npc_02']);
  checks.push(note('both promises and the shortage evidence survive the D2 restart',
    before === after && restored.play.commitments.find(second.commitment.commitmentId)?.status
      === 'pending-change', { before: before.slice(0, 16), after: after.slice(0, 16) }));

  // The loser must not repeat the invalid action while the answer is pending.
  const repeatSteps: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const attempt = await step(restored, 'npc_02', request => request.candidates
      .find(row => row.parameters.bridgeStep === 'await-answer'));
    repeatSteps.push(statusOf(attempt));
  }
  const shortageCount = restored.runtime.committedEvents()
    .filter(event => event.actorId === 'npc_02' && event.type === 'out_of_stock').length;
  checks.push(note('no repeated invalid action after the shortage (zero extra out_of_stock)',
    shortageCount === 1, { outOfStockReceipts: shortageCount, steps: repeatSteps }));

  // The winner completes the delivery: one promise fulfilled, one still open.
  const toKitchen = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'to-kitchen'));
  const deliver = await step(restored, 'npc_01',
    request => request.candidates.find(row => row.parameters.bridgeStep === 'deliver'));
  const firstDone = restored.play.commitments.find(first.commitment.commitmentId)!;
  const secondState = restored.play.commitments.find(second.commitment.commitmentId)!;
  checks.push(note('the winning promise is fulfilled; the loser is not silently fulfilled',
    firstDone.status === 'fulfilled' && secondState.status !== 'fulfilled'
    && receiptsOf(restored, 'npc_01', 'meal_delivered').length === 1
    && toKitchen.record !== null,
    { first: firstDone.status, second: secondState.status,
      receipts: receiptsOf(restored, 'npc_01', 'meal_delivered').map(event => event.eventId) }));

  // The beneficiary ends the losing promise explicitly (heard by it).
  const ended = restored.play.cancelCommitment(second.commitment.commitmentId,
    { heardBy: ['npc_02'], reason: '没有饭了，这单取消' });
  const afterCancel = candidatesOf(restored, 'npc_02');
  checks.push(note('the cancelled loser stops and the exit is explicit',
    ended.event.type === 'commitment_cancelled'
    && restored.play.commitments.find(second.commitment.commitmentId)?.status === 'cancelled'
    && afterCancel.candidates.length === 0,
    { candidates: afterCancel.candidates.length }));

  const memory = memoryArmReport(restored, 'npc_02', 'conditional-experience');
  const result: StoryResult = { story: env.story, passed: checks.every(check => check.passed),
    checks,
    outcome: { winner: firstDone.status, loser: secondState.status,
      loserFinal: restored.play.commitments.find(second.commitment.commitmentId)?.status,
      outOfStockReceipts: shortageCount, repeatedInvalidActions: shortageCount - 1,
      winnerEvidence: firstDone.evidenceEventIds },
    memory, files: [] };
  saveStory(restored, env.story, result);
  results.push(result);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf('--out');
  outRoot = resolve(index >= 0 ? args[index + 1] : join('artifacts', 'r9', 'memory-stories'));
  mkdirSync(outRoot, { recursive: true });
  await story1();
  await story2();
  await story3();
  await story4();
  const summary = {
    schema: 'frostecho.r9.memory-stories/1',
    out: outRoot,
    sourceHEAD: process.env.FROSTECHO_SOURCE_HEAD ?? null,
    stories: results.map(result => ({ story: result.story, passed: result.passed,
      failedChecks: result.checks.filter(check => !check.passed).map(check => check.name) })),
    allPassed: results.every(result => result.passed),
    executionPath: 'runStep -> beginWork -> advanceWorld -> settleWork -> committed receipt',
    modelCalls: 0,
    note: 'CPU reference-scripted decisions; no model forward pass and no claim of model quality.',
  };
  writeFileSync(join(outRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allPassed) process.exitCode = 1;
}

void main();
