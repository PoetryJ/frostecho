/**
 * G11-live resume — worker A: READ-ONLY semantic verification of one batch.
 *
 * Evidence is re-derived, never trusted: slot envelopes re-read through the shipped
 * readRunRecord (schema + sha256), every wire entry strict-parsed from its RAW response
 * body and bound to the actual recorded session step / Engine command, the command
 * ledger re-executed on a fresh Engine and compared with the events/final world, and
 * request body/model/frozen sampling checked per attempt against plan + ledger.
 *
 * Zero HTTP, no ledger creation, NO file writes. Read/parse failures become named
 * issues; verifyG11Batch never throws.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRunRecord } from '../src/application/persistence';
import { slotChecksum } from '../src/persistence/atomic-slot';
import { campaignJsonPath } from '../src/application/budget-binding';
import { RULES } from '../src/types';
import { reexecuteCommands } from './g07-eval-lib';
import {
  G11_SCENES,
  G11_VERIFY_SCHEMA,
  g11Ok,
  sceneDirOf,
  type G11AttemptCost,
  type G11Scene,
  type G11SceneReport,
  type G11VerifyInput,
  type G11VerifyResult,
} from './g11-live-contracts';

const PLAN_SCHEMA = 'frostecho.g11-live.plan/1';
const SCENE_SCHEMA = 'frostecho.g11-live.scene/1';
const OFFLINE_SCHEMA = 'frostecho.g11-live.offline-ready/1';
const FROZEN = { temperature: 0, maxTokens: 1024, stream: false, thinking: true } as const;
/** W1/W2 are contiguous per-scene attempt ranges of 4 in an 8-post matrix. */
const SCENE_SHARE = 4;

export interface VerifyCtx {
  model: string;
  batchDir: string;
  campaignDir: string;
  totalPosts: number;
}

export interface PlanFile {
  schema: string;
  campaignDir: string;
  batchDir: string;
  service: { http: string; model: string };
  authorization: { totalPosts: number; maxPostsPerScene: number; scenes: string[] };
  config?: Record<string, unknown>;
}

export interface LedgerAttempt {
  attemptId: string;
  seq: number;
  batch: string;
  episodeId: string;
  phase: string;
  state: string;
  outcome?: string;
  totalTokens: number | null;
}

export interface LedgerFile {
  schema?: string;
  campaignId?: string;
  limit: number;
  spent: number;
  attempts: LedgerAttempt[];
}

export interface WireEntry {
  attemptId: string;
  phase: string;
  model: string | null;
  requestBody: unknown;
  requestBodyText?: string;
  status: number | null;
  responseBody: string | null;
  usage: { total_tokens: number | null } | null;
  error: string | null;
}

export interface RequestLike {
  requestId: string;
  episodeId: string;
  kind: string;
  text: string;
  options: string[];
  status: string;
  decision: { goal: string; raw: string };
  outcome: string;
  outcomeReason: string | null;
}

export interface SnapshotLike {
  episodeId: string;
  initialState: unknown;
  commands: { seq: number; command: { commandId: string; actorId: string; type: string } }[];
  events: unknown[];
  finalState: { simTime: number; npcs: Record<string, { hunger: number; location: string }>; food: { kitchen: number } };
  cycles?: Record<string, { cycle: number; reason: string; endState: string; turns: { status: string }[] }[]>;
}

export interface RecordPayload {
  lineage: { baseCommit: string | null; parentSlot: string | null; attemptRange: { first: string; last: string; count: number } };
  meta: { episodeId: string; providerKind: string; model: string | null };
  config: { mode: string; requestModel: string | null; thinking: boolean; timeoutMs: number };
  beforeCloseView: {
    simTime: number;
    budget: { episodeCalls: number; providerCalls: number };
    npcs: { actorId: string; status: string; providerCalls: number; selectedGoal: string | null; selectedGoalBasis: string; wakeAtSimTime: number | null; request: { status: string; outcome: string } | null }[];
  };
  authoritative: {
    snapshot: SnapshotLike;
    requests: Record<string, RequestLike>;
    processed: string[];
    budget: { sessionLimit: number; episodeLimit: number; providerCalls: number; episodeCalls: number };
  };
  wire: WireEntry[];
  campaign: { binding: { locator: string; limit: number }; limit: number; spent: number; known: number | null } | null;
}

