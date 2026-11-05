/**
 * G09-R1 worker D — the ORIGINAL experiment matrix, the shared runtime
 * factory, full HTTP evidence and the read-only verifier.
 *
 * The expectations come from the frozen contract (spec-lock), never from the
 * batch's own plan.json: a corrupted plan or summary must be REJECTED, not
 * echoed. Campaign chat budget is task-scoped and persistent across batches and
 * processes; a batch is only a subdirectory.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildNeedsWorld } from '../src/needs/game';
import { parseAction } from '../src/agent/parser';
import type { WorldState } from '../src/types';
import type { GoalProtocolOptions } from '../src/agent/contracts';
import {
  G09_ALLOWED_GOALS, G09_EPISODE_SCHEMA, G09_EPISODE_SCHEMA_V2, G09_HARD_CHAT_LIMIT, G09_PLAN_SCHEMA,
  G09_REQUEST_TEXT, G09_TIMEOUT_MS, G09_GOAL_MODE, G09_SATIETY_LEVELS,
  fulfilmentVerdict, strictGoalChoice,
  type FulfillmentEvidence, type GoalArm, type GoalBinding, type GoalRequestSnapshot,
  type GoalChoiceId, type SatietyLevel,
} from '../src/negotiation/contracts';
import { bindingIssues, replayRequestOutcome } from '../src/negotiation/goal-check';
import { validateGoalRequestSnapshot } from '../src/negotiation/requests';
import { reexecuteCommands } from './g07-eval-lib';

/** G10: /3 adds derived per-episode fields, known subtotals and the world axis. */
export const G09_SUMMARY_SCHEMA = 'frostecho.g09.summary/3';

export const G09_NPC = 'npc_a';
export const G09_PLAYER = 'npc_b';
export const G09_OTHER = 'npc_c';
export const G09_REPS = 2;

/* ------------------------------------------------------------------ */
/* Frozen matrix (rep 2 is the exact reverse)                          */
/* ------------------------------------------------------------------ */

export interface G09Cell { cell: string; satiety: SatietyLevel; arm: GoalArm }

/** Order: r1 40/self, 40/choice, 60/self, 60/choice; r2 reversed. */
export const G09_CELLS: readonly G09Cell[] = [
  { cell: 's40-self_only', satiety: 40, arm: 'self_only' },
  { cell: 's40-choice', satiety: 40, arm: 'choice' },
  { cell: 's60-self_only', satiety: 60, arm: 'self_only' },
  { cell: 's60-choice', satiety: 60, arm: 'choice' },
];

export interface G09PlanEntry {
  index: number;
  episodeId: string;
  rep: number;
  cell: string;
  satiety: SatietyLevel;
  arm: GoalArm;
  /** BOTH arms carry the SAME host request id — only candidates differ. */
  requestId: string;
}

export interface G09Plan {
  schema: typeof G09_PLAN_SCHEMA;
  batch: string;
  plan: G09PlanEntry[];
  hardChatLimit: number;
  repCount: number;
  runtime: ReturnType<typeof g09RuntimeConfig>;
}

const REP_ORDER: readonly number[] = [0, 1, 2, 3];

export function g09Plan(batch: string): G09Plan {
  const plan: G09PlanEntry[] = [];
  let index = 0;
  for (let rep = 1; rep <= G09_REPS; rep += 1) {
    const order = rep === 1 ? REP_ORDER : [...REP_ORDER].reverse();
    for (const cellIndex of order) {
      const cell = G09_CELLS[cellIndex]!;
      index += 1;
      const episodeId = `g09-r${rep}-${cell.cell}`;
      plan.push({
        index, episodeId, rep, cell: cell.cell, satiety: cell.satiety, arm: cell.arm,
        requestId: `${episodeId}-req-1`,
      });
    }
  }
  return { schema: G09_PLAN_SCHEMA, batch, plan, hardChatLimit: G09_HARD_CHAT_LIMIT, repCount: G09_REPS, runtime: g09RuntimeConfig() };
}

/** The frozen world: player 40, companion 70, one kitchen food, NPC at the cell satiety. */
export function g09InitialState(satiety: SatietyLevel): WorldState {
  const state = buildNeedsWorld({
    actorIds: [G09_NPC, G09_OTHER],
    kitchenFood: 1,
    hunger: { [G09_NPC]: satiety, [G09_PLAYER]: 40, [G09_OTHER]: 70 },
  });
  return state;
}

export function g09Protocol(entry: Pick<G09PlanEntry, 'arm' | 'requestId'>): GoalProtocolOptions {
  return {
    arm: entry.arm,
    requestId: entry.requestId,
    text: G09_REQUEST_TEXT,
    options: G09_ALLOWED_GOALS[entry.arm],
    expiresAtSimTime: 1,
    playerId: G09_PLAYER,
  };
}

/**
 * The ONE shared runtime factory used by the eval and the CLI. The frozen
 * contract is recurring needs + event wake + timed_wait actions + negotiated
 * goals over [npc_a, npc_c].
 */
export function g09RuntimeConfig(): {
  actorIds: readonly string[];
  needPolicy: 'recurring';
  policy: 'event';
  actionSet: 'timed_wait';
  goalMode: typeof G09_GOAL_MODE;
} {
  return {
    actorIds: [G09_NPC, G09_OTHER],
    needPolicy: 'recurring',
    policy: 'event',
    actionSet: 'timed_wait',
    goalMode: G09_GOAL_MODE,
  };
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val as Record<string, unknown>).sort().map(k => [k, (val as Record<string, unknown>)[k]]));
    }
    return val;
  });
}

/**
 * The frozen plan derived from the CONTRACT (not from disk). Verification
 * compares the disk plan against this; a rewritten plan can never be its own
 * standard.
 */
