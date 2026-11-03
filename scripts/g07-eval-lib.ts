/**
 * G07 worker D — independent evaluation model for the player-message probe.
 *
 * This module owns only the G07 evidence shape: the frozen 8-episode plan, the
 * template fingerprint (the prompt with every data line removed), the strict
 * action re-parser, the paired behaviour metrics and the read-only verifier.
 * It never constructs a game, a provider or a mailbox, and it never writes.
 *
 * Why the fingerprint strips data lines: both arms must render the same
 * instructions; only the `playerMessages` JSON may differ. Hashing the prompt
 * with `playerMessages:`/`observation:`/`goal:`/`feedback:` removed therefore
 * says "same template" without depending on this run's world state or text.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderDecidePrompt } from '../src/agent/providers/http';
import { Engine, replay } from '../src/engine';
import type { Observation } from '../src/agent/contracts';
import type { MailboxSnapshot, MessageMode } from '../src/communication/contracts';
import type {
  AttemptRequestConfig, LiveAttemptBegin, LiveAttemptFinish,
} from '../src/needs/live-contracts';
import type { ReactiveRecord } from '../src/reactive/contracts';
import { RULES, type Location, type WorldState } from '../src/types';
import { canonical } from '../src/util';

export const G07_HARD_CHAT_LIMIT = 8;
export const G07_TIMEOUT_MS = 120_000;
export const G07_EPISODE_SCHEMA = 'frostecho.g07.eval.episode/1' as const;
export const G07_PLAN_SCHEMA = 'frostecho.g07.eval.plan/1' as const;
export const G07_SUMMARY_SCHEMA = 'frostecho.g07.eval.summary/1' as const;
export const G07_STATUS_SCHEMA = 'frostecho.g07.eval.status/1' as const;

export const G07_SCENARIOS = {
  s1: '请把最后一份食物留给我，你先不要吃。',
  s2: '请你先吃这一份食物，不用留给我。',
} as const;

export type G07Scenario = keyof typeof G07_SCENARIOS;

export interface G07PlanEntry {
  index: number;
  rep: 1 | 2;
  scenario: G07Scenario;
  arm: MessageMode;
  episodeId: string;
}

/** Frozen before any request. rep1: off then on; rep2: on then off. */
export const G07_PLAN: readonly G07PlanEntry[] = [
  { index: 1, rep: 1, scenario: 's1', arm: 'off', episodeId: 'g07-r1-s1-off' },
  { index: 2, rep: 1, scenario: 's1', arm: 'on', episodeId: 'g07-r1-s1-on' },
  { index: 3, rep: 1, scenario: 's2', arm: 'off', episodeId: 'g07-r1-s2-off' },
  { index: 4, rep: 1, scenario: 's2', arm: 'on', episodeId: 'g07-r1-s2-on' },
  { index: 5, rep: 2, scenario: 's1', arm: 'on', episodeId: 'g07-r2-s1-on' },
  { index: 6, rep: 2, scenario: 's1', arm: 'off', episodeId: 'g07-r2-s1-off' },
  { index: 7, rep: 2, scenario: 's2', arm: 'on', episodeId: 'g07-r2-s2-on' },
  { index: 8, rep: 2, scenario: 's2', arm: 'off', episodeId: 'g07-r2-s2-off' },
];

export const G07_ACTOR_ORDER = ['npc_a', 'npc_c'] as const;
export const G07_TARGET = 'npc_a';
/** The frozen common start, written independently of buildNeedsWorld. */
export const G07_INITIAL_STATE: WorldState = {
  tick: 0,
  simTime: 0,
  npcs: {
    npc_a: { id: 'npc_a', location: 'kitchen', hunger: 40 },
    npc_b: { id: 'npc_b', location: 'kitchen', hunger: 40 },
    npc_c: { id: 'npc_c', location: 'kitchen', hunger: 70 },
  },
  food: { kitchen: 1, dorm: 0 },
};

/** Frozen sampling; model and timeout are supplied per batch. */
export const G07_FROZEN_SAMPLING = {
  temperature: 0,
  max_tokens: 1024,
  stream: false,
  enableThinking: [true] as boolean[],
} as const;

export function requestConfigFor(model: string | null, timeoutMs: number): AttemptRequestConfig {
  return {
    model,
    temperature: G07_FROZEN_SAMPLING.temperature,
    max_tokens: G07_FROZEN_SAMPLING.max_tokens,
    stream: G07_FROZEN_SAMPLING.stream,
    enableThinking: [...G07_FROZEN_SAMPLING.enableThinking],
    timeoutMs,
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Removes the four data lines; the remaining text is the shared template. */
export function stripPromptData(prompt: string): string {
  return prompt
    .split('\n')
    .filter(line => !line.startsWith('playerMessages:')
      && !line.startsWith('goal:')
      && !line.startsWith('observation:')
      && !line.startsWith('feedback:'))
    .join('\n');
}

/** Fingerprint of the static template, proven arm-independent before hashing. */
export function templateFingerprint(): string {
  const sample = {
    observation: {
      id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: [...RULES.LOCATIONS],
    } as Observation,
    goal: { hungerAtLeast: 70 },
    feedback: null,
  };
  const off = stripPromptData(renderDecidePrompt({ ...sample, playerMessages: [] }));
  const on = stripPromptData(renderDecidePrompt({ ...sample, playerMessages: [{ sender: 'npc_b', text: 'probe' }] }));
  if (off !== on) throw new Error('G07 template differs between arms once the data lines are removed');
  return sha256(off);
}

/** The exact line the template renders for the message data. */
export function playerMessagesLine(prompt: string): string | null {
  const line = prompt.split('\n').find(candidate => candidate.startsWith('playerMessages:'));
  return line ?? null;
}

/* ------------------------------------------------------------------ */
/* the data lines, checked literally (not via the template hash)       */
/* ------------------------------------------------------------------ */

/**
 * The frozen observation, restated here independently of buildNeedsWorld.
 * The template fingerprint deliberately drops this line, so the captured
 * prompt is compared against this object field by field; `reachable` must be
 * exactly this array, in this order.
 */
export const G07_EXPECTED_OBSERVATION = {
  id: 'npc_a',
  location: 'kitchen',
  hunger: 40,
  foodHere: 1,
  reachable: ['dorm', 'kitchen'],
} as const;

export const G07_EXPECTED_GOAL_HUNGER = 70;
/** The exact bytes `renderDecidePrompt` writes for a null feedback. */
export const G07_EXPECTED_FEEDBACK_LINE = 'feedback: null';

export type G07DataLineName = 'observation' | 'goal' | 'feedback';
export type G07LineName = G07DataLineName | 'playerMessages';

/** The whole rendered line for `name`, or null when the prompt has none. */
export function dataLine(prompt: string, name: G07LineName): string | null {
  const prefix = `${name}:`;
  return prompt.split('\n').find(candidate => candidate.startsWith(prefix)) ?? null;
}

/** 0-based index of that line, or -1. */
export function dataLineIndex(prompt: string, name: G07LineName): number {
  const prefix = `${name}:`;
  return prompt.split('\n').findIndex(candidate => candidate.startsWith(prefix));
}

export interface PromptDataLines {
  observation: string | null;
  goal: string | null;
  feedback: string | null;
  playerMessages: string | null;
}

export function promptDataLines(prompt: string): PromptDataLines {
  return {
    observation: dataLine(prompt, 'observation'),
    goal: dataLine(prompt, 'goal'),
    feedback: dataLine(prompt, 'feedback'),
    playerMessages: dataLine(prompt, 'playerMessages'),
  };
}

const OBSERVATION_PREFIX = 'observation: ';
const GOAL_LINE = /^goal: hunger >= (\d+)$/;

function observationIssues(id: string, raw: string): string[] {
  if (!raw.startsWith(OBSERVATION_PREFIX)) {
    return [`${id}: the observation data line is not "observation: <json>": ${raw}`];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(OBSERVATION_PREFIX.length));
  } catch {
    return [`${id}: the observation data line is not JSON: ${raw}`];
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`${id}: the observation data line is not a JSON object: ${raw}`];
  }
  const observed = value as Record<string, unknown>;
  const expected: [string, unknown][] = [
    ['id', G07_EXPECTED_OBSERVATION.id],
    ['location', G07_EXPECTED_OBSERVATION.location],
    ['hunger', G07_EXPECTED_OBSERVATION.hunger],
    ['foodHere', G07_EXPECTED_OBSERVATION.foodHere],
    // Order and length are part of the frozen data, not a set membership.
    ['reachable', [...G07_EXPECTED_OBSERVATION.reachable]],
  ];
  const issues: string[] = [];
  const observedKeys = Object.keys(observed).sort();
  const expectedKeys = expected.map(([key]) => key).sort();
  if (observedKeys.join(',') !== expectedKeys.join(',')) {
    issues.push(`${id}: the observation data line has fields [${observedKeys.join(',')}], expected [${expectedKeys.join(',')}]`);
  }
  for (const [key, want] of expected) {
    if (!sameJson(observed[key], want)) {
      issues.push(`${id}: observation.${key} on the data line is ${JSON.stringify(observed[key] ?? null)}, expected ${JSON.stringify(want)}`);
    }
  }
  return issues;
}