export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseJsonFile<T>(path: string): Read<T> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, error: `${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Independent extraction of the model's final text from the raw HTTP body. */
export function modelText(responseBody: string | null): Read<string> {
  if (responseBody === null) return { ok: false, error: 'no raw response body' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return { ok: false, error: 'raw response body is not JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'raw response body is not an object' };
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false, error: 'raw response has no choices' };
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== 'object') return { ok: false, error: 'raw response has no message' };
  const content = (message as { content?: unknown }).content;
  if (content === undefined) return { ok: false, error: 'raw response message has no content' };
  let text: string | null = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts = content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const type = (part as { type?: unknown }).type;
      if (typeof type === 'string' && /reasoning|thinking/i.test(type)) return '';
      const value = (part as { text?: unknown }).text;
      return typeof value === 'string' ? value : '';
    });
    text = parts.join('');
  }
  if (text === null) return { ok: false, error: 'raw response content has no text' };
  if (text.length === 0) return { ok: false, error: 'raw response text is empty' };
  return { ok: true, value: text };
}

/** Strict G11 action parse: exactly one JSON object, no extra keys, no repair. */
export function strictG11Action(text: string): Read<{ type: string; to?: string }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: `not a JSON object: ${JSON.stringify(text.slice(0, 40))}` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not a JSON object' };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const type = record.type;
  if (typeof type !== 'string') return { ok: false, error: 'missing string "type"' };
  if (type === 'move') {
    if (keys.some(key => key !== 'type' && key !== 'to')) return { ok: false, error: 'move has extra keys' };
    const to = record.to;
    if (typeof to !== 'string' || !(RULES.LOCATIONS as readonly string[]).includes(to)) return { ok: false, error: `move.to ${JSON.stringify(to)} is not a location` };
    return { ok: true, value: { type, to } };
  }
  if (!['wait', 'eat', 'stop'].includes(type)) return { ok: false, error: `unknown action ${JSON.stringify(type)}` };
  if (keys.some(key => key !== 'type')) return { ok: false, error: `${type} has extra keys` };
  return { ok: true, value: { type } };
}

/** Strict goal-choice parse: exactly {"goal": one of the request's options}. */
export function strictGoal(text: string, options: readonly string[]): Read<string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not a JSON object' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'not a JSON object' };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'goal') return { ok: false, error: 'goal reply must be exactly {"goal":"..."}' };
  const goal = record.goal;
  if (typeof goal !== 'string') return { ok: false, error: 'goal is not a string' };
  if (!options.includes(goal)) return { ok: false, error: `goal ${JSON.stringify(goal)} is not one of ${options.join('|')}` };
  return { ok: true, value: goal };
}

/** Frozen sampling envelope, checked per attempt from the recorded request body. */
function checkFrozenBody(body: unknown, model: string, label: string, issues: string[]): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    issues.push(`${label}: request body is not an object`);
    return;
  }
  const record = body as Record<string, unknown>;
  if (record.model !== model) issues.push(`${label}: model ${JSON.stringify(record.model)} != plan ${JSON.stringify(model)}`);
  if (record.temperature !== FROZEN.temperature) issues.push(`${label}: temperature ${String(record.temperature)} != ${FROZEN.temperature}`);
  if (record.max_tokens !== FROZEN.maxTokens) issues.push(`${label}: max_tokens ${String(record.max_tokens)} != ${FROZEN.maxTokens}`);
  if (record.stream !== FROZEN.stream) issues.push(`${label}: stream ${String(record.stream)} != ${FROZEN.stream}`);
  const kwargs = record.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
  if (!kwargs || kwargs.enable_thinking !== FROZEN.thinking) issues.push(`${label}: enable_thinking is not ${FROZEN.thinking}`);
  const messages = record.messages;
  if (!Array.isArray(messages) || messages.length !== 1) issues.push(`${label}: the prompt must be exactly one message`);
  else {
    const message = messages[0] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== 'user' || typeof message.content !== 'string') issues.push(`${label}: prompt is not one user text message`);
  }
}

function ledgers(ledgerPath: string): Read<LedgerFile> {
  const parsed = parseJsonFile<LedgerFile>(ledgerPath);
  if (!parsed.ok) return parsed;
  const ledger = parsed.value;
  if (!Array.isArray(ledger.attempts)) return { ok: false, error: `${ledgerPath}: attempts is not an array` };
  if (!Number.isInteger(ledger.limit) || !Number.isInteger(ledger.spent)) return { ok: false, error: `${ledgerPath}: limit/spent are not integers` };
  return { ok: true, value: ledger };
}

function recordOf(path: string): Read<RecordPayload> {
  let read;
  try {
    read = readRunRecord(path);
  } catch (error) {
    return { ok: false, error: `${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!read.ok) return { ok: false, error: `${path}: ${(read.issues ?? []).join('; ')}` };
  return { ok: true, value: read.payload as unknown as RecordPayload };
}