export function frozenPlanEntries(): G09PlanEntry[] {
  return g09Plan('frozen').plan;
}

/* ------------------------------------------------------------------ */
/* Episode record (full HTTP evidence)                                 */
/* ------------------------------------------------------------------ */

export interface G09HttpExchange {
  phase: 'goal' | 'action';
  /** The immutable attempt this exchange belongs to (from the ledger). */
  attemptId: string;
  /** The exact outbound body (model, sampling, messages). */
  requestBody: unknown;
  /** The full response: status + body + usage. */
  response: { status: number | null; body: string | null; usage: { total_tokens: number | null; prompt_tokens: number | null; completion_tokens: number | null } | null };
  /** The prompt actually rendered for this call. */
  prompt: string;
  /** sha256 of the prompt, for the source/prompt fingerprint. */
  promptFingerprint: string;
  elapsedMs: number;
  error: string | null;
}

export { createWireCollector, wireUsage, type G09WireCapture } from '../src/agent/providers/wire';

/**
 * G10: the truthful outcome vocabulary. `completed` means BOTH protocol
 * phases were legally served by the wire; a failed action phase can never be
 * recorded as completed, and the derived value (never the recorded one) is
 * what the verifier counts.
 */
export type G09Outcome =
  | 'completed'
  | 'invalid_action'
  | 'output_truncated'
  | 'empty_output'
  | 'invalid_run'
  | 'insufficient_budget'
  | 'timeout'
  | 'provider_error'
  | 'request_expired'
  | 'not_run';

export interface G09EpisodeRecord {
  schema: typeof G09_EPISODE_SCHEMA;
  episodeId: string;
  cell: string;
  satiety: SatietyLevel;
  arm: GoalArm;
  outcome: G09Outcome;
  request: GoalRequestSnapshot | null;
  binding: GoalBinding | null;
  goal: { round: number; raw: string | null; parseOk: boolean; error: string | null };
  action: { round: number | null; raw: string | null; parseOk: boolean; type: string | null; error: string | null };
  fulfilment: { verdict: string; evidence: FulfillmentEvidence; outcome: string; reason: string | null } | null;
  playerEat: { ok: boolean; detail: string | null } | null;
  http: G09HttpExchange[];
  attempts: { attemptId: string; outcome: string }[];
  tokens: { goal: number | null; action: number | null; total: number | null };
  snapshot: { initialState: WorldState; commands: unknown[]; events: unknown[]; finalState: WorldState };
  runtime: ReturnType<typeof g09RuntimeConfig>;
  failure: string | null;
}

export interface G09Summary {
  schema: string;
  batch: string;
  createdAt: string;
  mode: 'live' | 'fake';
  model: string | null;
  hardChatLimit: number;
  protocol: { planned: number; completed: number; failed: number; notRun: number; goalPhases: number; actionPhases: number };
  goals: { feed_self: number; yield_once: number; byCell: Record<string, Record<string, number>> };
  fulfilment: {
    /** Protocol-valid episodes only (an invalid action never counts). */
    byCell: Record<string, Record<string, number>>;
    /** World facts of EVERY bound episode, independent of protocol validity. */
    world: Record<string, number>;
  };
  costs: {
    chatRequests: number; spent: number; blocked: number; unresolved: number;
    /**
     * True only when an ACTUALLY ATTEMPTED phase has no usage (or never
     * finished). Phases that were never sent (not_run) cost 0 and are NOT
     * unknown.
     */
    usageUnknown: boolean;
    goalTokens: number | null; actionTokens: number | null; totalTokens: number | null;
    /** Always computable: the sum over phases whose usage is known. */
    knownGoalTokens: number; knownActionTokens: number; knownTotalTokens: number;
    unknownPhases: number; notRunPhases: number;
    campaignLimit: number; campaignSpent: number;
    byCell: Record<string, {
      goalTokens: number | null; actionTokens: number | null; requests: number;
      knownGoalTokens: number; knownActionTokens: number; unknownPhases: number;
    }>;
  };
  episodes: G09DerivedEpisode[];
}