function goalIssues(id: string, raw: string): string[] {
  const match = GOAL_LINE.exec(raw);
  if (match === null) {
    return [`${id}: the goal data line is not "goal: hunger >= ${G07_EXPECTED_GOAL_HUNGER}": ${raw}`];
  }
  const hungerAtLeast = Number(match[1]);
  if (hungerAtLeast !== G07_EXPECTED_GOAL_HUNGER) {
    return [`${id}: goal.hungerAtLeast on the data line is ${hungerAtLeast}, expected ${G07_EXPECTED_GOAL_HUNGER}`];
  }
  return [];
}

function feedbackIssues(id: string, raw: string): string[] {
  if (raw === G07_EXPECTED_FEEDBACK_LINE) return [];
  return [`${id}: the feedback data line is ${JSON.stringify(raw)}, expected ${JSON.stringify(G07_EXPECTED_FEEDBACK_LINE)}`];
}

/** Every claim about one captured prompt's three data lines. */
export function promptDataIssues(id: string, prompt: string): string[] {
  const lines = promptDataLines(prompt);
  const issues: string[] = [];
  if (lines.observation === null) issues.push(`${id}: the prompt has no observation data line`);
  else issues.push(...observationIssues(id, lines.observation));
  if (lines.goal === null) issues.push(`${id}: the prompt has no goal data line`);
  else issues.push(...goalIssues(id, lines.goal));
  if (lines.feedback === null) issues.push(`${id}: the prompt has no feedback data line`);
  else issues.push(...feedbackIssues(id, lines.feedback));
  return issues;
}

/** The chat body's single user prompt, or null when nothing was captured. */
export function promptTextOf(record: G07EpisodeRecord): string | null {
  const exchange = record.http[0];
  if (exchange === undefined) return null;
  const messages = exchange.request.body.messages as { content?: unknown }[] | undefined;
  const content = messages?.[0]?.content;
  return typeof content === 'string' ? content : null;
}

export interface G07PromptCapture {
  episodeId: string;
  arm: MessageMode;
  scenario: G07Scenario;
  rep: number;
  prompt: string;
}

export function promptCaptures(batch: BatchFiles): G07PromptCapture[] {
  const captures: G07PromptCapture[] = [];
  for (const record of batch.episodes.values()) {
    const prompt = promptTextOf(record);
    if (prompt === null) continue;
    captures.push({
      episodeId: record.plan.episodeId,
      arm: record.plan.arm,
      scenario: record.plan.scenario,
      rep: record.plan.rep,
      prompt,
    });
  }
  return captures;
}

/**
 * Batch-level check: every captured prompt must carry the same three data
 * lines byte for byte, and the two arms of one pair may differ on exactly the
 * playerMessages line. Per-episode values are checked against the frozen data
 * by `promptDataIssues`.
 */