/** Model-driven commands are `<episode>:npc:<actor>:<cycle>:<turn>`; the player's own
 *  commands (player:npc_b:...) must not be counted as model decisions. */
const npcDriven = (payload: RecordPayload, actorId: string): SnapshotLike['commands'] =>
  payload.authoritative.snapshot.commands.filter(entry => entry.command.commandId.includes(`:npc:${actorId}:`));

/** Evidence must still verify after being copied to another mount: compare the tail. */
const pathTail = (path: string): string => path.replace(/\\/g, '/').split('/').slice(-2).join('/');
const sameSlot = (recorded: string | null, batchDir: string, scene: G11Scene): boolean => {
  if (recorded === null) return false;
  const expected = join(batchDir, sceneDirOf(scene), `${sceneDirOf(scene)}-wait.g09.json`);
  return recorded === expected || pathTail(recorded) === `${sceneDirOf(scene)}/${sceneDirOf(scene)}-wait.g09.json`;
};

const isNpc = (payload: RecordPayload, actorId: string): RecordPayload['beforeCloseView']['npcs'][number] | null =>
  payload.beforeCloseView.npcs.find(npc => npc.actorId === actorId) ?? null;

function checkWire(record: RecordPayload, label: string, ledger: Map<string, LedgerAttempt>, model: string, issues: string[], failed: string[]): void {
  if (!Array.isArray(record.wire) || record.wire.length === 0) {
    issues.push(`${label}: wire is empty`);
    return;
  }
  for (const entry of record.wire) {
    const attempt = ledger.get(entry.attemptId);
    if (attempt === undefined) {
      issues.push(`${label}: ${entry.attemptId} is not in the campaign ledger`);
      continue;
    }
    if (attempt.episodeId !== record.meta.episodeId) issues.push(`${label}: ${entry.attemptId} belongs to episode ${attempt.episodeId}, not ${record.meta.episodeId}`);
    if (attempt.batch !== record.meta.episodeId) issues.push(`${label}: ${entry.attemptId} batch ${attempt.batch} != ${record.meta.episodeId}`);
    if (attempt.phase !== entry.phase) issues.push(`${label}: ${entry.attemptId} ledger phase ${attempt.phase} != wire ${entry.phase}`);
    const ledgerTokens = attempt.totalTokens ?? null;
    const wireTokens = entry.usage?.total_tokens ?? null;
    if (ledgerTokens !== wireTokens) issues.push(`${label}: ${entry.attemptId} wire tokens ${String(wireTokens)} != ledger ${String(ledgerTokens)}`);
    if (entry.status === null || entry.error !== null) failed.push(`${label}: ${entry.attemptId} did not finish (${entry.error ?? 'no status'})`);
    checkFrozenBody(entry.requestBody, model, `${label} ${entry.attemptId}`, issues);
  }
  const ids = record.wire.map(entry => entry.attemptId);
  const first = ids[0] ?? '';
  const last = ids.at(-1) ?? '';
  const range = record.lineage.attemptRange;
  if (range.first !== first || range.last !== last || range.count !== ids.length) {
    issues.push(`${label}: attemptRange ${JSON.stringify(range)} does not cover ${first}..${last} (${ids.length})`);
  }
}

/**
 * Integrity vs expectation. A scene that DECLARES it did not succeed is allowed
 * to lack the success shape (no suffix record, no final state, no binding): that
 * is an `expectation` that turned out false, not corrupted evidence. A scene
 * that CLAIMS success is held to every check as an integrity problem, which is
 * what keeps the tamper cases caught.
 */
interface Sink {
  issues: string[];
  expectations: string[];
}