/** One episode as DERIVED from raw materials, never from its own claims. */
export interface G09DerivedEpisode {
  episodeId: string; cell: string; arm: string; satiety: number;
  /** Derived protocol outcome. */
  outcome: G09Outcome;
  /** What the record claimed (a mismatch is a verification issue). */
  recordedOutcome: string;
  goal: string | null;
  goalParseOk: boolean;
  request: string | null;
  verdict: string | null;
  /** Both phases legally served by the wire. */
  protocolValid: boolean;
  goalKind: string;
  actionKind: string;
  goalTokens: number | null;
  actionTokens: number | null;
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export interface G09Batch {
  dir: string;
  plan: G09Plan | null;
  episodes: G09EpisodeRecord[];
  summary: G09Summary | null;
  problems: string[];
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readG09Batch(batchDir: string): G09Batch {
  const problems: string[] = [];
  const plan = readJson<G09Plan>(join(batchDir, 'plan.json'));
  if (plan === null) problems.push('plan.json is missing or unreadable');
  const episodes: G09EpisodeRecord[] = [];
  const episodesDir = join(batchDir, 'episodes');
  if (existsSync(episodesDir)) {
    for (const name of readdirSync(episodesDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const record = readJson<G09EpisodeRecord>(join(episodesDir, name));
      if (record === null) { problems.push(`episodes/${name}: unreadable`); continue; }
      episodes.push(record);
    }
  }
  const summary = readJson<G09Summary>(join(batchDir, 'summary.json'));
  return { dir: batchDir, plan, episodes, summary, problems };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                             */
/* ------------------------------------------------------------------ */

export interface G09Ledger {
  issues: string[];
  begins: number;
  finishes: number;
  blocked: number;
  unresolved: number;
  usageUnknown: boolean;
  /** Sum over attempts whose usage is known (always computable). */
  knownTokenSum: number;
  beginsById: Map<string, { attemptId: string; episodeId: string; requestConfig: Record<string, unknown> | null }>;
  finishesById: Map<string, { outcome: string; totalTokens: number | null; status: number | null }>;
  blockedIds: string[];
}

interface RawBegin { attemptId: string; episodeId: string; actorId: string; round: number; requestConfig?: Record<string, unknown> | null }
interface RawFinish { attemptId: string; outcome: string; status: number | null; usage: { total_tokens: number | null } | null }

export function deriveG09Ledger(batchDir: string, episodes: G09EpisodeRecord[]): G09Ledger {
  const issues: string[] = [];
  const beginsById = new Map<string, RawBegin>();
  const finishesById = new Map<string, RawFinish>();
  const blockedIds: string[] = [];
  const attemptsDir = join(batchDir, 'attempts');
  if (existsSync(attemptsDir)) {
    for (const name of readdirSync(attemptsDir).sort()) {
      if (name.endsWith('.begin.json')) {
        const value = readJson<RawBegin>(join(attemptsDir, name));
        if (value === null) { issues.push(`attempts/${name}: unreadable`); continue; }
        if (beginsById.has(value.attemptId)) issues.push(`attempt ${value.attemptId} began twice`);
        beginsById.set(value.attemptId, value);
      } else if (name.endsWith('.finish.json')) {
        const value = readJson<RawFinish>(join(attemptsDir, name));
        if (value === null) { issues.push(`attempts/${name}: unreadable`); continue; }
        if (finishesById.has(value.attemptId)) issues.push(`attempt ${value.attemptId} finished twice`);
        finishesById.set(value.attemptId, value);
      } else if (name.startsWith('blocked-')) {
        blockedIds.push(name);
      } else {
        issues.push(`attempts/${name}: unexpected ledger file`);
      }
    }
  }
  for (const [attemptId, begin] of beginsById) {
    if (!finishesById.has(attemptId)) issues.push(`${begin.episodeId}: attempt ${attemptId} began but never finished (spent, outcome unknown)`);
  }
  for (const attemptId of finishesById.keys()) {
    if (!beginsById.has(attemptId)) issues.push(`attempt ${attemptId} finished without a begin`);
  }
  const claimed = new Map<string, string>();
  for (const record of episodes) {
    for (const attempt of record.attempts ?? []) {
      if (claimed.has(attempt.attemptId)) issues.push(`attempt ${attempt.attemptId} is claimed by two episodes`);
      claimed.set(attempt.attemptId, record.episodeId);
    }
    // Every recorded exchange must point at its OWN immutable attempt.
    const ids = new Set((record.attempts ?? []).map(attempt => attempt.attemptId));
    for (const exchange of record.http ?? []) {
      if (typeof exchange.attemptId !== 'string' || exchange.attemptId.length === 0) {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange carries no attemptId`);
      } else if (!ids.has(exchange.attemptId)) {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange points at attempt ${exchange.attemptId} which this episode does not own`);
      } else {
        const begin = beginsById.get(exchange.attemptId);
        if (begin === undefined) issues.push(`${record.episodeId}: ${exchange.phase} exchange attempt ${exchange.attemptId} has no begin entry`);
        else if (begin.episodeId !== record.episodeId) issues.push(`${begin.attemptId}: begin belongs to ${begin.episodeId} but ${record.episodeId} claims it`);
        else {
          const beginModel = (begin.requestConfig ?? {}).model;
          const bodyModel = (exchange.requestBody as { model?: unknown } | null)?.model;
          if (beginModel !== bodyModel) {
            issues.push(`${record.episodeId}: ${exchange.phase} exchange model ${JSON.stringify(bodyModel)} disagrees with the begin requestConfig ${JSON.stringify(beginModel)}`);
          }
        }
      }
      const body = exchange.requestBody as { model?: string | null } | null;
      if (body === null || typeof body !== 'object' || typeof body.model !== 'string') {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange carries no outbound request body/model`);
      }
      if (typeof exchange.prompt !== 'string' || exchange.prompt.length === 0) {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange carries no prompt`);
      }
    }
  }
  for (const [attemptId, begin] of beginsById) {
    const owner = claimed.get(attemptId);
    if (owner === undefined) issues.push(`${begin.episodeId}: attempt ${attemptId} is not claimed by any episode record`);
    else if (owner !== begin.episodeId) issues.push(`attempt ${attemptId} belongs to ${begin.episodeId} but ${owner} claims it`);
  }
  const unresolved = [...beginsById.keys()].filter(id => !finishesById.has(id)).length;
  const tokenValues = [...finishesById.values()].map(finish => finish.usage?.total_tokens ?? null);
  const usageUnknown = unresolved > 0 || tokenValues.some(value => value === null);
  const knownTokenSum = tokenValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    issues, begins: beginsById.size, finishes: finishesById.size, blocked: blockedIds.length,
    unresolved, usageUnknown, knownTokenSum,
    beginsById: new Map([...beginsById].map(([id, begin]) => [id, { attemptId: id, episodeId: begin.episodeId, requestConfig: begin.requestConfig ?? null }])),
    finishesById: new Map([...finishesById].map(([id, finish]) => [id, { outcome: finish.outcome, totalTokens: finish.usage?.total_tokens ?? null, status: finish.status }])),
    blockedIds,
  };
}

/* ------------------------------------------------------------------ */
/* Exchange classification (G10)                                       */
/* ------------------------------------------------------------------ */

/**
 * What the WIRE said, independent of what the record claims. `ok` means the
 * body carried a non-empty final content on a normal finish; the strict
 * parsers still decide whether that text is a legal goal/action.
 */
export type G09ExchangeKind =
  | 'ok'
  | 'http_error'
  | 'invalid_response_json'
  | 'output_truncated'
  | 'empty_output'
  | 'no_exchange';

export interface G09ExchangeClassification {
  kind: G09ExchangeKind;
  httpStatus: number | null;
  finishReason: string | null;
  content: string;
}

const REASONING_TYPES = new Set(['reasoning', 'thinking', 'reasoning_text', 'redacted_reasoning']);

function contentOfMessage(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const type = (part as { type?: unknown }).type;
    if (typeof type === 'string' && REASONING_TYPES.has(type)) return '';
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }).join('');
}