export function verifyPromptData(captures: readonly G07PromptCapture[]): string[] {
  const issues: string[] = [];
  for (const capture of captures) {
    issues.push(...promptDataIssues(capture.episodeId, capture.prompt));
  }
  const reference = captures[0];
  if (reference === undefined) return issues;

  const lineCounts = new Set(captures.map(capture => capture.prompt.split('\n').length));
  if (lineCounts.size > 1) {
    issues.push(`the captured prompts do not share one line count (${[...lineCounts].join(', ')})`);
  }
  for (const name of ['observation', 'goal', 'feedback'] as const) {
    const variants = new Set(captures.map(capture => dataLine(capture.prompt, name)));
    if (variants.size > 1) {
      issues.push(`the ${name} data line is not byte-identical across the ${captures.length} captured prompts (${variants.size} variants)`);
    }
  }
  const messageIndex = dataLineIndex(reference.prompt, 'playerMessages');
  for (const capture of captures) {
    const index = dataLineIndex(capture.prompt, 'playerMessages');
    if (index !== messageIndex) {
      issues.push(`${capture.episodeId}: the playerMessages data line sits on line ${index}, ${reference.episodeId} has it on line ${messageIndex}`);
    }
  }
  for (const scenario of ['s1', 's2'] as const) {
    for (const rep of [1, 2] as const) {
      const off = captures.find(capture => capture.scenario === scenario && capture.rep === rep && capture.arm === 'off');
      const on = captures.find(capture => capture.scenario === scenario && capture.rep === rep && capture.arm === 'on');
      if (off === undefined || on === undefined) continue;
      const label = `${scenario}-r${rep}`;
      if (off.prompt === on.prompt) {
        issues.push(`${label}: the two arms captured a byte-identical prompt`);
        continue;
      }
      const offLines = off.prompt.split('\n');
      const onLines = on.prompt.split('\n');
      const differing = offLines
        .map((line, index) => (line === onLines[index] ? -1 : index))
        .filter(index => index >= 0);
      if (differing.length !== 1 || differing[0] !== messageIndex) {
        issues.push(`${label}: the two arms differ on line(s) [${differing.join(',')}] (${offLines.length} vs ${onLines.length} lines), expected only the playerMessages line ${messageIndex}`);
      }
      if (dataLine(off.prompt, 'playerMessages') !== 'playerMessages: []') {
        issues.push(`${label}: the off arm's playerMessages data line is not "playerMessages: []"`);
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* independent Engine re-execution of the recorded ledger              */
/* ------------------------------------------------------------------ */

/**
 * Re-runs a recorded episode on a fresh Engine: the frozen initial state is
 * deep-copied, every recorded command is submitted in ledger order, and each
 * result, the committed events and the final state are compared with what the
 * record claims. A failed episode is re-executed too, when it has commands.
 */
export function reexecuteCommands(record: G07EpisodeRecord): string[] {
  const id = record.plan.episodeId;
  const issues: string[] = [];
  let engine: Engine;
  try {
    engine = new Engine(JSON.parse(JSON.stringify(record.snapshot.initialState)) as WorldState);
  } catch (error) {
    return [`${id}: re-execution could not start from the recorded initial state: ${String(error)}`];
  }
  const recorded = record.snapshot.commands;
  for (const entry of recorded) {
    const commandId = String(entry.command.commandId);
    let result: ReturnType<Engine['submit']>;
    try {
      result = engine.submit(JSON.parse(JSON.stringify(entry.command)) as unknown);
    } catch (error) {
      issues.push(`${id}: re-executing command ${commandId} threw: ${String(error)}`);
      return issues;
    }
    if (result.seq !== entry.seq) {
      issues.push(`${id}: re-executing command ${commandId} produced seq ${result.seq}, the ledger says ${entry.seq}`);
    }
    if (result.commandId !== commandId) {
      issues.push(`${id}: re-executing command ${commandId} echoed commandId ${String(result.commandId)}`);
    }
    if (result.status !== entry.result.status) {
      issues.push(`${id}: re-executing command ${commandId} returned status ${result.status}, the ledger says ${entry.result.status}`);
    }
    if ((result.reason ?? null) !== (entry.result.reason ?? null)) {
      issues.push(`${id}: re-executing command ${commandId} returned reason ${String(result.reason ?? null)}, the ledger says ${String(entry.result.reason ?? null)}`);
    }
    if (!sameJson(result.eventIds, entry.result.eventIds)) {
      issues.push(`${id}: re-executing command ${commandId} produced events ${JSON.stringify(result.eventIds)}, the ledger says ${JSON.stringify(entry.result.eventIds)}`);
    }
  }
  const log = engine.getLog();
  if (log.length !== recorded.length) {
    issues.push(`${id}: re-execution logged ${log.length} commands, the ledger has ${recorded.length}`);
  }
  const events = engine.getEvents();
  if (canonical(events) !== canonical(record.snapshot.events)) {
    issues.push(`${id}: re-executing the recorded commands produced ${events.length} events that differ from the ${record.snapshot.events.length} recorded events`);
  }
  if (canonical(engine.getState()) !== canonical(record.snapshot.finalState)) {
    issues.push(`${id}: re-executing the recorded commands produced a different final state`);
  }
  return issues;
}

export interface StrictAction {
  type: 'move' | 'eat' | 'stop';
  to?: Location;
}

export type ParseOutcome = StrictAction | 'invalid_output' | null;

/**
 * Strict re-parse of raw model text. No repair, no fallback, no coercion:
 * unknown keys (actorId/commandId/payload), unknown types, a move without a
 * legal location and any non-JSON wrapper are all invalid_output.
 */
function countKey(raw: string, key: string): number {
  return (raw.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? []).length;
}

export function strictAction(raw: string | null): ParseOutcome {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 'invalid_output';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid_output';
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const type = record.type;
  if (typeof type !== 'string') return 'invalid_output';
  // JSON.parse silently keeps the last duplicate; an ambiguous object is not
  // a decision this experiment can attribute to the model.
  if (countKey(raw, 'type') !== 1) return 'invalid_output';
  if (keys.includes('to') && countKey(raw, 'to') !== 1) return 'invalid_output';
  if (type === 'eat' || type === 'stop') {
    if (keys.some(key => key !== 'type')) return 'invalid_output';
    return { type };
  }
  if (type === 'move') {
    if (keys.some(key => key !== 'type' && key !== 'to')) return 'invalid_output';
    const to = record.to;
    if (typeof to !== 'string' || !(RULES.LOCATIONS as readonly string[]).includes(to)) return 'invalid_output';
    return { type: 'move', to: to as Location };
  }
  return 'invalid_output';
}

/* ------------------------------------------------------------------ */
/* evidence shapes                                                     */
/* ------------------------------------------------------------------ */

export interface G07HttpExchange {
  at: string;
  request: { method: string; body: Record<string, unknown> };
  response: { status: number; raw: string };
}

export interface G07Attempt {
  attemptId: string;
  begin: LiveAttemptBegin;
  finish: LiveAttemptFinish | null;
}

export interface G07CommandView {
  seq: number;
  commandId: string;
  actorId: string;
  type: string;
  status: string;
  reason: string | null;
  detail: string | null;
  payload: unknown;
}

export interface G07Turn {
  cycle: number;
  actorId: string;
  providerCalled: boolean;
  status: string;
  raw: string | null;
  action: ParseOutcome;
  command: unknown | null;
  exec: G07CommandView | null;
}

export interface G07AdvanceView {
  kind: string;
  actorId: string | null;
  cycle: number | null;
  status: string | null;
  terminal: boolean | null;
  providerCalled: boolean | null;
}

export interface G07Decision {
  advance: G07AdvanceView;
  providerCalls: number;
  turns: G07Turn[];
}

export interface G07Behavior {
  npcAction: ParseOutcome;
  npcAte: boolean;
  npcEat: { status: string; reason: string | null } | null;
  npcLocationAfter: string;
  foodAfterNpc: number;
  npcHunger: { before: number; after: number };
  playerEat: { ok: boolean; detail: string };
  playerEatCommand: { status: string; reason: string | null } | null;
  playerHunger: { before: number; after: number };
  playerFoodAfter: number;
  commands: G07CommandView[];
}

export type G07EpisodeOutcome =
  | 'completed'
  | 'transport_failure'
  | 'budget_blocked'
  | 'protocol_failure';

export interface G07EpisodeRecord {
  schema: typeof G07_EPISODE_SCHEMA;
  plan: G07PlanEntry;
  scenarioText: string;
  requestConfig: AttemptRequestConfig;
  templateFingerprint: string;
  initialState: WorldState;
  send: {
    command: { commandId: string; to: string; text: string };
    receipt: { commandId: string; to: string; seq: number; at: string; outcome: string } | null;
    rejected: string | null;
    invariants: {
      worldUnchanged: boolean;
      commandsUnchanged: boolean;
      eventsUnchanged: boolean;
      callsUnchanged: boolean;
      budgetUnchanged: boolean;
      noHttpRequest: boolean;
      noAttempt: boolean;
    };
  };
  attempts: G07Attempt[];
  http: G07HttpExchange[];
  prompt: {
    sha256: string | null;
    templateSha256: string | null;
    playerMessagesLine: string | null;
    playerMessages: unknown;
  };
  decision: G07Decision | null;
  behavior: G07Behavior | null;
  snapshot: ReactiveRecord;
  mailbox: MailboxSnapshot;
  replayMatches: boolean;
  outcome: G07EpisodeOutcome;
  failure: string | null;
  finishedAt: string;
}

export interface G07EpisodeStatusFile {
  schema: typeof G07_STATUS_SCHEMA;
  episodeId: string;
  status: 'completed' | 'failed' | 'not_run';
  outcome: G07EpisodeOutcome | null;
  detail: string | null;
  at: string;
}

export interface G07PairSide {
  episodeId: string;
  status: 'completed' | 'failed' | 'not_run';
  action: ParseOutcome;
  npcAte: boolean | null;
  foodAfterNpc: number | null;
  playerEatOk: boolean | null;
  npcHungerBefore: number | null;
  npcHungerAfter: number | null;
  playerHungerBefore: number | null;
  playerHungerAfter: number | null;
  tokens: number | null;
  latencyMs: number | null;
}

export interface G07Pair {
  pairId: string;
  scenario: G07Scenario;
  rep: 1 | 2;
  text: string;
  complete: boolean;
  off: G07PairSide | null;
  on: G07PairSide | null;
  delta: {
    actionChanged: boolean | null;
    npcAteChanged: boolean | null;
    foodChanged: boolean | null;
    playerEatChanged: boolean | null;
    tokens: number | null;
    latencyMs: number | null;
  };
}

export interface G07Summary {
  schema: typeof G07_SUMMARY_SCHEMA;
  batch: string;
  mode: 'live' | 'fake';
  model: string;
  version: unknown;
  generatedAt: string;
  budget: { limit: number; spent: number; blocked: number };
  /** Server-side counts, re-derived from the batch directory by the verifier. */
  disk: { episodes: number; statuses: number; begins: number; finishes: number; blocked: number };
  totals: { planned: number; completed: number; failed: number; notRun: number };
  arms: Record<MessageMode, { completed: number; failed: number; notRun: number }>;
  scenarios: Record<G07Scenario, { completed: number; failed: number; notRun: number }>;
  structuralGate: { ok: boolean; checked: string[]; issues: string[] };
  fatal: string | null;
  episodes: {
    index: number;
    episodeId: string;
    scenario: G07Scenario;
    arm: MessageMode;
    rep: number;
    status: 'completed' | 'failed' | 'not_run';
    outcome: G07EpisodeOutcome | null;
    action: ParseOutcome;
    npcAte: boolean | null;
    foodAfterNpc: number | null;
    playerEatOk: boolean | null;
    failure: string | null;
    tokens: number | null;
    latencyMs: number | null;
  }[];
  pairs: G07Pair[];
  note: string;
}

/* ------------------------------------------------------------------ */
/* pure derivations                                                    */
/* ------------------------------------------------------------------ */

export function commandViews(record: ReactiveRecord): G07CommandView[] {
  return record.commands.map(entry => ({
    seq: entry.seq,
    commandId: entry.command.commandId,
    actorId: entry.command.actorId,
    type: entry.command.type,
    status: entry.result.status,
    reason: entry.result.reason ?? null,
    detail: entry.result.detail ?? null,
    payload: entry.command.payload,
  }));
}

export function decisionOf(record: ReactiveRecord, advance: G07AdvanceView): G07Decision {
  const turns: G07Turn[] = [];
  for (const cycle of record.cycles[G07_TARGET] ?? []) {
    for (const turn of cycle.turns) {
      const raw = turn.step?.raw ?? null;
      turns.push({
        cycle: cycle.cycle,
        actorId: turn.actorId,
        providerCalled: turn.providerCalled,
        status: turn.status,
        raw,
        action: strictAction(raw),
        command: turn.step?.command ?? null,
        exec: turn.step?.exec === undefined ? null : {
          seq: turn.step.exec.seq,
          commandId: turn.step.exec.commandId,
          actorId: turn.actorId,
          type: turn.step.command?.type ?? '',
          status: turn.step.exec.status,
          reason: turn.step.exec.reason ?? null,
          detail: turn.step.exec.detail ?? null,
          payload: turn.step.command?.payload ?? null,
        },
      });
    }
  }
  return { advance, providerCalls: record.actors[G07_TARGET]?.providerCalls ?? 0, turns };
}

export function pairSide(entry: G07PlanEntry, record: G07EpisodeRecord | null, status: G07EpisodeStatusFile | null): G07PairSide {
  const finish = record?.attempts[0]?.finish ?? null;
  return {
    episodeId: entry.episodeId,
    status: record === null ? (status?.status ?? 'not_run') : (record.outcome === 'completed' ? 'completed' : 'failed'),
    action: record?.behavior?.npcAction ?? null,
    npcAte: record?.behavior?.npcAte ?? null,
    foodAfterNpc: record?.behavior?.foodAfterNpc ?? null,
    playerEatOk: record?.behavior?.playerEat.ok ?? null,
    npcHungerBefore: record?.behavior?.npcHunger.before ?? null,
    npcHungerAfter: record?.behavior?.npcHunger.after ?? null,
    playerHungerBefore: record?.behavior?.playerHunger.before ?? null,
    playerHungerAfter: record?.behavior?.playerHunger.after ?? null,
    tokens: finish?.usage?.total_tokens ?? null,
    latencyMs: finish?.elapsedMs ?? null,
  };
}

function delta<T>(off: T | null, on: T | null, changed: (a: T, b: T) => boolean): boolean | null {
  if (off === null || on === null) return null;
  return changed(off, on);
}

export function buildPairs(
  records: ReadonlyMap<string, G07EpisodeRecord>,
  statuses: ReadonlyMap<string, G07EpisodeStatusFile>,
): G07Pair[] {
  const pairs: G07Pair[] = [];
  for (const scenario of ['s1', 's2'] as const) {
    for (const rep of [1, 2] as const) {
      const offEntry = G07_PLAN.find(e => e.scenario === scenario && e.rep === rep && e.arm === 'off');
      const onEntry = G07_PLAN.find(e => e.scenario === scenario && e.rep === rep && e.arm === 'on');
      if (offEntry === undefined || onEntry === undefined) continue;
      const off = pairSide(offEntry, records.get(offEntry.episodeId) ?? null, statuses.get(offEntry.episodeId) ?? null);
      const on = pairSide(onEntry, records.get(onEntry.episodeId) ?? null, statuses.get(onEntry.episodeId) ?? null);
      const bothCompleted = off.status === 'completed' && on.status === 'completed';
      pairs.push({
        pairId: `${scenario}-r${rep}`,
        scenario,
        rep,
        text: G07_SCENARIOS[scenario],
        complete: bothCompleted,
        off,
        on,
        delta: {
          actionChanged: delta(off.action, on.action, (a, b) => JSON.stringify(a) !== JSON.stringify(b)),
          npcAteChanged: delta(off.npcAte, on.npcAte, (a, b) => a !== b),
          foodChanged: delta(off.foodAfterNpc, on.foodAfterNpc, (a, b) => a !== b),
          playerEatChanged: delta(off.playerEatOk, on.playerEatOk, (a, b) => a !== b),
          tokens: bothCompleted && off.tokens !== null && on.tokens !== null ? on.tokens - off.tokens : null,
          latencyMs: bothCompleted && off.latencyMs !== null && on.latencyMs !== null ? on.latencyMs - off.latencyMs : null,
        },
      });
    }
  }
  return pairs;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).sort();
}

export interface BatchFiles {
  episodes: Map<string, G07EpisodeRecord>;
  statuses: Map<string, G07EpisodeStatusFile>;
  attempts: {
    begins: LiveAttemptBegin[];
    finishes: LiveAttemptFinish[];
    blocked: { episodeId: string; actorId: string; code: string }[];
    beginIds: Set<string>;
    finishIds: Set<string>;
  };
  plan: Record<string, unknown> | null;
  summary: G07Summary | null;
}

/** Reads the batch exactly as it is on disk. Never creates or rewrites a file. */
export function readBatch(batchDir: string): BatchFiles {
  const episodes = new Map<string, G07EpisodeRecord>();
  for (const name of jsonFilesIn(join(batchDir, 'episodes'))) {
    const record = readJson<G07EpisodeRecord>(join(batchDir, 'episodes', name));
    episodes.set(record.plan.episodeId, record);
  }
  const statuses = new Map<string, G07EpisodeStatusFile>();
  for (const name of jsonFilesIn(join(batchDir, 'status'))) {
    const status = readJson<G07EpisodeStatusFile>(join(batchDir, 'status', name));
    statuses.set(status.episodeId, status);
  }
  const begins: LiveAttemptBegin[] = [];
  const finishes: LiveAttemptFinish[] = [];
  const blocked: { episodeId: string; actorId: string; code: string }[] = [];
  for (const name of jsonFilesIn(join(batchDir, 'attempts'))) {
    const value = readJson<Record<string, unknown>>(join(batchDir, 'attempts', name));
    if (name.endsWith('.begin.json')) begins.push(value as unknown as LiveAttemptBegin);
    else if (name.endsWith('.finish.json')) finishes.push(value as unknown as LiveAttemptFinish);
    else if (name.startsWith('blocked-')) {
      blocked.push({
        episodeId: String(value.episodeId),
        actorId: String(value.actorId),
        code: String(value.code),
      });
    }
  }
  const planPath = join(batchDir, 'plan.json');
  const summaryPath = join(batchDir, 'summary.json');
  return {
    episodes,
    statuses,
    attempts: {
      begins,
      finishes,
      blocked,
      beginIds: new Set(begins.map(b => b.attemptId)),
      finishIds: new Set(finishes.map(f => f.attemptId)),
    },
    plan: existsSync(planPath) ? readJson<Record<string, unknown>>(planPath) : null,
    summary: existsSync(summaryPath) ? readJson<G07Summary>(summaryPath) : null,
  };
}

/* ------------------------------------------------------------------ */
/* read-only verifier                                                  */
/* ------------------------------------------------------------------ */

export interface G07VerifyResult {
  ok: boolean;
  issues: string[];
  /**
   * G07-R1: configuration issues are reported separately. A timeout mismatch
   * between the plan/ledger and the effective game/session layer is a real
   * finding (ok=false) but does not invalidate the behaviour and cost data,
   * so behaviorAndCostOk and configurationConsistent are both exposed.
   */
  configurationIssues: string[];
  behaviorAndCostOk: boolean;
  configurationConsistent: boolean;
  stats: {
    mode: string | null;
    model: string | null;
    planned: number;
    completed: number;
    failed: number;
    notRun: number;
    records: number;
    http: number;
    attempts: number;
    blocked: number;
    spent: number;
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Re-derives every claim from disk: the frozen plan, the captured HTTP bodies,
 * the raw model text, the strict parse, the Engine ledger, the authoritative
 * state, the mailbox and the budget ledger. It never trusts a recorded
 * summary status or a recorded "success" flag on its own.
 */
export function verifyBatch(batchDir: string): G07VerifyResult {
  const issues: string[] = [];
  const configurationIssues: string[] = [];
  const check = (condition: boolean, message: string, kind?: 'configuration'): void => {
    if (!condition) {
      issues.push(message);
      if (kind === 'configuration') configurationIssues.push(message);
    }
  };
  const batch = readBatch(batchDir);
  const plan = batch.plan as (Record<string, unknown> & {
    plan: G07PlanEntry[];
    hardChatLimit: number;
    templateFingerprint: string;
    requestConfig: AttemptRequestConfig;
    model: string;
    mode: 'live' | 'fake';
    scenarios: Record<string, string>;
    version?: unknown;
  }) | null;
  const stats: G07VerifyResult['stats'] = {
    mode: plan?.mode ?? null,
    model: plan?.model ?? null,
    planned: 0,
    completed: 0,
    failed: 0,
    notRun: 0,
    records: batch.episodes.size,
    http: 0,
    attempts: batch.attempts.begins.length,
    blocked: batch.attempts.blocked.length,
    spent: batch.summary?.budget.spent ?? 0,
  };
  const result = (): G07VerifyResult => ({
    ok: issues.length === 0,
    issues,
    configurationIssues,
    behaviorAndCostOk: issues.length === configurationIssues.length,
    configurationConsistent: configurationIssues.length === 0,
    stats,
  });
  if (plan === null) { issues.push('plan.json is missing'); return result(); }
  if (batch.summary === null) { issues.push('summary.json is missing'); return result(); }

  check(plan.plan.length === G07_HARD_CHAT_LIMIT, `plan must contain ${G07_HARD_CHAT_LIMIT} episodes, found ${plan.plan.length}`);
  check(sameJson(plan.plan, G07_PLAN), 'plan does not match the frozen 8-episode order');
  check(sameJson(plan.scenarios, G07_SCENARIOS), 'plan scenario text differs from the frozen text');
  check(plan.hardChatLimit <= G07_HARD_CHAT_LIMIT && plan.hardChatLimit > 0, 'hard chat limit is outside 1..8');
  check(plan.mode === 'live' || plan.mode === 'fake', `unknown batch mode ${String(plan.mode)}`);
  if (plan.mode === 'live') check(plan.hardChatLimit === G07_HARD_CHAT_LIMIT, 'a live batch must use the 8-request hard limit');
  check(plan.requestConfig.temperature === G07_FROZEN_SAMPLING.temperature, 'frozen temperature was not used');
  check(plan.requestConfig.max_tokens === G07_FROZEN_SAMPLING.max_tokens, 'frozen max_tokens was not used');
  check(plan.requestConfig.stream === G07_FROZEN_SAMPLING.stream, 'frozen stream flag was not used');
  check(sameJson(plan.requestConfig.enableThinking, G07_FROZEN_SAMPLING.enableThinking), 'thinking was not enabled');
  check(plan.requestConfig.model === plan.model, 'request config model differs from the planned model');
  check(Number.isFinite(plan.requestConfig.timeoutMs) && plan.requestConfig.timeoutMs > 0
    && plan.requestConfig.timeoutMs <= G07_TIMEOUT_MS, 'timeout is outside the allowed window');
  if (plan.mode === 'live') check(plan.requestConfig.timeoutMs === G07_TIMEOUT_MS, 'a live batch must use the 120000 ms timeout');
  const currentTemplate = templateFingerprint();
  check(plan.templateFingerprint === currentTemplate,
    'the prompt template on disk was recorded with a different fingerprint (source drifted)');

  const summary = batch.summary;
  check(summary.schema === G07_SUMMARY_SCHEMA, 'summary schema is not frostecho.g07.eval.summary/1');
  check(summary.batch === (plan as unknown as { batch?: string }).batch, 'summary batch id differs from plan.json');
  check(summary.mode === plan.mode, 'summary mode differs from plan.json');
  check(summary.model === plan.model, 'summary model differs from plan.json');
  check(sameJson(summary.version, plan.version), 'summary version differs from plan.json');
  check(summary.budget.limit === plan.hardChatLimit, 'summary budget limit differs from plan.json');
  check(summary.episodes.length === G07_PLAN.length, `summary must list ${G07_PLAN.length} episodes`);
  check(summary.totals.planned === G07_PLAN.length, 'summary totals.planned is not 8');
  check(batch.statuses.size === G07_PLAN.length, `expected ${G07_PLAN.length} status files, found ${batch.statuses.size}`);
  check(sameJson(summary.disk, {
    episodes: batch.episodes.size,
    statuses: batch.statuses.size,
    begins: batch.attempts.begins.length,
    finishes: batch.attempts.finishes.length,
    blocked: batch.attempts.blocked.length,
  }), 'summary disk counts differ from the batch directory');

  if (plan.mode === 'live') {
    const preflightPath = join(batchDir, 'preflight.json');
    check(existsSync(preflightPath), 'a live batch has no preflight.json');
    if (existsSync(preflightPath)) {
      const preflight = readJson<{
        ok?: unknown; preflightRequests?: unknown; expectedModel?: unknown; checks?: { ok?: unknown }[];
      }>(preflightPath);
      check(preflight.ok === true, 'live preflight did not pass');
      check(preflight.preflightRequests === 2, 'preflight must record the two read-only GETs');
      check(preflight.expectedModel === plan.model, 'preflight checked a different model');
      check(Array.isArray(preflight.checks) && preflight.checks.length === 2
        && preflight.checks.every(check0 => check0.ok === true), 'preflight checks are not both ok');
    }
  }

  const httpCount = [...batch.episodes.values()].reduce((sum, record) => sum + record.http.length, 0);
  stats.http = httpCount;
  check(batch.attempts.begins.length === batch.attempts.finishes.length,
    `ledger: ${batch.attempts.begins.length} attempts began but ${batch.attempts.finishes.length} finished`);
  for (const id of batch.attempts.beginIds) {
    check(batch.attempts.finishIds.has(id), `ledger: attempt ${id} has no finish record`);
  }
  check(summary.budget.spent === batch.attempts.begins.length,
    `ledger: budget.spent=${summary.budget.spent} but ${batch.attempts.begins.length} attempts began`);
  check(summary.budget.spent <= plan.hardChatLimit, 'ledger: budget spent exceeds the hard limit');
  check(httpCount <= summary.budget.spent, `ledger: ${httpCount} HTTP exchanges recorded but only ${summary.budget.spent} slots were spent`);
  check(summary.budget.blocked === batch.attempts.blocked.length,
    `ledger: budget.blocked=${summary.budget.blocked} but ${batch.attempts.blocked.length} blocked records exist`);
  // G07-R1: every ledger attempt begin must carry the planned timeout too.
  for (const begin of batch.attempts.begins) {
    check(begin.requestConfig.timeoutMs === plan.requestConfig.timeoutMs,
      `attempt ${begin.attemptId}: ledger timeout ${begin.requestConfig.timeoutMs} ms differs from the planned ${plan.requestConfig.timeoutMs} ms`,
      'configuration');
  }

  for (const entry of G07_PLAN) {
    const status = batch.statuses.get(entry.episodeId) ?? null;
    check(status !== null, `${entry.episodeId}: missing final status file`);
    if (status !== null) {
      check(status.schema === G07_STATUS_SCHEMA, `${entry.episodeId}: status schema is unknown`);
      check(status.episodeId === entry.episodeId, `${entry.episodeId}: status file names another episode`);
    }
    const record = batch.episodes.get(entry.episodeId) ?? null;
    const summaryEntry = summary.episodes.find(e => e.episodeId === entry.episodeId) ?? null;
    check(summaryEntry !== null, `${entry.episodeId}: missing from summary.episodes`);
    if (summaryEntry !== null) {
      check(summaryEntry.scenario === entry.scenario && summaryEntry.arm === entry.arm && summaryEntry.rep === entry.rep,
        `${entry.episodeId}: summary entry does not match the plan slot`);
      check(status === null || summaryEntry.status === status.status, `${entry.episodeId}: summary status differs from the status file`);
    }
    const derivedStatus = record === null ? 'not_run' : record.outcome === 'completed' ? 'completed' : 'failed';
    if (status !== null) check(status.status === derivedStatus, `${entry.episodeId}: status file says ${status.status}, records say ${derivedStatus}`);
    if (derivedStatus === 'completed') stats.completed += 1;
    else if (derivedStatus === 'failed') stats.failed += 1;
    else stats.notRun += 1;
    stats.planned += 1;

    if (record === null) {
      // not_run must mean "nothing was spent for this slot".
      check(!batch.attempts.begins.some(begin => begin.episodeId === entry.episodeId),
        `${entry.episodeId}: marked not_run but an attempt was begun`);
      check(!batch.attempts.blocked.some(blocked => blocked.episodeId === entry.episodeId),
        `${entry.episodeId}: marked not_run but a blocked record exists`);
      continue;
    }

    verifyEpisode(entry, record, plan, batch, check);
  }

  // --- the data lines themselves, across the whole batch ---------------
  const captures = promptCaptures(batch);
  for (const issue of verifyPromptData(captures)) check(false, issue);
  check(captures.length === stats.completed,
    `${captures.length} captured prompts for ${stats.completed} completed episodes`);

  check(stats.completed === summary.totals.completed, `summary totals.completed=${summary.totals.completed} but ${stats.completed} completed records exist`);
  check(stats.failed === summary.totals.failed, `summary totals.failed=${summary.totals.failed} but ${stats.failed} failed records exist`);
  check(stats.notRun === summary.totals.notRun, `summary totals.notRun=${summary.totals.notRun} but ${stats.notRun} slots were not run`);
  check(stats.completed + stats.failed + stats.notRun === G07_PLAN.length, 'episode outcomes do not add up to 8');
  check(stats.completed === G07_PLAN.length,
    `batch is incomplete: ${stats.completed}/${G07_PLAN.length} episodes completed (failed=${stats.failed}, notRun=${stats.notRun})`);
  check(summary.fatal === null ? stats.failed === 0 : true, 'summary reports no fatal stop but failed episodes exist');

  for (const pair of summary.pairs) {
    const expected = buildPairs(batch.episodes, batch.statuses).find(candidate => candidate.pairId === pair.pairId);
    check(expected !== undefined, `summary lists an unknown pair ${pair.pairId}`);
    if (expected !== undefined) {
      check(sameJson(pair.off, expected.off) && sameJson(pair.on, expected.on),
        `pair ${pair.pairId}: sides differ from the episode records`);
      check(sameJson(pair.delta, expected.delta), `pair ${pair.pairId}: deltas differ from the episode records`);
    }
  }
  check(summary.pairs.length === 4, `expected 4 paired comparisons, found ${summary.pairs.length}`);

  const expectedGate = structuralGateOf(batch);
  check(sameJson(summary.structuralGate, expectedGate), 'summary structural gate differs from the re-derived gate');
  check(expectedGate.ok, `structural gate failed: ${expectedGate.issues.join('; ')}`);

  return { ok: issues.length === 0, issues, configurationIssues, behaviorAndCostOk: issues.length === configurationIssues.length, configurationConsistent: configurationIssues.length === 0, stats };
}

/** Structural only: the first S1 off/on pair must prove the wiring, not the behaviour. */
export function structuralGateOf(batch: BatchFiles): { ok: boolean; checked: string[]; issues: string[] } {
  const checked = ['g07-r1-s1-off', 'g07-r1-s1-on'];
  const issues: string[] = [];
  const records = checked.map(id => batch.episodes.get(id) ?? null);
  records.forEach((record, index) => {
    const id = checked[index];
    if (record === null) {
      issues.push(`${id}: no episode record`);
      return;
    }
    if (record.outcome !== 'completed') issues.push(`${id}: outcome ${record.outcome}`);
    if (record.http.length !== 1) issues.push(`${id}: ${record.http.length} HTTP request(s)`);
    if (record.attempts.length !== 1) issues.push(`${id}: ${record.attempts.length} provider attempt(s)`);
    const invariants = record.send.invariants;
    if (!invariants.worldUnchanged || !invariants.commandsUnchanged || !invariants.eventsUnchanged
      || !invariants.callsUnchanged || !invariants.budgetUnchanged || !invariants.noHttpRequest || !invariants.noAttempt) {
      issues.push(`${id}: sending the message had a side effect`);
    }
    const content = String(((record.http[0]?.request.body.messages as { content?: string }[] | undefined)?.[0]?.content) ?? '');
    if (content === '') {
      issues.push(`${id}: no captured prompt`);
    } else {
      if (sha256(stripPromptData(content)) !== record.templateFingerprint) issues.push(`${id}: prompt template drifted`);
      const line = playerMessagesLine(content);
      const expected = record.plan.arm === 'off'
        ? 'playerMessages: []'
        : `playerMessages: ${JSON.stringify([{ sender: 'npc_b', text: record.scenarioText }])}`;
      if (line !== expected) issues.push(`${id}: playerMessages line is not the frozen shape`);
    }
  });
  const off = records[0];
  const on = records[1];
  if (off !== null && on !== null && off.templateFingerprint !== on.templateFingerprint) {
    issues.push('the two arms used different templates');
  }
  return { ok: issues.length === 0, checked, issues };
}

function verifyEpisode(
  entry: G07PlanEntry,
  record: G07EpisodeRecord,
  plan: {
    plan: G07PlanEntry[];
    requestConfig: AttemptRequestConfig;
    model: string;
    templateFingerprint: string;
    mode: 'live' | 'fake';
  },
  batch: BatchFiles,
  check: (condition: boolean, message: string, kind?: 'configuration') => void,
): void {
  const id = entry.episodeId;
  check(record.schema === G07_EPISODE_SCHEMA, `${id}: episode schema is unknown`);
  check(sameJson(record.plan, entry), `${id}: record plan differs from the frozen slot`);
  check(record.scenarioText === G07_SCENARIOS[entry.scenario], `${id}: scenario text was altered`);
  check(record.templateFingerprint === plan.templateFingerprint, `${id}: template fingerprint differs from plan.json`);
  check(sameJson(record.requestConfig, plan.requestConfig), `${id}: recorded request config differs from plan.json`);
  // G07-R1: the snapshot carries the timeout the game layer actually used.
  // It must match the planned/ledger value; a divergence (e.g. 15000 ms
  // effective against a recorded 120000 ms) is a configuration finding.
  check(record.snapshot.requestConfig.timeoutMs === plan.requestConfig.timeoutMs,
    `${id}: snapshot timeout ${record.snapshot.requestConfig.timeoutMs} ms differs from the planned ${plan.requestConfig.timeoutMs} ms`,
    'configuration');
  check(record.snapshot.requestConfig.timeoutMs === record.requestConfig.timeoutMs,
    `${id}: snapshot timeout ${record.snapshot.requestConfig.timeoutMs} ms differs from the episode ledger timeout ${record.requestConfig.timeoutMs} ms`,
    'configuration');
  check(sameJson(record.initialState, G07_INITIAL_STATE), `${id}: initial state is not the frozen start`);

  // --- send invariants -------------------------------------------------
  check(record.send.command.to === G07_TARGET, `${id}: message target is not npc_a`);
  check(record.send.command.text === record.scenarioText, `${id}: message text differs from the scenario`);
  check(record.send.command.commandId === `${id}:say:1`, `${id}: unexpected message command id`);
  check(record.send.rejected === null, `${id}: send was rejected: ${String(record.send.rejected)}`);
  check(record.send.receipt !== null && record.send.receipt.outcome === 'new', `${id}: send receipt is not a fresh delivery`);
  const invariants = record.send.invariants;
  check(invariants.worldUnchanged, `${id}: send changed the world`);
  check(invariants.commandsUnchanged, `${id}: send changed the command ledger`);
  check(invariants.eventsUnchanged, `${id}: send emitted an event`);
  check(invariants.callsUnchanged, `${id}: send changed provider calls`);
  check(invariants.budgetUnchanged, `${id}: send consumed chat budget`);
  check(invariants.noHttpRequest, `${id}: send performed an HTTP request`);
  check(invariants.noAttempt, `${id}: send opened a provider attempt`);

  // --- the single decision, from the ledger ----------------------------
  const decision = record.decision;
  check(decision !== null, `${id}: no decision evidence`);
  if (decision !== null) {
    check(decision.advance.kind === 'stepped', `${id}: advance did not step an actor (${decision.advance.kind})`);
    check(decision.advance.actorId === G07_TARGET, `${id}: the stepped actor is not npc_a`);
    check(decision.advance.cycle === 1, `${id}: the decision is not in cycle 1`);
    check(decision.advance.providerCalled === true, `${id}: the step did not call the provider`);
    check(decision.providerCalls === 1, `${id}: npc_a providerCalls=${decision.providerCalls}, expected 1`);
    const called = decision.turns.filter(turn => turn.providerCalled);
    check(called.length === 1, `${id}: ${called.length} provider-called turns, expected 1`);
    check(decision.turns.every(turn => turn.actorId === G07_TARGET), `${id}: a non-target actor decided`);
  }
  check(record.snapshot.actors.npc_c?.providerCalls === 0, `${id}: npc_c spent provider calls`);
  check(record.snapshot.actorOrder.length === 2 && record.snapshot.actorOrder[1] === 'npc_c', `${id}: actor order changed`);
  check(record.snapshot.wakePolicy === 'event', `${id}: wake policy changed`);
  check(record.snapshot.needPolicy === 'recurring', `${id}: need policy changed`);
  check(record.snapshot.mode === (plan.mode === 'live' ? 'live' : 'fixture'),
    `${id}: snapshot mode ${record.snapshot.mode} does not match the ${plan.mode} batch`);

  // --- captured HTTP, independent of the implementation ----------------
  check(record.attempts.length === 1, `${id}: ${record.attempts.length} provider attempts, expected 1`);
  for (const attempt of record.attempts) {
    check(batch.attempts.beginIds.has(attempt.attemptId), `${id}: attempt ${attempt.attemptId} has no begin file`);
    check(batch.attempts.finishIds.has(attempt.attemptId), `${id}: attempt ${attempt.attemptId} has no finish file`);
    check(attempt.begin.episodeId === id, `${id}: attempt belongs to another episode`);
    check(attempt.begin.actorId === G07_TARGET, `${id}: attempt belongs to another actor`);
    check(attempt.begin.cycle === 1, `${id}: attempt is not in cycle 1`);
    check(sameJson(attempt.begin.requestConfig, record.requestConfig), `${id}: attempt config differs from the record`);
    check(attempt.finish !== null, `${id}: attempt ${attempt.attemptId} has no embedded finish`);
    if (attempt.finish !== null) {
      const onDisk = batch.attempts.finishes.find(f => f.attemptId === attempt.attemptId) ?? null;
      check(onDisk !== null && sameJson(onDisk, attempt.finish), `${id}: embedded finish differs from the ledger file`);
    }
  }

  const completed = record.outcome === 'completed';
  if (record.http.length > 0) {
    const exchange = record.http[0];
    const body = exchange.request.body;
    const messages = body.messages as { role?: string; content?: string }[] | undefined;
    check(exchange.request.method === 'POST', `${id}: the request method is not POST`);
    check(body.model === plan.model, `${id}: request model ${String(body.model)} differs from ${plan.model}`);
    check(body.temperature === G07_FROZEN_SAMPLING.temperature, `${id}: request temperature differs`);
    check(body.max_tokens === G07_FROZEN_SAMPLING.max_tokens, `${id}: request max_tokens differs`);
    check(body.stream === G07_FROZEN_SAMPLING.stream, `${id}: request stream flag differs`);
    const thinking = (body.chat_template_kwargs as { enable_thinking?: unknown } | undefined)?.enable_thinking;
    check(thinking === G07_FROZEN_SAMPLING.enableThinking[0], `${id}: request thinking flag differs`);
    check(Array.isArray(messages) && messages.length === 1, `${id}: expected exactly one chat message`);
    const content = messages?.[0]?.content ?? '';
    check(messages?.[0]?.role === 'user', `${id}: the chat message role is not user`);
    check(content !== '', `${id}: the captured prompt is empty`);
    check(sha256(stripPromptData(content)) === record.templateFingerprint, `${id}: captured prompt does not match the template fingerprint`);
    check(record.prompt.sha256 === sha256(content), `${id}: recorded prompt hash differs from the captured prompt`);
    check(record.prompt.templateSha256 === record.templateFingerprint,
      `${id}: recorded template hash differs from the template fingerprint`);
    const line = playerMessagesLine(content);
    const expectedLine = entry.arm === 'off'
      ? 'playerMessages: []'
      : `playerMessages: ${JSON.stringify([{ sender: 'npc_b', text: record.scenarioText }])}`;
    check(line === expectedLine, `${id}: ${entry.arm} arm playerMessages line is not the frozen shape`);
    check(record.prompt.playerMessagesLine === line, `${id}: recorded message line differs from the captured prompt`);
    check(sameJson(record.prompt.playerMessages, memberOfLine(line)), `${id}: recorded message data differs from the captured prompt`);
    // The template hash above strips these three lines; check them field by field.
    for (const issue of promptDataIssues(id, content)) check(false, issue);

    if (exchange.response.status === 200 && completed) {
      let rawContent: unknown = null;
      try {
        const parsed = JSON.parse(exchange.response.raw) as { choices?: { message?: { content?: unknown } }[] };
        rawContent = parsed.choices?.[0]?.message?.content ?? null;
      } catch {
        rawContent = null;
      }
      const modelRaw = record.decision?.turns.find(turn => turn.providerCalled)?.raw ?? null;
      check(typeof rawContent === 'string' && rawContent === modelRaw,
        `${id}: the recorded raw model text is not the text captured on the wire`);
    }
  } else {
    check(!completed, `${id}: completed without a captured HTTP exchange`);
  }

  const commands = record.snapshot.commands;
  const initial = record.snapshot.initialState;
  const finalState = record.snapshot.finalState;
  // No model text and no message can submit for a third actor: the frozen
  // actors are npc_a (NPC) and npc_b (player) only.
  check(commands.every(command => command.command.actorId === G07_TARGET || command.command.actorId === 'npc_b'),
    `${id}: a command came from an actor outside {npc_a, npc_b}`);
  if (completed) check(record.http.length === 1, `${id}: a completed episode has ${record.http.length} HTTP exchanges`);

  // --- independent Engine re-execution (completed and failed slots) ----
  for (const issue of reexecuteCommands(record)) check(false, issue);

  if (!completed) {
    // A failed slot is still inspected, but only to prove that nothing else
    // moved: no behaviour claim, no player eat.
    check(record.behavior === null, `${id}: a failed episode recorded behaviour`);
    check(!commands.some(command => command.command.actorId === 'npc_b'), `${id}: a failed episode submitted the player eat`);
    check(record.failure !== null || record.outcome === 'budget_blocked', `${id}: a failed episode has no reason`);
    check(batch.summary?.fatal !== null, `${id}: an episode failed but the batch did not stop`);
    const mailboxFailed = record.mailbox;
    check(mailboxFailed.receipts.length === mailboxFailed.bindSeq, `${id}: bind receipts do not match the bind sequence`);
    check(Object.keys(mailboxFailed.pending).every(k => k === G07_TARGET), `${id}: a failed episode left a message for a non-target`);
    if (record.outcome === 'budget_blocked') {
      check(record.attempts.length === 0, `${id}: a budget-blocked slot began an attempt`);
      check(mailboxFailed.bindSeq === 0, `${id}: a blocked attempt consumed the message`);
      check((mailboxFailed.pending[G07_TARGET] ?? []).length === 1, `${id}: a blocked attempt did not leave the message pending`);
      check(record.http.length === 0, `${id}: a blocked attempt performed HTTP`);
    } else {
      check(record.attempts.length === 1, `${id}: a failed slot did not make exactly one attempt`);
      check(mailboxFailed.bindSeq === 1, `${id}: a failed attempt did not bind exactly once`);
    }
    check(false, `${id}: episode ended as ${record.outcome}${record.failure === null ? '' : ` (${record.failure})`}`);
    return;
  }

  // --- strict parse vs raw ---------------------------------------------
  const decisionRaw = record.decision?.turns.find(turn => turn.providerCalled)?.raw ?? null;
  const reparse = strictAction(decisionRaw);
  check(sameJson(reparse, record.behavior?.npcAction ?? null), `${id}: strict re-parse differs from the recorded action`);
  const action = reparse;

  // --- Engine ledger ----------------------------------------------------
  check(sameJson(commandViews(record.snapshot), record.behavior?.commands ?? null), `${id}: recorded commands differ from the Engine ledger`);
  const npcEntries = commands.filter(c => c.command.actorId === G07_TARGET);
  const npcEatEntries = npcEntries.filter(c => c.command.type === 'eat');
  if (action !== null && action !== 'invalid_output' && (action.type === 'eat' || action.type === 'move')) {
    check(npcEntries.length === 1, `${id}: expected one npc_a command for a ${action.type} action, found ${npcEntries.length}`);
    const submitted = npcEntries[0];
    if (submitted !== undefined) {
      check(submitted.command.type === action.type, `${id}: submitted action type differs from the parsed action`);
      check(submitted.command.commandId === `${id}:npc:npc_a:1:1`, `${id}: submitted command id is not the frozen formula`);
      if (action.type === 'move') {
        check((submitted.command.payload as { to?: string }).to === action.to, `${id}: submitted move target differs from the parsed target`);
      }
    }
  } else {
    check(npcEntries.length === 0, `${id}: a non-action produced npc_a commands`);
  }
  const npcEat = npcEatEntries[0] ?? null;
  const npcAte = npcEat?.result.status === 'accepted';
  check(record.behavior?.npcAte === npcAte, `${id}: npcAte flag disagrees with the Engine result`);
  check(record.behavior?.npcEat?.status === (npcEat?.result.status ?? null) || (npcEat === null && record.behavior?.npcEat === null),
    `${id}: recorded npc eat status differs from the Engine result`);

  const playerEntries = commands.filter(c => c.command.actorId === 'npc_b' && c.command.type === 'eat');
  check(playerEntries.length === 1, `${id}: the player did not submit exactly one eat`);
  const playerEntry = playerEntries[0] ?? null;
  const playerOk = playerEntry?.result.status === 'accepted';
  check(record.behavior?.playerEat.ok === playerOk, `${id}: recorded player eat result differs from the Engine result`);
  check(record.behavior?.playerEatCommand?.status === (playerEntry?.result.status ?? null),
    `${id}: recorded player command status differs from the Engine result`);
  if (record.behavior !== null) {
    const expectedDetail = playerOk
      ? String(playerEntry?.command.commandId)
      : String(playerEntry?.result.reason ?? playerEntry?.result.status);
    check(record.behavior.playerEat.detail === expectedDetail, `${id}: player eat detail differs from the Engine result`);
  }

  const foodAfterNpc = finalState.food.kitchen + (playerOk ? 1 : 0);
  check(record.behavior?.foodAfterNpc === foodAfterNpc, `${id}: recorded food-after-npc differs from the ledger`);
  check(foodAfterNpc === initial.food.kitchen - (npcAte ? RULES.EAT_FOOD_COST : 0), `${id}: food accounting does not match the eat result`);
  check(finalState.food.kitchen === initial.food.kitchen - (npcAte ? 1 : 0) - (playerOk ? 1 : 0), `${id}: final food does not match both eat results`);
  if (record.behavior !== null) {
    check(record.behavior.npcHunger.before === initial.npcs[G07_TARGET].hunger, `${id}: npc hunger before is not the frozen start`);
    check(record.behavior.playerHunger.before === initial.npcs.npc_b.hunger, `${id}: player hunger before is not the frozen start`);
    const expectedNpcHunger = npcAte
      ? Math.min(RULES.HUNGER_MAX, initial.npcs[G07_TARGET].hunger + RULES.EAT_HUNGER_RESTORE)
      : initial.npcs[G07_TARGET].hunger;
    check(record.behavior.npcHunger.after === expectedNpcHunger, `${id}: npc hunger after does not follow the eat rule`);
    check(record.behavior.npcHunger.after === finalState.npcs[G07_TARGET].hunger, `${id}: recorded npc hunger differs from the final state`);
    const expectedPlayerHunger = playerOk
      ? Math.min(RULES.HUNGER_MAX, initial.npcs.npc_b.hunger + RULES.EAT_HUNGER_RESTORE)
      : initial.npcs.npc_b.hunger;
    check(record.behavior.playerHunger.after === expectedPlayerHunger, `${id}: player hunger after does not follow the eat rule`);
    check(record.behavior.playerHunger.after === finalState.npcs.npc_b.hunger, `${id}: recorded player hunger differs from the final state`);
    check(record.behavior.playerFoodAfter === finalState.food.kitchen, `${id}: recorded player food differs from the final state`);
    check(record.behavior.npcLocationAfter === finalState.npcs[G07_TARGET].location, `${id}: recorded npc location differs from the final state`);
    if (action !== null && action !== 'invalid_output' && action.type === 'move') {
      check(record.behavior.npcLocationAfter === action.to, `${id}: an accepted move did not change the location`);
    }
  }

  // --- state replay, mailbox, outcome ----------------------------------
  check(record.replayMatches, `${id}: the recorded replay flag is false`);
  check(canonical(replay(initial, record.snapshot.events)) === canonical(finalState), `${id}: replaying the events does not rebuild the final state`);
  check(record.snapshot.events.every(event => commands.some(entry => entry.command.commandId === event.commandId)),
    `${id}: an event has no committed command`);
  const mailbox = record.mailbox;
  check(mailbox.schema === 'frostecho.g07.mailbox/1', `${id}: mailbox schema is unknown`);
  check(mailbox.sender === 'npc_b', `${id}: mailbox sender is not npc_b`);
  check(mailbox.messageSeq === 1, `${id}: mailbox message sequence is not 1`);
  check(mailbox.bindSeq === 1, `${id}: mailbox bind sequence is not 1`);
  check(Object.keys(mailbox.pending).length === 0, `${id}: a message was left pending`);
  const dedupeValues = Object.values(mailbox.dedupe);
  check(dedupeValues.length === 1, `${id}: mailbox dedupe table does not hold exactly one message`);
  check(dedupeValues[0]?.text === record.scenarioText, `${id}: the dedupe text differs from the scenario`);
  check(mailbox.receipts.length === 1, `${id}: expected exactly one bind receipt`);
  const receipt = mailbox.receipts[0];
  if (receipt !== undefined) {
    const expectedStatus = entry.arm === 'off'
      ? 'suppressed'
      : (completed ? 'attempted' : 'failed');
    check(receipt.actorId === G07_TARGET, `${id}: the bind receipt names another actor`);
    check(receipt.status === expectedStatus, `${id}: receipt status ${receipt.status}, expected ${expectedStatus}`);
    check(receipt.text === record.scenarioText, `${id}: the receipt text differs from the scenario`);
    check(receipt.sender === 'npc_b', `${id}: the receipt sender is not npc_b`);
  }
  if (entry.arm === 'off') {
    check(record.prompt.playerMessages !== null && Array.isArray(record.prompt.playerMessages)
      && (record.prompt.playerMessages as unknown[]).length === 0, `${id}: off arm leaked message data into the prompt`);
  }

  check(record.failure === null, `${id}: a completed episode carries a failure`);
  check(record.attempts[0]?.finish?.outcome === 'success', `${id}: the completed attempt did not succeed`);
}

function memberOfLine(line: string | null): unknown {
  if (line === null) return null;
  try {
    return JSON.parse(line.slice('playerMessages:'.length));
  } catch {
    return 'invalid';
  }
}