/** Prefix: goal wire binds the request; action wire must be a legal wait. */
function verifyPrefix(record: RecordPayload, scene: G11Scene, ctx: VerifyCtx, ledger: Map<string, LedgerAttempt>, sink: Sink, failed: string[], claims: boolean): void {
  const label = `${scene}/prefix`;
  /** Every remaining `issues.push` below is an INTEGRITY check. */
  const issues = sink.issues;
  const push = (message: string): void => { issues.push(message); };
  const expect = (message: string): void => { (claims ? issues : sink.expectations).push(message); };
  if (record.meta.providerKind !== 'live') issues.push(`${label}: providerKind ${record.meta.providerKind} is not live`);
  if (record.config.requestModel !== ctx.model) issues.push(`${label}: config requestModel ${String(record.config.requestModel)} != plan`);
  if (record.config.thinking !== true) issues.push(`${label}: thinking is not true`);
  if (record.config.timeoutMs !== 120000) issues.push(`${label}: single-request timeout ${String(record.config.timeoutMs)} != 120000`);
  if (record.lineage.parentSlot !== null) issues.push(`${label}: parentSlot must be null, got ${String(record.lineage.parentSlot)}`);
  if (record.wire.length !== 2) issues.push(`${label}: expected 2 posts (goal+action), got ${record.wire.length}`);
  const [goalWire, actionWire] = record.wire;
  if (goalWire === undefined || actionWire === undefined) return;
  if (goalWire.phase !== 'goal') issues.push(`${label}: first wire phase ${goalWire.phase} != goal`);
  if (actionWire.phase !== 'action') issues.push(`${label}: second wire phase ${actionWire.phase} != action`);

  const requestIds = Object.keys(record.authoritative.requests);
  if (requestIds.length !== 1) issues.push(`${label}: expected exactly one goal request, got ${requestIds.length}`);
  const request = requestIds.length === 1 ? record.authoritative.requests[requestIds[0]!] : undefined;

  const goalText = modelText(goalWire.responseBody);
  if (!goalText.ok) {
    if (goalWire.status !== null && goalWire.error === null) push(`${label}: goal response: ${goalText.error}`);
  } else if (request !== undefined) {
    const parsed = strictGoal(goalText.value, request.options);
    if (!parsed.ok) issues.push(`${label}: goal response ${parsed.error}`);
    else {
      if (parsed.value !== 'yield_once') issues.push(`${label}: the model chose ${parsed.value}, not yield_once`);
      if (request.decision.raw !== goalText.value) issues.push(`${label}: decision.raw is not the raw response text`);
      if (request.decision.goal !== parsed.value) issues.push(`${label}: decision.goal ${request.decision.goal} != parsed ${parsed.value}`);
    }
  }

  const actionText = modelText(actionWire.responseBody);
  if (!actionText.ok) {
    // A timed-out action never produced a body; `failed` already names it.
    if (actionWire.status !== null && actionWire.error === null) push(`${label}: action response: ${actionText.error}`);
  } else {
    const parsed = strictG11Action(actionText.value);
    if (!parsed.ok) issues.push(`${label}: action response ${parsed.error}`);
    else if (parsed.value.type !== 'wait') issues.push(`${label}: the only legal prefix action is wait, got ${parsed.value.type}`);
  }

  const npcA = isNpc(record, 'npc_a');
  if (npcA === null) issues.push(`${label}: beforeCloseView has no npc_a`);
  else {
    if (npcA.status !== 'waiting_time' || npcA.wakeAtSimTime !== 1) expect(`${label}: npc_a ${npcA.status} wake ${String(npcA.wakeAtSimTime)}, expected waiting_time wake 1`);
    if (npcA.providerCalls !== 2) expect(`${label}: npc_a providerCalls ${npcA.providerCalls} != 2 (a re-ask would raise it)`);
    if (npcA.selectedGoal !== 'yield_once' || npcA.selectedGoalBasis !== 'session_binding') expect(`${label}: goal ${String(npcA.selectedGoal)} (${npcA.selectedGoalBasis}) is not the bound yield`);
    const seen = npcA.request;
    if (seen === null || seen.status !== 'accepted' || seen.outcome !== 'pending') expect(`${label}: the seen request is ${JSON.stringify(seen)}, expected accepted/pending`);
  }
  if (record.authoritative.processed.length !== 1 || record.authoritative.processed[0] !== requestIds[0]) {
    expect(`${label}: processed ${JSON.stringify(record.authoritative.processed)} does not match the single request`);
  }
  if (request !== undefined) {
    if (request.status !== 'cancelled' || request.outcome !== 'cancelled') expect(`${label}: quit must leave the request cancelled, got ${request.status}/${request.outcome}`);
    if (typeof request.outcomeReason !== 'string' || !request.outcomeReason.includes('closed')) expect(`${label}: cancelled reason ${JSON.stringify(request.outcomeReason)} does not say the game closed`);
  }
  if (record.authoritative.budget.episodeCalls !== 2) expect(`${label}: episodeCalls ${record.authoritative.budget.episodeCalls} != 2`);
  checkCampaign(record, label, ctx, sink, claims);
  checkWire(record, label, ledger, ctx.model, sink.issues, failed);
}