export function classifyHttpExchange(exchange: G09HttpExchange | undefined): G09ExchangeClassification {
  if (exchange === undefined) return { kind: 'no_exchange', httpStatus: null, finishReason: null, content: '' };
  const status = exchange.response.status;
  const body = exchange.response.body;
  let parsed: unknown;
  let parseFailed = false;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { parseFailed = true; }
  } else if (body !== null && body !== undefined) {
    parsed = body;
  }
  if (body === null || body === undefined) {
    // No body at all: an HTTP failure if a status says so, else an empty read.
    return status !== null && (status < 200 || status >= 300)
      ? { kind: 'http_error', httpStatus: status, finishReason: null, content: '' }
      : { kind: 'empty_output', httpStatus: status, finishReason: null, content: '' };
  }
  if (parseFailed) return { kind: 'invalid_response_json', httpStatus: status, finishReason: null, content: '' };
  const choice = (parsed as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] } | null)?.choices?.[0];
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  const content = contentOfMessage(choice?.message?.content);
  if (status !== null && (status < 200 || status >= 300)) {
    return { kind: 'http_error', httpStatus: status, finishReason, content };
  }
  // An exhausted generation budget is OUTPUT_TRUNCATED even when the text
  // happens to look like complete JSON; it is never executed.
  if (finishReason === 'length') return { kind: 'output_truncated', httpStatus: status, finishReason, content };
  if (content.length === 0) return { kind: 'empty_output', httpStatus: status, finishReason, content };
  return { kind: 'ok', httpStatus: status, finishReason, content };
}

/* ------------------------------------------------------------------ */
/* Derivation                                                         */
/* ------------------------------------------------------------------ */

export interface G09Derivation {
  issues: string[];
  protocol: G09Summary['protocol'];
  goals: G09Summary['goals'];
  fulfilment: G09Summary['fulfilment'];
  costs: G09Summary['costs'];
  episodes: G09Summary['episodes'];
}

/**
 * Tokens of ONE actually-attempted phase. A phase that was never sent (the
 * episode is not_run) has no exchange: it is not a cost and NOT unknown —
 * the caller simply does not include it.
 */
function tokensOf(exchange: G09HttpExchange | undefined): number | null {
  if (exchange === undefined) return null;
  return exchange.response.usage?.total_tokens ?? null;
}

function mapExchangeFailure(kind: G09ExchangeKind): G09Outcome {
  switch (kind) {
    case 'output_truncated': return 'output_truncated';
    case 'empty_output': return 'empty_output';
    case 'http_error': return 'provider_error';
    case 'invalid_response_json': return 'provider_error';
    default: return 'invalid_run';
  }
}

/**
 * G10: derive ONE episode from the wire + strict parsers + the request
 * ledger, never from the record's own outcome/parseOk claims. Protocol
 * completion and world fulfilment are separate axes.
 */