/** The recorded campaign binding must be this ledger and its spent must reach the batch. */
function checkCampaign(record: RecordPayload, label: string, ctx: VerifyCtx, sink: Sink, claims: boolean): void {
  const expect = (message: string): void => { (claims ? sink.issues : sink.expectations).push(message); };
  if (record.campaign === null) {
    expect(`${label}: no campaign binding recorded`);
    return;
  }
  // A charged step that failed before the binding existed records campaign
  // WITHOUT a binding. That is an issue, never a crash: the verifier must still
  // answer for a failure it is supposed to describe.
  const binding = record.campaign.binding as { locator?: unknown } | null;
  if (binding === null || typeof binding.locator !== 'string') {
    expect(`${label}: campaign record has no binding locator`);
  } else if (!binding.locator.replace(/\\/g, '/').endsWith('/campaign.json')) {
    sink.issues.push(`${label}: binding locator ${binding.locator} is not a campaign ledger`);
  }
  if (record.campaign.limit !== ctx.totalPosts) sink.issues.push(`${label}: campaign limit ${record.campaign.limit} != ${ctx.totalPosts}`);
  const lastSeq = Number(record.lineage.attemptRange.last.split('-').at(-1) ?? '0');
  if (record.campaign.spent !== lastSeq) sink.issues.push(`${label}: campaign spent ${record.campaign.spent} != the last attempt seq ${lastSeq}`);
}

/** Suffix: two continuation eats, the authoritative outcome, the whole scene world. */
function verifySuffix(record: RecordPayload, scene: G11Scene, ctx: VerifyCtx, ledger: Map<string, LedgerAttempt>, sink: Sink, failed: string[], claims: boolean): void {
  const label = `${scene}/suffix`;
  /** Every remaining `issues.push` below is an INTEGRITY check. */
  const issues = sink.issues;
  const push = (message: string): void => { issues.push(message); };
  const expect = (message: string): void => { (claims ? issues : sink.expectations).push(message); };
  if (record.meta.providerKind !== 'live') issues.push(`${label}: providerKind ${record.meta.providerKind} is not live`);
  if (record.config.requestModel !== ctx.model) issues.push(`${label}: config requestModel ${String(record.config.requestModel)} != plan`);
  if (record.config.timeoutMs !== 120000) issues.push(`${label}: single-request timeout ${String(record.config.timeoutMs)} != 120000`);
  const slotPath = join(ctx.batchDir, sceneDirOf(scene), `${sceneDirOf(scene)}-wait.g09.json`);
  if (!sameSlot(record.lineage.parentSlot, ctx.batchDir, scene)) issues.push(`${label}: parentSlot ${String(record.lineage.parentSlot)} != ${slotPath}`);
  if (record.wire.length !== 2) issues.push(`${label}: expected 2 continuation posts, got ${record.wire.length}`);
  for (const entry of record.wire) {
    if (entry.phase !== 'action') issues.push(`${label}: ${entry.attemptId} phase ${entry.phase} != action`);
    const text = modelText(entry.responseBody);
    if (!text.ok) {
      issues.push(`${label}: ${entry.attemptId} response: ${text.error}`);
      continue;
    }
    const parsed = strictG11Action(text.value);
    if (!parsed.ok) issues.push(`${label}: ${entry.attemptId} ${parsed.error}`);
    else if (parsed.value.type !== 'eat') issues.push(`${label}: ${entry.attemptId} ${parsed.value.type} is not the recorded eat`);
  }
  const driven = npcDriven(record, 'npc_a');
  if (driven.length !== record.wire.length) issues.push(`${label}: ${driven.length} model-driven commands for ${record.wire.length} wires`);
  record.wire.forEach((entry, index) => {
    const command = driven[index];
    if (command === undefined) return;
    const text = modelText(entry.responseBody);
    if (!text.ok) return;
    const parsed = strictG11Action(text.value);
    if (parsed.ok && parsed.value.type !== command.command.type) {
      issues.push(`${label}: ${entry.attemptId} ${parsed.value.type} != the ${command.command.type} at seq ${command.seq}`);
    }
  });

  const requestIds = Object.keys(record.authoritative.requests);
  if (requestIds.length !== 1) issues.push(`${label}: expected exactly one restored request, got ${requestIds.length}`);
  const request = requestIds.length === 1 ? record.authoritative.requests[requestIds[0]!] : undefined;
  const expectedOutcome = scene === 'W1' ? 'fulfilled' : 'expired';
  if (request !== undefined) {
    if (request.outcome !== expectedOutcome) expect(`${label}: outcome ${request.outcome}, expected ${expectedOutcome}`);
    if (typeof request.outcomeReason !== 'string' || request.outcomeReason.length === 0) expect(`${label}: outcomeReason is empty`);
    for (const entry of record.wire) {
      const body = entry.requestBody as { messages?: { content?: unknown }[] } | null;
      const prompt = body?.messages?.[0]?.content;
      if (typeof prompt === 'string' && request.text.length > 0 && prompt.includes(request.text)) {
        issues.push(`${label}: ${entry.attemptId} re-asks the old request in its prompt`);
      }
    }
  }

  const cycles = record.authoritative.snapshot.cycles?.['npc_a'] ?? [];
  const firstCycle = cycles[0];
  const lastCycle = cycles.at(-1);
  if (firstCycle === undefined || lastCycle === undefined) {
    expect(`${label}: no npc_a cycles`);
  } else {
    if (firstCycle.turns.length !== 2 || firstCycle.turns[1]?.status !== 'waiting_time') expect(`${label}: the restored promise cycle is ${JSON.stringify(firstCycle.turns.map(turn => turn.status))}, expected [ready, waiting_time]`);
    if (lastCycle.turns.length !== 2 || lastCycle.turns[1]?.status !== 'goal_reached') expect(`${label}: the continuation cycle is ${JSON.stringify(lastCycle.turns.map(turn => turn.status))}, expected [ready, goal_reached]`);
    if (!lastCycle.reason.includes('resume unmet need after yield goal settled')) expect(`${label}: continuation reason ${JSON.stringify(lastCycle.reason)} is not the unmet-need resume`);
  }
  const final = record.authoritative.snapshot.finalState;
  if (final.npcs['npc_a']?.hunger !== 90) expect(`${label}: npc_a hunger ${String(final.npcs['npc_a']?.hunger)} != 90`);
  if (final.food.kitchen !== 0) expect(`${label}: kitchen food ${String(final.food.kitchen)} != 0`);
  if (final.simTime !== 1) expect(`${label}: simTime ${String(final.simTime)} != 1`);
  if (record.authoritative.budget.providerCalls !== 4) expect(`${label}: providerCalls ${record.authoritative.budget.providerCalls} != 4`);
  if (record.authoritative.budget.episodeCalls !== 4) expect(`${label}: episodeCalls ${record.authoritative.budget.episodeCalls} != 4`);
  checkCampaign(record, label, ctx, sink, claims);
  checkWire(record, label, ledger, ctx.model, issues, failed);
}

function emptyReports(): G11SceneReport[] {
  return G11_SCENES.map(scene => ({ scene, status: 'not_run', posts: 0, outcome: null, prefix: 'not_run', suffix: 'not_run', slotHashOk: null }));
}

/** Offline precheck evidence: valid only when it names why the run did not start. */
function readOfflineReady(batchDir: string): boolean {
  const path = join(batchDir, 'offline-ready.json');
  const parsed = parseJsonFile<{ schema?: string; mode?: string; classification?: string; reasons?: unknown; reason?: unknown }>(path);
  if (!parsed.ok) return false;
  const value = parsed.value;
  if (value.schema !== OFFLINE_SCHEMA) return false;
  if (value.classification === 'offline_ready' && Array.isArray(value.reasons)) return true;
  // The pre-resume driver wrote the historical shape { schema, at, reason }.
  // That record is still the honest proof of a zero-POST batch: accept it
  // rather than declaring the original offline evidence inconsistent.
  return typeof value.reason === 'string' && value.reason.length > 0;
}

/** Verify one batch, read-only. Never writes, never calls the network, never throws. */
export function verifyG11Batch(input: G11VerifyInput): G11VerifyResult {
  const issues: string[] = [];
  const expectations: string[] = [];
  const sink: Sink = { issues, expectations };
  const failed: string[] = [];
  const emptyCosts: G11VerifyResult['costs'] = { limit: null, spent: 0, attempts: 0, totalTokens: null, unknownUsage: [], byAttempt: [] };
  const emptyPosts: G11VerifyResult['posts'] = { total: 0, perScene: { W1: 0, W2: 0 } };
  const finish = (classification: G11VerifyResult['classification'], evidenceOk: boolean, complete: boolean, scenes: G11SceneReport[], costs: G11VerifyResult['costs'] = emptyCosts, posts: G11VerifyResult['posts'] = emptyPosts): G11VerifyResult => {
    const result: G11VerifyResult = {
      schema: G11_VERIFY_SCHEMA,
      evidenceOk,
      complete,
      ok: evidenceOk && complete,
      classification,
      issues,
      costs,
      posts,
      scenes,
      expectations,
    };
    return { ...result, ok: g11Ok(result) };
  };

  const planPath = join(input.batchDir, 'plan.json');
  if (!existsSync(planPath)) {
    issues.push(`${planPath} is missing`);
    return finish('inconsistent', false, false, emptyReports());
  }
  const planRead = parseJsonFile<PlanFile>(planPath);
  if (!planRead.ok) {
    issues.push(planRead.error);
    return finish('inconsistent', false, false, emptyReports());
  }
  const plan = planRead.value;
  if (plan.schema !== PLAN_SCHEMA) issues.push(`plan schema ${JSON.stringify(plan.schema)} is not ${PLAN_SCHEMA}`);
  if (plan.service.model !== input.model) issues.push(`verify --model ${JSON.stringify(input.model)} != plan ${JSON.stringify(plan.service.model)}`);
  if (plan.authorization.totalPosts !== 8) issues.push(`plan totalPosts ${plan.authorization.totalPosts} != 8`);
  if (plan.authorization.maxPostsPerScene !== SCENE_SHARE) issues.push(`plan maxPostsPerScene ${plan.authorization.maxPostsPerScene} != ${SCENE_SHARE}`);
  const ctx: VerifyCtx = { model: input.model, batchDir: input.batchDir, campaignDir: input.campaignDir, totalPosts: plan.authorization.totalPosts };

  const ledgerPath = campaignJsonPath(input.campaignDir);
  const hasSceneFiles = G11_SCENES.some(scene => existsSync(join(input.batchDir, `scene-${scene}.json`)));
  if (!existsSync(ledgerPath)) {
    if (!hasSceneFiles && readOfflineReady(input.batchDir)) return finish('offline_ready', true, false, emptyReports());
    issues.push(`${ledgerPath} is missing (a run without a ledger is not evidence)`);
    return finish('inconsistent', false, false, emptyReports());
  }
  const ledgerRead = ledgers(ledgerPath);
  if (!ledgerRead.ok) {
    issues.push(ledgerRead.error);
    return finish('inconsistent', false, false, emptyReports());
  }
  const ledger = ledgerRead.value;
  const byId = new Map<string, LedgerAttempt>();
  for (const attempt of ledger.attempts) {
    if (byId.has(attempt.attemptId)) issues.push(`duplicate attemptId in the ledger: ${attempt.attemptId}`);
    byId.set(attempt.attemptId, attempt);
  }
  if (ledger.spent !== ledger.attempts.length) issues.push(`ledger spent ${ledger.spent} != ${ledger.attempts.length} attempts`);
  if (ledger.limit !== ctx.totalPosts) issues.push(`ledger limit ${ledger.limit} != plan ${ctx.totalPosts}`);

  const byAttempt: G11AttemptCost[] = ledger.attempts.map(attempt => ({ attemptId: attempt.attemptId, scene: null, phase: attempt.phase, totalTokens: attempt.totalTokens }));
  let totalTokens = 0;
  const unknownUsage: string[] = [];
  for (const attempt of ledger.attempts) {
    if (attempt.totalTokens === null || attempt.totalTokens === undefined) unknownUsage.push(attempt.attemptId);
    else totalTokens += attempt.totalTokens;
    if (attempt.state !== 'finished' || attempt.outcome !== 'success') failed.push(`${attempt.attemptId}: ledger state ${attempt.state}/${String(attempt.outcome)}`);
  }

  const perScene: Record<G11Scene, number> = { W1: 0, W2: 0 };
  const sceneOf = new Map<string, G11Scene>();
  const reports: G11SceneReport[] = [];
  for (const scene of G11_SCENES) {
    const issuesBefore = issues.length;
    const dir = join(input.batchDir, sceneDirOf(scene));
    const prefixPath = join(dir, `${sceneDirOf(scene)}-prefix-run.run.json`);
    const suffixPath = join(dir, `${sceneDirOf(scene)}-wait-run.run.json`);
    const slotPath = join(dir, `${sceneDirOf(scene)}-wait.g09.json`);
    let prefixOk = false;
    let suffixOk = false;
    let outcome: string | null = null;
    let slotHashOk: boolean | null = null;
    // `claims` = does this scene assert it succeeded? A declared failure may
    // legitimately lack the success shape; a declared success may not.
    const scenePathEarly = join(input.batchDir, `scene-${scene}.json`);
    const sceneFileEarly = parseJsonFile<{ overall: string }>(scenePathEarly);
    const charged = [...byId.values()].filter(attempt => String(attempt.batch).startsWith(scene)).length;
    const claims = sceneFileEarly.ok ? sceneFileEarly.value.overall === 'success' : charged > 0;
    const lose = (message: string): void => { (claims ? issues : expectations).push(message); };
    const prefix = recordOf(prefixPath);
    if (!prefix.ok) lose(prefix.error);
    else {
      verifyPrefix(prefix.value, scene, ctx, byId, sink, failed, claims);
      prefixOk = true;
    }
    const suffix = recordOf(suffixPath);
    if (!suffix.ok) lose(suffix.error);
    else {
      verifySuffix(suffix.value, scene, ctx, byId, sink, failed, claims);
      suffixOk = true;
      const ids = Object.keys(suffix.value.authoritative.requests);
      outcome = ids.length === 1 ? suffix.value.authoritative.requests[ids[0]!]!.outcome : null;
    }
    perScene[scene] = (prefix.ok ? prefix.value.wire.length : 0) + (suffix.ok ? suffix.value.wire.length : 0);

    if (!existsSync(slotPath)) lose(`${scene}: pre-close slot ${slotPath} is missing`);
    const scenePath = join(input.batchDir, `scene-${scene}.json`);
    const sceneFile = parseJsonFile<{ schema: string; overall: string; prefix: { slotSha256: string | null; classification: string }; suffix: { classification: string; slotSha256: string | null } | null }>(scenePath);
    if (!sceneFile.ok) issues.push(sceneFile.error);
    else {
      const value = sceneFile.value;
      if (value.schema !== SCENE_SCHEMA) issues.push(`${scene}: scene file schema ${value.schema} != ${SCENE_SCHEMA}`);
      if (value.overall !== 'success') lose(`${scene}: scene overall ${JSON.stringify(value.overall)} is not success`);
      if (value.prefix.classification !== 'goal_triggered') lose(`${scene}: prefix classification ${value.prefix.classification} != goal_triggered`);
      const expectedSuffix = scene === 'W1' ? 'fulfilled' : 'expired';
      if (value.suffix === null) lose(`${scene}: scene file has no suffix`);
      else {
        if (value.suffix.classification !== expectedSuffix) lose(`${scene}: suffix classification ${value.suffix.classification} != ${expectedSuffix}`);
        const expectedHash = value.suffix.slotSha256;
        if (typeof expectedHash !== 'string' || expectedHash.length === 0) issues.push(`${scene}: scene file records no suffix slot hash`);
        else if (existsSync(slotPath)) {
          const slot = parseJsonFile<{ sha256?: string; payload?: unknown }>(slotPath);
          if (!slot.ok) issues.push(slot.error);
          else {
            const bytesHash = createHash('sha256').update(readFileSync(slotPath)).digest('hex');
            const payloadOk = slot.value.payload !== undefined && slot.value.sha256 !== undefined && slotChecksum(slot.value.payload) === slot.value.sha256;
            slotHashOk = payloadOk && bytesHash === expectedHash;
            if (!payloadOk) issues.push(`${scene}: slot payload checksum does not match its envelope`);
            else if (!slotHashOk) issues.push(`${scene}: slot bytes hash does not match the scene record`);
          }
        }
      }
    }
    reports.push({
      scene,
      status: issues.length > issuesBefore ? 'inconsistent' : prefixOk && suffixOk ? 'complete' : 'incomplete',
      posts: perScene[scene],
      outcome,
      prefix: prefixOk ? 'verified' : 'invalid',
      suffix: suffixOk ? 'verified' : 'invalid',
      slotHashOk,
    });
    for (const record of [prefix, suffix]) if (record.ok) for (const entry of record.value.wire) sceneOf.set(entry.attemptId, scene);
  }
  for (const cost of byAttempt) cost.scene = sceneOf.get(cost.attemptId) ?? null;

  // `expectations` never close the evidence gate: they are success-shape
  // absences of a scene that honestly declared it did not succeed.
  const evidenceOk = issues.length === 0;
  const complete = evidenceOk && failed.length === 0 && reports.every(report => report.status === 'complete');
  // A wire entry that did not finish is an OUTCOME fact, not corrupted evidence.
  expectations.push(...failed);
  const classification: G11VerifyResult['classification'] = complete ? 'complete' : evidenceOk ? 'incomplete' : 'inconsistent';
  return finish(classification, evidenceOk, complete, reports, {
    limit: ledger.limit,
    spent: ledger.spent,
    attempts: ledger.attempts.length,
    totalTokens: unknownUsage.length === 0 ? totalTokens : null,
    unknownUsage,
    byAttempt,
  }, { total: perScene.W1 + perScene.W2, perScene });
}