function deriveEpisodeStatus(record: G09EpisodeRecord, entry: G09PlanEntry): { derived: G09DerivedEpisode; issues: string[] } {
  const issues: string[] = [];
  const id = record.episodeId;
  const goalExchange = record.http?.find(exchange => exchange.phase === 'goal');
  const actionExchange = record.http?.find(exchange => exchange.phase === 'action');
  const goalClass = classifyHttpExchange(goalExchange);
  const actionClass = classifyHttpExchange(actionExchange);
  const goalParsed = goalExchange === undefined
    ? { ok: false as const, error: 'no goal call' }
    : strictGoalChoice(goalClass.content, G09_ALLOWED_GOALS[entry.arm]);
  const actionParsed = actionExchange === undefined
    ? { ok: false as const, error: 'no action call' }
    : parseAction(actionClass.content, 'timed_wait');
  const goalOk = goalClass.kind === 'ok' && goalParsed.ok;
  const actionOk = actionClass.kind === 'ok' && actionParsed.ok;
  // A late answer is an authoritative fact recorded by the runner (no submit,
  // the call stays spent); raw text alone cannot tell lateness apart.
  const late = /expired|not open|ended before/i.test(record.failure ?? '');
  let outcome: G09Outcome;
  if (goalExchange === undefined && actionExchange === undefined) outcome = 'not_run';
  else if (!goalOk) outcome = goalClass.kind === 'ok' ? 'invalid_run' : mapExchangeFailure(goalClass.kind);
  else if (!actionOk) outcome = actionClass.kind === 'ok' ? 'invalid_action' : mapExchangeFailure(actionClass.kind);
  else if (late) outcome = 'request_expired';
  else outcome = 'completed';

  if (record.outcome !== outcome) {
    issues.push(`${id}: the recorded outcome ${record.outcome} disagrees with the derived ${outcome}`);
  }
  if (outcome === 'completed' && (record.http?.length ?? 0) !== 2) {
    issues.push(`${id}: a completed episode must hold exactly 2 exchanges, found ${record.http?.length ?? 0}`);
  }
  // Goal parse claims must match the strict parse of the WIRE content. A /2
  // record used `binding !== null` as its claim; that documented legacy
  // semantics is checked as such instead of being reported as a failure.
  const legacyEpisode = (record as { schema?: unknown }).schema === G09_EPISODE_SCHEMA_V2;
  if (record.outcome !== 'not_run') {
    if (legacyEpisode) {
      if (record.goal.parseOk !== (record.binding !== null)) {
        issues.push(`${id}: the legacy goal.parseOk ${record.goal.parseOk} disagrees with its binding state`);
      }
    } else if (record.goal.parseOk !== goalParsed.ok) {
      issues.push(`${id}: the recorded goal.parseOk ${record.goal.parseOk} disagrees with the strict parse ${goalParsed.ok}`);
    }
  }
  if (record.goal.raw !== null && goalExchange !== undefined && goalClass.kind === 'ok' && record.goal.raw !== goalClass.content) {
    issues.push(`${id}: the recorded goal raw differs from the wire content`);
  }
  if (actionExchange !== undefined && record.outcome !== 'not_run') {
    const recordedType = record.action.type;
    const parsedType = actionParsed.ok ? actionParsed.action.type : null;
    if (record.action.parseOk !== actionParsed.ok) {
      issues.push(`${id}: the recorded action.parseOk ${record.action.parseOk} disagrees with the strict parse ${actionParsed.ok}`);
    }
    if (recordedType !== parsedType) {
      issues.push(`${id}: the recorded action type ${String(recordedType)} disagrees with the parsed ${String(parsedType)}`);
    }
    if (record.action.raw !== actionClass.content && actionClass.kind === 'ok') {
      issues.push(`${id}: the recorded action raw differs from the wire content`);
    }
  }
  // Token claims must equal the wire usage of the same attempt.
  const goalTokens = tokensOf(goalExchange);
  const actionTokens = tokensOf(actionExchange);
  if (goalExchange !== undefined && record.tokens.goal !== goalTokens) {
    issues.push(`${id}: the recorded goal tokens ${String(record.tokens.goal)} disagree with the wire ${String(goalTokens)}`);
  }
  if (actionExchange !== undefined && record.tokens.action !== actionTokens) {
    issues.push(`${id}: the recorded action tokens ${String(record.tokens.action)} disagree with the wire ${String(actionTokens)}`);
  }
  // Binding coherence: yield_once completes with a binding; feed_self never does.
  if (goalParsed.ok) {
    if (goalParsed.goal === 'yield_once' && outcome === 'completed' && record.binding === null) {
      issues.push(`${id}: a completed yield_once protocol must carry a binding`);
    }
    if (goalParsed.goal === 'feed_self' && record.binding !== null) {
      issues.push(`${id}: a feed_self decision must not carry a yield binding`);
    }
  }
  return {
    issues,
    derived: {
      episodeId: id, cell: record.cell, arm: record.arm, satiety: record.satiety,
      outcome, recordedOutcome: record.outcome,
      goal: goalParsed.ok ? goalParsed.goal : null,
      goalParseOk: goalParsed.ok,
      request: record.request === null ? null : record.request.status,
      verdict: record.fulfilment === null ? null : record.fulfilment.verdict,
      protocolValid: outcome === 'completed',
      goalKind: goalClass.kind, actionKind: actionClass.kind,
      goalTokens, actionTokens,
    },
  };
}

function sumOrNull(values: (number | null)[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

export function deriveG09(
  batch: G09Batch,
  frozen: readonly G09PlanEntry[],
  campaign: { limit: number; spent: number },
  scope: 'complete' | 'prefix' = 'complete',
): G09Derivation {
  const issues: string[] = [...batch.problems];
  const protocol = { planned: frozen.length, completed: 0, failed: 0, notRun: 0, goalPhases: 0, actionPhases: 0 };
  const goals = { feed_self: 0, yield_once: 0, byCell: {} as Record<string, Record<string, number>> };
  const fulfilment: G09Summary['fulfilment'] = {
    byCell: {},
    world: { fulfilled: 0, violated: 0, not_applicable: 0, undetermined: 0 },
  };
  const byCell: G09Summary['costs']['byCell'] = {};
  for (const cell of G09_CELLS) {
    goals.byCell[cell.cell] = { feed_self: 0, yield_once: 0 };
    fulfilment.byCell[cell.cell] = { fulfilled: 0, violated: 0, not_applicable: 0, undetermined: 0 };
    byCell[cell.cell] = { goalTokens: 0, actionTokens: 0, requests: 0, knownGoalTokens: 0, knownActionTokens: 0, unknownPhases: 0 };
  }
  const episodes: G09Summary['episodes'] = [];
  const seen = new Set<string>();
  // Phase-level cost accumulators: only ACTUALLY ATTEMPTED phases count.
  let knownGoal = 0;
  let knownAction = 0;
  let unknownGoalPhases = 0;
  let unknownActionPhases = 0;
  let notRunPhases = 0;

  for (const record of batch.episodes) {
    const id = record.episodeId;
    if (seen.has(id)) issues.push(`${id}: duplicated episode record`);
    seen.add(id);
    const entry = frozen.find(candidate => candidate.episodeId === id);
    if (entry === undefined) { issues.push(`${id}: not part of the frozen plan`); continue; }
    if (record.cell !== entry.cell || record.satiety !== entry.satiety || record.arm !== entry.arm) {
      issues.push(`${id}: the record axes ${record.cell}/${record.satiety}/${record.arm} disagree with the frozen plan`);
    }

    const status = deriveEpisodeStatus(record, entry);
    issues.push(...status.issues);
    const derived = status.derived;
    episodes.push(derived);

    // Protocol counting comes from the DERIVED outcome, never the recorded one.
    if (derived.outcome === 'not_run') {
      protocol.notRun += 1;
      notRunPhases += 2;
      // A not_run slot claims nothing: no world, no request, no fulfilment.
      continue;
    }
    protocol.failed += derived.outcome === 'completed' ? 0 : 1;
    if (derived.outcome === 'completed') protocol.completed += 1;
    const goalExchange = record.http?.find(exchange => exchange.phase === 'goal');
    const actionExchange = record.http?.find(exchange => exchange.phase === 'action');
    if (goalExchange !== undefined) protocol.goalPhases += 1;
    if (actionExchange !== undefined) protocol.actionPhases += 1;

    // The frozen world must be exactly the cell's world (compared to the contract).
    if (canonical(record.snapshot?.initialState) !== canonical(g09InitialState(entry.satiety))) {
      issues.push(`${id}: the initial state is not the frozen ${entry.cell} world`);
    }
    if (canonical(record.runtime) !== canonical(g09RuntimeConfig())) {
      issues.push(`${id}: the runtime is not the frozen recurring/event/timed_wait [A,C] configuration`);
    }
    // The goal prompt must be the frozen template (the goal phase is unchanged).
    if (goalExchange !== undefined) {
      const normalised = goalExchange.prompt.replace(/^candidateGoals: .*$/m, 'candidateGoals: <DATA>');
      const expected = renderFrozenGoalPrompt(record.arm, record.satiety);
      if (normalised !== expected) issues.push(`${id}: the goal prompt is not the frozen template`);
      if (goalExchange.prompt.includes(record.episodeId ?? id)) issues.push(`${id}: the episode id leaked into the prompt`);
      if (goalExchange.prompt.includes(entry.requestId)) issues.push(`${id}: the host request id leaked into the prompt`);
    }
    // Request shape and binding.
    if (record.request !== null) {
      const validated = validateGoalRequestSnapshot(record.request);
      if (!validated.ok) issues.push(`${id}: request invalid: ${validated.issues.join('; ')}`);
      if (record.request.text !== G09_REQUEST_TEXT) issues.push(`${id}: the request text is not the frozen S1`);
      if (canonical(record.request.options) !== canonical(G09_ALLOWED_GOALS[entry.arm])) issues.push(`${id}: the request candidates are not the ${entry.arm} set`);
      if (record.request.expiresAtSimTime !== record.request.createdAtSimTime + 1) issues.push(`${id}: the request expiry is not createdAt+1`);
    }
    // Goal selection is counted from the STRICT PARSE, not from the binding:
    // a legally chosen feed_self has no binding and is still a valid choice.
    if (derived.goalParseOk && (derived.goal === 'feed_self' || derived.goal === 'yield_once')) {
      const chosen: 'feed_self' | 'yield_once' = derived.goal;
      goals[chosen] += 1;
      goals.byCell[entry.cell]![chosen] = (goals.byCell[entry.cell]![chosen] ?? 0) + 1;
    }
    if (record.binding !== null && record.request !== null) {
      issues.push(...bindingIssues(record.binding, record.request));
      const parsed = strictGoalChoice(record.binding.raw, record.request.options);
      if (!parsed.ok) issues.push(`${id}: binding raw does not parse: ${parsed.error}`);
      if (goalExchange !== undefined && goalExchange.response.body !== undefined && goalExchange.response.body !== null) {
        const content = classifyHttpExchange(goalExchange).content;
        if (content !== record.binding.raw) issues.push(`${id}: the goal response content differs from the binding raw`);
      }
    } else if (derived.goalParseOk && derived.goal === 'feed_self') {
      // A declined feed_self is a legal control decision without a binding.
      if (record.request === null || record.request.status !== 'declined') {
        issues.push(`${id}: a feed_self decision must be recorded as a declined request`);
      }
    }
    // Re-execute the ledger on a fresh Engine.
    if (record.snapshot !== undefined) {
      issues.push(...reexecuteCommands({ plan: { episodeId: id }, snapshot: record.snapshot as never }));
    } else {
      issues.push(`${id}: no snapshot to re-execute`);
    }
    // World facts: replay the request through the authoritative commands.
    // They are kept for EVERY bound episode, but only a protocol-valid
    // episode enters the byCell comparison table.
    if (record.binding !== null && record.request !== null && record.snapshot !== undefined) {
      const replayed = replayRequestOutcome(record.request, record.binding, {
        commands: record.snapshot.commands as never,
        finalSimTime: record.snapshot.finalState?.simTime,
      });
      const expectedVerdict = record.binding.goal !== 'yield_once'
        ? 'not_applicable'
        : fulfilmentVerdict({ goal: 'yield_once', npcAteBeforePlayer: replayed.outcome === 'violated', playerAte: replayed.outcome === 'fulfilled' });
      if (record.fulfilment === null) {
        issues.push(`${id}: a bound episode must record its fulfilment`);
      } else {
        if (record.fulfilment.outcome !== replayed.outcome) {
          issues.push(`${id}: the recorded request outcome ${record.fulfilment.outcome} disagrees with the replayed ${replayed.outcome}`);
        }
        if (record.fulfilment.verdict !== expectedVerdict) {
          issues.push(`${id}: the recorded verdict ${record.fulfilment.verdict} disagrees with ${expectedVerdict}`);
        }
      }
      fulfilment.world[expectedVerdict] = (fulfilment.world[expectedVerdict] ?? 0) + 1;
      if (derived.protocolValid && record.binding.goal === 'yield_once') {
        const bucket = fulfilment.byCell[entry.cell]!;
        bucket[expectedVerdict] = (bucket[expectedVerdict] ?? 0) + 1;
      }
    }
    // Cost: only the phases that were actually sent are counted.
    const cellCost = byCell[entry.cell]!;
    if (derived.goalTokens === null && goalExchange !== undefined) {
      unknownGoalPhases += 1;
      cellCost.unknownPhases += 1;
    } else if (derived.goalTokens !== null) {
      knownGoal += derived.goalTokens;
      cellCost.knownGoalTokens += derived.goalTokens;
    }
    if (derived.actionTokens === null && actionExchange !== undefined) {
      unknownActionPhases += 1;
      cellCost.unknownPhases += 1;
    } else if (derived.actionTokens !== null) {
      knownAction += derived.actionTokens;
      cellCost.knownActionTokens += derived.actionTokens;
    }
    cellCost.requests += record.http?.length ?? 0;
    if (derived.goalTokens !== null) cellCost.goalTokens = (cellCost.goalTokens as number) + derived.goalTokens;
    if (derived.actionTokens !== null) cellCost.actionTokens = (cellCost.actionTokens as number) + derived.actionTokens;
  }

  if (scope === 'complete') {
    for (const entry of frozen) {
      if (!seen.has(entry.episodeId) && !batch.episodes.some(record => record.episodeId === entry.episodeId)) {
        issues.push(`${entry.episodeId}: the plan slot has no record at all`);
      }
    }
  }

  // The on-disk plan must equal the frozen contract (never its own standard).
  if (batch.plan !== null) {
    const disk = batch.plan.plan.map(entry => [entry.rep, entry.satiety, entry.arm]);
    const frozenMatrix = frozen.map(entry => [entry.rep, entry.satiety, entry.arm]);
    if (canonical(disk) !== canonical(frozenMatrix)) issues.push('plan.json does not match the frozen matrix');
    if (batch.plan.hardChatLimit !== G09_HARD_CHAT_LIMIT) issues.push(`plan.json hardChatLimit ${String(batch.plan.hardChatLimit)} is not the frozen ${G09_HARD_CHAT_LIMIT}`);
    if (batch.plan.runtime === undefined || canonical(batch.plan.runtime) !== canonical(g09RuntimeConfig())) issues.push('plan.json runtime is not the frozen runtime');
  }

  const ledger = deriveG09Ledger(batch.dir, batch.episodes);
  issues.push(...ledger.issues);
  if (ledger.begins > G09_HARD_CHAT_LIMIT) issues.push(`the batch spent ${ledger.begins} chat requests, more than the frozen ${G09_HARD_CHAT_LIMIT}`);
  if (campaign.spent > campaign.limit) issues.push(`the campaign spent ${campaign.spent} chat requests, more than its limit ${campaign.limit}`);

  const usageUnknown = ledger.usageUnknown || unknownGoalPhases > 0 || unknownActionPhases > 0;
  const knownTotal = knownGoal + knownAction;
  for (const cell of G09_CELLS) {
    const cellCost = byCell[cell.cell]!;
    if (cellCost.unknownPhases > 0) {
      const hasUnknownGoal = batch.episodes
        .filter(record => record.cell === cell.cell)
        .some(record => {
          const exchange = record.http?.find(e => e.phase === 'goal');
          return exchange !== undefined && tokensOf(exchange) === null;
        });
      const hasUnknownAction = batch.episodes
        .filter(record => record.cell === cell.cell)
        .some(record => {
          const exchange = record.http?.find(e => e.phase === 'action');
          return exchange !== undefined && tokensOf(exchange) === null;
        });
      if (hasUnknownGoal) cellCost.goalTokens = null;
      if (hasUnknownAction) cellCost.actionTokens = null;
    }
  }
  const costs: G09Summary['costs'] = {
    chatRequests: ledger.begins,
    spent: ledger.begins,
    blocked: ledger.blocked,
    unresolved: ledger.unresolved,
    usageUnknown,
    goalTokens: unknownGoalPhases > 0 ? null : knownGoal,
    actionTokens: unknownActionPhases > 0 ? null : knownAction,
    totalTokens: usageUnknown ? null : knownTotal,
    knownGoalTokens: knownGoal,
    knownActionTokens: knownAction,
    knownTotalTokens: knownTotal,
    unknownPhases: unknownGoalPhases + unknownActionPhases,
    notRunPhases,
    campaignLimit: campaign.limit,
    campaignSpent: campaign.spent,
    byCell,
  };
  return { issues, protocol, goals, fulfilment, costs, episodes };
}

/** The frozen goal prompt for an arm (candidate line normalised to <DATA>). */
export function renderFrozenGoalPrompt(arm: GoalArm, satiety: number = 40): string {
  const lines = [
    '你是 npc_a，位于kitchen。当前逻辑时间 0。',
    `你的饱食度：${satiety}。你所在位置的剩余食物：1。`,
    `玩家说：“${G09_REQUEST_TEXT}”`,
    '请从候选目标中选择一个，只回复一个 JSON 对象，不要输出任何其他内容。',
    'candidateGoals: <DATA>',
  ];
  void arm;
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Verification                                                       */
/* ------------------------------------------------------------------ */

export interface G09VerifyResult {
  ok: boolean;
  evidenceOk: boolean;
  complete: boolean;
  runSucceeded: boolean;
  issues: string[];
  derivation: G09Derivation;
}

export function verifyG09Batch(
  batchDir: string,
  campaign: { limit: number; spent: number } = { limit: G09_HARD_CHAT_LIMIT, spent: 0 },
): G09VerifyResult {
  return verify(batchDir, campaign, 'complete');
}

export function verifyG09Prefix(
  batchDir: string,
  campaign: { limit: number; spent: number } = { limit: G09_HARD_CHAT_LIMIT, spent: 0 },
): G09VerifyResult {
  return verify(batchDir, campaign, 'prefix');
}

function verify(batchDir: string, campaign: { limit: number; spent: number }, scope: 'complete' | 'prefix'): G09VerifyResult {
  const batch = readG09Batch(batchDir);
  const frozen = frozenPlanEntries();
  const derivation = deriveG09(batch, frozen, campaign, scope);
  const issues = [...derivation.issues];
  // Completeness is derived: a recorded `completed` with a failed phase is
  // NOT a completion, and a tampered claim is already an issue.
  const recorded = derivation.episodes.filter(episode => episode.outcome !== 'not_run').length;
  const complete = recorded === frozen.length && derivation.episodes.every(episode => episode.outcome === 'completed');
  if (scope === 'complete') {
    if (batch.summary === null) {
      issues.push('summary.json is missing: a complete batch must publish its own derivation');
    } else {
      issues.push(...compareG09Summary(batch.summary, derivation, batch.plan));
    }
    if (!complete) issues.push(`the batch is not complete: ${recorded}/${frozen.length} episodes ran`);
  } else {
    const pair = frozen.slice(0, 2).map(entry => entry.episodeId);
    const pairDerived = derivation.episodes.filter(episode => pair.includes(episode.episodeId));
    if (pairDerived.length !== 2) issues.push(`the structural gate needs both first-pair episodes (${pair.join(', ')})`);
    for (const episode of pairDerived) {
      // G10: the gate uses the DERIVED protocol outcome, never the record's claim.
      if (episode.outcome !== 'completed') issues.push(`${episode.episodeId}: the structural gate requires a legally completed episode (derived ${episode.outcome})`);
      if (episode.goalKind !== 'ok' || episode.actionKind !== 'ok') issues.push(`${episode.episodeId}: the structural gate requires usable goal and action exchanges`);
      if (episode.goalParseOk !== true) issues.push(`${episode.episodeId}: the structural gate requires a legally parsed goal answer`);
    }
  }
  const structural = issues.filter(issue => !issue.startsWith('summary.'));
  const evidenceOk = structural.length === 0;
  const ok = scope === 'complete' ? issues.length === 0 && complete : evidenceOk;
  return { ok, evidenceOk, complete, runSucceeded: ok, issues, derivation };
}

/** The summary must equal the projection; a self-declared summary never wins. */
/**
 * G10: summaries written before the action-contract round (schema /2) are
 * compared through a projection of the SAME derivation, so a legacy batch can
 * still verify ok while a rewritten/back-filled summary stays rejected.
 */
function legacyProjection(derivation: G09Derivation): Record<string, unknown> {
  return {
    protocol: derivation.protocol,
    goals: derivation.goals,
    fulfilment: { byCell: derivation.fulfilment.byCell },
    costs: {
      chatRequests: derivation.costs.chatRequests,
      spent: derivation.costs.spent,
      blocked: derivation.costs.blocked,
      unresolved: derivation.costs.unresolved,
      usageUnknown: derivation.costs.usageUnknown,
      goalTokens: derivation.costs.goalTokens,
      actionTokens: derivation.costs.actionTokens,
      totalTokens: derivation.costs.totalTokens,
      campaignLimit: derivation.costs.campaignLimit,
      campaignSpent: derivation.costs.campaignSpent,
      byCell: Object.fromEntries(Object.entries(derivation.costs.byCell).map(([cell, value]) => [
        cell, { goalTokens: value.goalTokens, actionTokens: value.actionTokens, requests: value.requests },
      ])),
    },
    episodes: derivation.episodes.map(episode => ({
      episodeId: episode.episodeId, cell: episode.cell, arm: episode.arm, satiety: episode.satiety,
      // /2 carried `goal` from the BINDING (null for a legal feed_self).
      outcome: episode.outcome, goal: episode.goal === 'feed_self' ? null : episode.goal,
      request: episode.request, verdict: episode.verdict,
      goalTokens: episode.goalTokens, actionTokens: episode.actionTokens,
    })),
  };
}

export function compareG09Summary(summary: G09Summary, derivation: G09Derivation, plan: G09Plan | null): string[] {
  const issues: string[] = [];
  const check = (label: string, actual: unknown, derived: unknown): void => {
    if (canonical(actual) !== canonical(derived)) {
      issues.push(`summary.${label}: recorded ${JSON.stringify(actual)} but the contract derives ${JSON.stringify(derived)}`);
    }
  };
  const schema = (summary as { schema?: unknown }).schema;
  if (schema !== G09_SUMMARY_SCHEMA && schema !== 'frostecho.g09.summary/2') {
    issues.push(`summary.schema: ${JSON.stringify(schema)} is not a known summary schema`);
    return issues;
  }
  check('hardChatLimit', summary.hardChatLimit, G09_HARD_CHAT_LIMIT);
  if (schema === G09_SUMMARY_SCHEMA) {
    check('protocol', summary.protocol, derivation.protocol);
    check('goals', summary.goals, derivation.goals);
    check('fulfilment', summary.fulfilment, derivation.fulfilment);
    check('costs', summary.costs, derivation.costs);
    check('episodes', summary.episodes, derivation.episodes);
  } else {
    // A /2 summary is compared on exactly the fields it was allowed to carry.
    const legacy = legacyProjection(derivation);
    for (const key of ['protocol', 'goals', 'fulfilment', 'costs', 'episodes'] as const) {
      check(key, (summary as unknown as Record<string, unknown>)[key], legacy[key]);
    }
  }
  if (plan !== null && summary.batch !== plan.batch) issues.push('summary.batch disagrees with the plan batch');
  return issues;
}

export function projectG09Summary(
  batch: string, mode: 'live' | 'fake', model: string | null, derivation: G09Derivation,
): G09Summary {
  return {
    schema: G09_SUMMARY_SCHEMA,
    batch,
    createdAt: new Date().toISOString(),
    mode,
    model,
    hardChatLimit: G09_HARD_CHAT_LIMIT,
    protocol: derivation.protocol,
    goals: derivation.goals,
    fulfilment: derivation.fulfilment,
    costs: derivation.costs,
    episodes: derivation.episodes,
  };
}

export { G09_SATIETY_LEVELS, G09_TIMEOUT_MS, G09_ALLOWED_GOALS };
export type { GoalChoiceId };
