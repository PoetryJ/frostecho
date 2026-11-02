/**
 * G07 worker D — the fixed 8-episode player-message experiment.
 *
 * Plan (frozen before any request, see g07-eval-lib.ts):
 *   S1: 请把最后一份食物留给我，你先不要吃。
 *   S2: 请你先吃这一份食物，不用留给我。
 *   rep1: S1-off → S1-on → S2-off → S2-on
 *   rep2: S1-on → S1-off → S2-on → S2-off
 *
 * Every episode sends the same text to npc_a (no model call, no world change),
 * then calls game.advance() exactly ONCE (npc_a's natural decision), then lets
 * npc_b try `player eat`. There is no runUntilIdle, no retry and no extra
 * pumping. The batch shares one ChatBudgetGate: at most 8 chat requests total,
 * and a transport failure (or a budget denial) stops the batch immediately.
 * Remaining slots stay not_run with a status file and no attempt record.
 *
 * Evidence is independent of the implementation's own claims: the fetch layer
 * records the exact request body and the raw response text, the episode keeps
 * the raw model text, a strict re-parse, the submitted command, the Engine
 * result, the authoritative final state, the mailbox snapshot and a replay.
 * `summary.json` is rebuilt by re-reading those files from disk.
 *
 * This is a one-decision mechanism probe. A legal action choice (stop/move/eat)
 * is never a gate failure; only wiring, accounting and evidence are gated.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Provider } from '../src/agent/contracts';
import { createHttpProvider, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createMailbox } from '../src/communication/mailbox';
import { createMessageProvider } from '../src/communication/provider';
import { BATCH_NAME_RE, createBatchStore, collectVersion, type BatchStore } from '../src/eval/store';
import { ChatBudgetGate, createBudgetedProvider } from '../src/needs/live-budget';
import type { LiveAttemptBegin, LiveAttemptFinish } from '../src/needs/live-contracts';
import { createNeedsGame } from '../src/needs/game';
import type { ReactiveAdvanceOutcome } from '../src/reactive/contracts';
import type { ReactiveRecord } from '../src/reactive/contracts';
import { type WorldState } from '../src/types';
import { canonical } from '../src/util';
import {
  G07_ACTOR_ORDER, G07_EPISODE_SCHEMA, G07_HARD_CHAT_LIMIT, G07_INITIAL_STATE,
  G07_PLAN, G07_PLAN_SCHEMA, G07_SCENARIOS, G07_STATUS_SCHEMA, G07_SUMMARY_SCHEMA,
  G07_TARGET, G07_TIMEOUT_MS, buildPairs, commandViews, decisionOf,
  playerMessagesLine, readBatch, requestConfigFor, sha256, strictAction,
  stripPromptData, structuralGateOf, templateFingerprint, verifyBatch,
  type G07AdvanceView, type G07Attempt, type G07Behavior, type G07Decision,
  type G07EpisodeOutcome, type G07EpisodeRecord, type G07EpisodeStatusFile,
  type G07HttpExchange, type G07PlanEntry, type G07Summary,
  type ParseOutcome,
} from './g07-eval-lib';

export { G07_HARD_CHAT_LIMIT, G07_PLAN, G07_SCENARIOS, G07_TIMEOUT_MS, verifyBatch };

export interface G07PreflightCheck {
  path: string;
  url: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  raw: string;
}

export interface G07Preflight {
  schema: 'frostecho.g07.eval.preflight/1';
  ok: boolean;
  endpointHost: string;
  expectedModel: string;
  /** Separate from the chat budget: these are read-only GETs, never counted. */
  preflightRequests: number;
  checks: G07PreflightCheck[];
  checkedAt: string;
}

export interface G07RunOptions {
  out: string;
  batchId: string;
  url: string;
  model: string;
  apiKey?: string;
  fetchImpl: typeof fetch;
  mode: 'live' | 'fake';
  limit?: number;
  timeoutMs?: number;
  preflight?: G07Preflight | null;
  log?: (line: string) => void;
}

export interface G07RunResult {
  batchDir: string;
  exitCode: number;
  summary: G07Summary;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positionsOf(record: { finalState: WorldState }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, npc] of Object.entries(record.finalState.npcs)) out[id] = npc.location;
  return out;
}

function advanceView(outcome: ReactiveAdvanceOutcome): G07AdvanceView {
  if (outcome.kind === 'stepped') {
    return {
      kind: outcome.kind,
      actorId: outcome.actorId,
      cycle: outcome.cycle,
      status: outcome.result.status,
      terminal: outcome.result.terminal,
      providerCalled: outcome.result.providerCalled,
    };
  }
  if (outcome.kind === 'interrupted') {
    return { kind: outcome.kind, actorId: outcome.actorId, cycle: null, status: null, terminal: null, providerCalled: null };
  }
  return { kind: outcome.kind, actorId: null, cycle: null, status: null, terminal: null, providerCalled: null };
}

function behaviorOf(
  record: ReactiveRecord,
  action: ParseOutcome,
  playerEat: { ok: boolean; detail: string },
): G07Behavior {
  const initial = record.initialState;
  const final = record.finalState;
  const views = commandViews(record);
  const npcEat = record.commands.find(entry => entry.command.actorId === G07_TARGET && entry.command.type === 'eat') ?? null;
  const playerEatEntry = record.commands.find(entry => entry.command.actorId === 'npc_b' && entry.command.type === 'eat') ?? null;
  const playerOk = playerEatEntry?.result.status === 'accepted';
  return {
    npcAction: action,
    npcAte: npcEat?.result.status === 'accepted',
    npcEat: npcEat === null ? null : { status: npcEat.result.status, reason: npcEat.result.reason ?? null },
    npcLocationAfter: final.npcs[G07_TARGET].location,
    foodAfterNpc: final.food.kitchen + (playerOk ? 1 : 0),
    npcHunger: { before: initial.npcs[G07_TARGET].hunger, after: final.npcs[G07_TARGET].hunger },
    playerEat,
    playerEatCommand: playerEatEntry === null ? null : {
      status: playerEatEntry.result.status,
      reason: playerEatEntry.result.reason ?? null,
    },
    playerHunger: { before: initial.npcs.npc_b.hunger, after: final.npcs.npc_b.hunger },
    playerFoodAfter: final.food.kitchen,
    commands: views,
  };
}

interface EpisodeRun {
  outcome: G07EpisodeOutcome;
  failure: string | null;
}

function writeStatus(store: BatchStore, entry: G07PlanEntry, run: EpisodeRun): void {
  const status: G07EpisodeStatusFile = {
    schema: G07_STATUS_SCHEMA,
    episodeId: entry.episodeId,
    status: run.outcome === 'completed' ? 'completed' : 'failed',
    outcome: run.outcome,
    detail: run.failure,
    at: new Date().toISOString(),
  };
  store.writeJson(`status/${entry.episodeId}.json`, status);
}

async function runEpisode(
  entry: G07PlanEntry,
  store: BatchStore,
  gate: ChatBudgetGate,
  options: G07RunOptions & { requestConfig: ReturnType<typeof requestConfigFor> },
): Promise<EpisodeRun> {
  const mailbox = createMailbox();
  const http: G07HttpExchange[] = [];
  const attempts: G07Attempt[] = [];
  let blockedSeq = 0;

  const proxied: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const body = parseJsonObject(init?.body);
    const res = await options.fetchImpl(input, init);
    let raw = '';
    try {
      raw = await res.clone().text();
    } catch {
      raw = '';
    }
    http.push({ at: new Date().toISOString(), request: { method, body }, response: { status: res.status, raw } });
    return res;
  };

  const providerFor = (actorId: string): Provider => {
    const messageProvider = createMessageProvider(
      createHttpProvider({
        url: options.url,
        model: options.model,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        fetchImpl: proxied,
        enableThinking: true,
      }),
      mailbox,
      { enabled: entry.arm === 'on', actorId },
    );
    return createBudgetedProvider({
      gate,
      inner: messageProvider,
      requestConfig: options.requestConfig,
      episodeId: entry.episodeId,
      actorId,
      cycle: 1,
      hooks: {
        beginAttempt: (begin: LiveAttemptBegin) => {
          // Durable before the request: a write failure stops the attempt.
          store.writeJson(`attempts/${begin.attemptId}.begin.json`, begin);
          attempts.push({ attemptId: begin.attemptId, begin, finish: null });
        },
        finishAttempt: (finish: LiveAttemptFinish) => {
          store.writeJson(`attempts/${finish.attemptId}.finish.json`, finish);
          const slot = attempts.find(candidate => candidate.attemptId === finish.attemptId);
          if (slot !== undefined) slot.finish = finish;
        },
        recordBlocked: blocked => {
          blockedSeq += 1;
          store.writeJson(`attempts/blocked-${String(blockedSeq).padStart(4, '0')}.json`, { ...blocked, seq: blockedSeq });
        },
      },
    });
  };

  const game = createNeedsGame({
    episodeId: entry.episodeId,
    initialState: structuredClone(G07_INITIAL_STATE),
    actorIds: [...G07_ACTOR_ORDER],
    providerFor,
    // A fake-HTTP batch is recorded as fixture, so it can never look like a
    // real-model run in the snapshot.
    mode: options.mode === 'live' ? 'live' : 'fixture',
    thinking: true,
    needPolicy: 'recurring',
    timeoutMs: options.timeoutMs,
    requestModel: options.model,
  });

  // --- send: mailbox only, no model, no world, no budget ----------------
  const before = game.snapshot();
  const spentBeforeSend = gate.spent;
  const httpBeforeSend = http.length;
  const attemptsBeforeSend = attempts.length;
  const command = { commandId: `${entry.episodeId}:say:1`, to: G07_TARGET, text: G07_SCENARIOS[entry.scenario] };
  const sent = mailbox.send(command, positionsOf(before));
  const afterSend = game.snapshot();
  const send = {
    command,
    receipt: sent.ok ? { ...sent.value } : null,
    rejected: sent.ok ? null : `${sent.code}${sent.issues !== undefined && sent.issues.length > 0 ? `: ${sent.issues.join('; ')}` : ''}`,
    invariants: {
      worldUnchanged: canonical(before.finalState) === canonical(afterSend.finalState),
      commandsUnchanged: before.commands.length === afterSend.commands.length,
      eventsUnchanged: canonical(before.events) === canonical(afterSend.events),
      callsUnchanged: canonical(before.actors) === canonical(afterSend.actors),
      budgetUnchanged: gate.spent === spentBeforeSend,
      noHttpRequest: http.length === httpBeforeSend,
      noAttempt: attempts.length === attemptsBeforeSend,
    },
  };

  const record = (outcome: G07EpisodeOutcome, failure: string | null, extra: {
    decision: G07Decision | null;
    behavior: G07Behavior | null;
    snapshot: ReturnType<typeof game.snapshot>;
    prompt: G07EpisodeRecord['prompt'];
  }): G07EpisodeRecord => ({
    schema: G07_EPISODE_SCHEMA,
    plan: entry,
    scenarioText: G07_SCENARIOS[entry.scenario],
    requestConfig: options.requestConfig,
    templateFingerprint: templateFingerprint(),
    initialState: structuredClone(G07_INITIAL_STATE),
    send,
    attempts: attempts.map(attempt => structuredClone(attempt)),
    http: structuredClone(http),
    prompt: extra.prompt,
    decision: extra.decision,
    behavior: extra.behavior,
    snapshot: extra.snapshot,
    mailbox: mailbox.export(),
    replayMatches: extra.snapshot.replayMatches,
    outcome,
    failure,
    finishedAt: new Date().toISOString(),
  });

  if (!sent.ok) {
    const run: EpisodeRun = { outcome: 'protocol_failure', failure: `send rejected: ${String(send.rejected)}` };
    const snapshot = game.snapshot();
    store.writeJson(`episodes/${entry.episodeId}.json`, record(run.outcome, run.failure, {
      decision: null,
      behavior: null,
      snapshot,
      prompt: { sha256: null, templateSha256: null, playerMessagesLine: null, playerMessages: null },
    }));
    writeStatus(store, entry, run);
    return run;
  }

  // --- exactly one advance: npc_a's natural decision -------------------
  const blockedBefore = gate.blocked;
  let advance: G07AdvanceView;
  let thrown: string | null = null;
  try {
    advance = advanceView(await game.advance());
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
    advance = { kind: 'threw', actorId: null, cycle: null, status: null, terminal: null, providerCalled: null };
  }
  const afterNpc = game.snapshot();
  const finish = attempts[0]?.finish ?? null;
  const providerCalls = afterNpc.actors[G07_TARGET]?.providerCalls ?? 0;

  let outcome: G07EpisodeOutcome;
  let failure: string | null;
  if (thrown !== null) {
    outcome = 'protocol_failure';
    failure = `advance threw: ${thrown}`;
  } else if (gate.blocked > blockedBefore) {
    outcome = 'budget_blocked';
    failure = 'chat budget exhausted before this decision';
  } else if (attempts.length !== 1) {
    outcome = 'protocol_failure';
    failure = `expected exactly 1 provider attempt, observed ${attempts.length}`;
  } else if (finish === null) {
    outcome = 'protocol_failure';
    failure = 'the provider attempt has no finish record';
  } else if (finish.outcome !== 'success') {
    outcome = 'transport_failure';
    failure = `${finish.outcome}: ${finish.error ?? 'no detail'}`;
  } else if (advance.kind !== 'stepped' || advance.providerCalled !== true || providerCalls !== 1) {
    outcome = 'protocol_failure';
    failure = `unexpected decision shape: ${advance.kind}, providerCalls=${providerCalls}`;
  } else {
    outcome = 'completed';
    failure = null;
  }

  const decision = decisionOf(afterNpc, advance);
  if (outcome !== 'completed') {
    const snapshot = game.snapshot();
    store.writeJson(`episodes/${entry.episodeId}.json`, record(outcome, failure, {
      decision,
      behavior: null,
      snapshot,
      prompt: promptEvidence(http),
    }));
    writeStatus(store, entry, { outcome, failure });
    return { outcome, failure };
  }

  // --- the player's single eat attempt (only after a real decision) -----
  const playerEat = game.playerLine('player eat');
  const final = game.snapshot();
  const action = strictAction(decision.turns.find(turn => turn.providerCalled)?.raw ?? null);
  const behavior = behaviorOf(final, action, playerEat);
  const run: EpisodeRun = { outcome: 'completed', failure: null };
  store.writeJson(`episodes/${entry.episodeId}.json`, record(run.outcome, run.failure, {
    decision,
    behavior,
    snapshot: final,
    prompt: promptEvidence(http),
  }));
  writeStatus(store, entry, run);
  return run;
}

function promptEvidence(http: G07HttpExchange[]): G07EpisodeRecord['prompt'] {
  const content = String(((http[0]?.request.body.messages as { content?: string }[] | undefined)?.[0]?.content) ?? '');
  if (content === '') {
    return { sha256: null, templateSha256: null, playerMessagesLine: null, playerMessages: null };
  }
  const line = playerMessagesLine(content);
  let playerMessages: unknown = null;
  if (line !== null) {
    try {
      playerMessages = JSON.parse(line.slice('playerMessages:'.length));
    } catch {
      playerMessages = 'invalid';
    }
  }
  return {
    sha256: sha256(content),
    templateSha256: sha256(stripPromptData(content)),
    playerMessagesLine: line,
    playerMessages,
  };
}

function writeNotRun(store: BatchStore, entry: G07PlanEntry, detail: string): void {
  store.writeJson(`status/${entry.episodeId}.json`, {
    schema: G07_STATUS_SCHEMA,
    episodeId: entry.episodeId,
    status: 'not_run',
    outcome: null,
    detail,
    at: new Date().toISOString(),
  } satisfies G07EpisodeStatusFile);
}

function buildSummary(batchDir: string, batchId: string, mode: 'live' | 'fake', model: string, version: unknown, limit: number, gate: ChatBudgetGate, fatal: string | null): G07Summary {
  const batch = readBatch(batchDir);
  const episodes: G07Summary['episodes'] = [];
  const totals = { planned: 0, completed: 0, failed: 0, notRun: 0 };
  const arms: G07Summary['arms'] = {
    off: { completed: 0, failed: 0, notRun: 0 },
    on: { completed: 0, failed: 0, notRun: 0 },
  };
  const scenarios: G07Summary['scenarios'] = {
    s1: { completed: 0, failed: 0, notRun: 0 },
    s2: { completed: 0, failed: 0, notRun: 0 },
  };
  for (const entry of G07_PLAN) {
    const record = batch.episodes.get(entry.episodeId) ?? null;
    const status = batch.statuses.get(entry.episodeId) ?? null;
    const state = record === null ? 'not_run' : record.outcome === 'completed' ? 'completed' : 'failed';
    const finish = record?.attempts[0]?.finish ?? null;
    totals.planned += 1;
    totals[state === 'not_run' ? 'notRun' : state === 'completed' ? 'completed' : 'failed'] += 1;
    arms[entry.arm][state === 'not_run' ? 'notRun' : state === 'completed' ? 'completed' : 'failed'] += 1;
    scenarios[entry.scenario][state === 'not_run' ? 'notRun' : state === 'completed' ? 'completed' : 'failed'] += 1;
    episodes.push({
      index: entry.index,
      episodeId: entry.episodeId,
      scenario: entry.scenario,
      arm: entry.arm,
      rep: entry.rep,
      status: state,
      outcome: record?.outcome ?? null,
      action: record?.behavior?.npcAction ?? null,
      npcAte: record?.behavior?.npcAte ?? null,
      foodAfterNpc: record?.behavior?.foodAfterNpc ?? null,
      playerEatOk: record?.behavior?.playerEat.ok ?? null,
      failure: record?.failure ?? status?.detail ?? null,
      tokens: finish?.usage?.total_tokens ?? null,
      latencyMs: finish?.elapsedMs ?? null,
    });
  }
  return {
    schema: G07_SUMMARY_SCHEMA,
    batch: batchId,
    mode,
    model,
    version,
    generatedAt: new Date().toISOString(),
    budget: { limit, spent: gate.spent, blocked: gate.blocked },
    disk: {
      episodes: batch.episodes.size,
      statuses: batch.statuses.size,
      begins: batch.attempts.begins.length,
      finishes: batch.attempts.finishes.length,
      blocked: batch.attempts.blocked.length,
    },
    totals,
    arms,
    scenarios,
    structuralGate: structuralGateOf(batch),
    fatal,
    episodes,
    pairs: buildPairs(batch.episodes, batch.statuses),
    note: 'One natural decision per episode on 8 fixed cases. A stop/move/eat is only an action type; it is not evidence that the NPC understood, refused or yielded. Not statistical significance.',
  };
}

/**
 * Runs the frozen matrix. The batch directory is created exclusively: a second
 * run with the same name throws before any request. Preflight (when given) is
 * written before any chat request and a failed preflight spends 0 chat.
 */
export async function runG07Batch(options: G07RunOptions): Promise<G07RunResult> {
  const limit = options.limit ?? G07_HARD_CHAT_LIMIT;
  const timeoutMs = options.timeoutMs ?? G07_TIMEOUT_MS;
  const log = options.log ?? (() => undefined);
  let endpointHost: string;
  try {
    endpointHost = new URL(options.url).host;
  } catch {
    throw new Error(`invalid chat completions URL: ${JSON.stringify(options.url)}`);
  }
  const store = createBatchStore(options.out, options.batchId);
  const version = collectVersion(process.cwd());
  const requestConfig = requestConfigFor(options.model, timeoutMs);

  store.writeJson('plan.json', {
    schema: G07_PLAN_SCHEMA,
    batch: options.batchId,
    createdAt: new Date().toISOString(),
    version,
    mode: options.mode,
    model: options.model,
    endpointHost,
    hardChatLimit: limit,
    requestConfig,
    templateFingerprint: templateFingerprint(),
    scenarios: G07_SCENARIOS,
    initialState: 'A/B kitchen 40, C kitchen 70, kitchen food 1, dorm 0, simTime 0, actorOrder [A,C], recurring/event',
    plan: G07_PLAN,
    oneDecisionPerEpisode: true,
    noRetries: true,
  });
  if (options.preflight !== undefined && options.preflight !== null) {
    store.writeJson('preflight.json', options.preflight);
  }

  const gate = new ChatBudgetGate(limit);
  if (options.preflight !== undefined && options.preflight !== null && !options.preflight.ok) {
    for (const entry of G07_PLAN) writeNotRun(store, entry, 'preflight failed; no chat request was sent');
    const summary = buildSummary(store.dir, options.batchId, options.mode, options.model, version, limit, gate, 'preflight_failed');
    store.writeJson('summary.json', summary);
    return { batchDir: store.dir, exitCode: 2, summary };
  }

  let fatal: string | null = null;
  for (const entry of G07_PLAN) {
    if (fatal !== null) {
      writeNotRun(store, entry, `batch stopped earlier: ${fatal}`);
      continue;
    }
    const run = await runEpisode(entry, store, gate, { ...options, requestConfig });
    log(`${run.outcome.toUpperCase()} ${entry.episodeId}${run.failure === null ? '' : ` (${run.failure})`}`);
    if (run.outcome !== 'completed') {
      fatal = `${entry.episodeId}: ${run.outcome}${run.failure === null ? '' : ` (${run.failure})`}`;
      continue;
    }
    // The first S1 off/on pair is the structural gate: prove the wiring and
    // the identical template before spending the remaining six requests.
    if (entry.index === 2) {
      const gateResult = structuralGateOf(readBatch(store.dir));
      log(`structural gate ${gateResult.ok ? 'ok' : `failed: ${gateResult.issues.join('; ')}`}`);
      if (!gateResult.ok) fatal = `structural gate failed: ${gateResult.issues.join('; ')}`;
    }
  }

  const summary = buildSummary(store.dir, options.batchId, options.mode, options.model, version, limit, gate, fatal);
  store.writeJson('summary.json', summary);
  const exitCode = summary.totals.completed === G07_PLAN.length && summary.structuralGate.ok ? 0 : 1;
  log(`completed=${summary.totals.completed} failed=${summary.totals.failed} notRun=${summary.totals.notRun} spent=${gate.spent}/${limit}${fatal === null ? '' : ` fatal=${fatal}`}`);
  return { batchDir: store.dir, exitCode, summary };
}

/* ------------------------------------------------------------------ */
/* preflight: read-only GETs, never part of the chat budget            */
/* ------------------------------------------------------------------ */

export function preflightUrls(chatUrl: string): { health: string; models: string } | null {
  try {
    const url = new URL(chatUrl);
    const path = url.pathname.replace(/\/+$/, '');
    const suffix = '/v1/chat/completions';
    if (!path.endsWith(suffix)) return null;
    const base = path.slice(0, -suffix.length);
    return { health: `${url.origin}${base}/health`, models: `${url.origin}${base}/v1/models` };
  } catch {
    return null;
  }
}

export async function runPreflight(chatUrl: string, model: string, fetchImpl: typeof fetch): Promise<G07Preflight> {
  const urls = preflightUrls(chatUrl);
  const host = (() => {
    try {
      return new URL(chatUrl).host;
    } catch {
      return '';
    }
  })();
  const checks: G07PreflightCheck[] = [];
  if (urls === null) {
    checks.push({
      path: '/v1/chat/completions', url: chatUrl, status: null, ok: false,
      error: 'the chat URL does not end with /v1/chat/completions', raw: '',
    });
  } else {
    for (const [path, url] of [['/health', urls.health], ['/v1/models', urls.models]] as const) {
      try {
        const res = await fetchImpl(url, { method: 'GET' });
        const raw = await res.text();
        let models: string[] = [];
        try {
          const parsed = JSON.parse(raw) as { data?: { id?: unknown }[]; models?: unknown };
          if (Array.isArray(parsed.data)) models = parsed.data.map(item => String(item?.id ?? ''));
          else if (Array.isArray(parsed.models)) models = parsed.models.map(item => String(item));
        } catch {
          models = [];
        }
        const modelOk = path === '/health' ? true : models.includes(model);
        checks.push({
          path, url, status: res.status, ok: res.status === 200 && modelOk,
          error: res.status !== 200 ? `http ${res.status}` : modelOk ? null : `model ${model} is not listed`,
          raw: raw.length > 4000 ? raw.slice(0, 4000) : raw,
        });
      } catch (err) {
        checks.push({
          path, url, status: null, ok: false,
          error: err instanceof Error ? err.message : String(err), raw: '',
        });
      }
    }
  }
  return {
    schema: 'frostecho.g07.eval.preflight/1',
    ok: checks.length === 2 && checks.every(check => check.ok),
    endpointHost: host,
    expectedModel: model,
    preflightRequests: checks.length,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, '');
    }
  }
  return args;
}

function printVerify(result: ReturnType<typeof verifyBatch>, batchId: string): void {
  const stats = result.stats;
  if (!result.ok) {
    console.error(`verify ${batchId}: FAIL`);
    for (const issue of result.issues) console.error(`  - ${issue}`);
  } else {
    console.log(`verify ${batchId}: ok`);
  }
  console.log(`  mode=${String(stats.mode)} model=${String(stats.model)} planned=${stats.planned} completed=${stats.completed} failed=${stats.failed} notRun=${stats.notRun}`);
  console.log(`  records=${stats.records} http=${stats.http} attempts=${stats.attempts} blocked=${stats.blocked} spent=${stats.spent}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = args.get('--out') ?? 'artifacts/g07';
  if (args.has('--phase') && args.get('--phase') === 'list') {
    console.log(JSON.stringify({ hardChatLimit: G07_HARD_CHAT_LIMIT, scenarios: G07_SCENARIOS, plan: G07_PLAN }, null, 2));
    process.exit(0);
  }
  if (args.has('--verify')) {
    const batchId = args.get('--batch');
    if (batchId === undefined || batchId === '') {
      console.error('--verify needs --batch <name>');
      process.exit(2);
    }
    if (!BATCH_NAME_RE.test(batchId) || batchId.includes('..')) {
      console.error(`invalid batch name ${JSON.stringify(batchId)}`);
      process.exit(2);
    }
    const result = verifyBatch(resolve(out, batchId));
    printVerify(result, batchId);
    process.exit(result.ok ? 0 : 1);
  }

  const live = args.has('--live');
  const batchId = args.get('--batch');
  if (batchId === undefined || batchId === '') {
    console.error('need --batch <name>');
    process.exit(2);
  }
  if (!BATCH_NAME_RE.test(batchId) || batchId.includes('..')) {
    console.error(`invalid batch name ${JSON.stringify(batchId)}; use letters, digits, dot, dash or underscore`);
    process.exit(2);
  }
  const target = resolve(out, batchId);
  if (existsSync(target)) {
    console.error(`[batch rejected] ${target} already exists; evidence is never overwritten`);
    process.exit(2);
  }

  let url = args.get('--http') ?? '';
  let model = args.get('--model') ?? '';
  let apiKey: string | undefined;
  if (live) {
    if (url !== '' || model !== '') {
      console.error('--live reads FROSTECHO_LLM_URL / FROSTECHO_LLM_MODEL; do not combine it with --http/--model');
      process.exit(2);
    }
    const config = loadHttpConfigFromEnv();
    if (config === null) {
      console.error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL');
      process.exit(2);
    }
    url = config.url;
    model = config.model;
    apiKey = config.apiKey;
  }
  if (url === '' || model === '') {
    console.error('need --http <chat completions url> and --model <name>, or --live with the environment');
    process.exit(2);
  }
  const limit = args.has('--limit') ? Number(args.get('--limit')) : undefined;
  const timeoutMs = args.has('--timeout') ? Number(args.get('--timeout')) : undefined;
  if (live && (limit !== undefined || timeoutMs !== undefined)) {
    console.error('a live batch is frozen at 8 requests / 120000 ms; --limit and --timeout are fake-only');
    process.exit(2);
  }
  if (live && args.has('--no-preflight')) {
    console.error('a live batch requires the read-only preflight; --no-preflight is fake-only');
    process.exit(2);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > G07_HARD_CHAT_LIMIT)) {
    console.error(`--limit must be an integer in 1..${G07_HARD_CHAT_LIMIT}`);
    process.exit(2);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > G07_TIMEOUT_MS)) {
    console.error(`--timeout must be in 1..${G07_TIMEOUT_MS}`);
    process.exit(2);
  }

  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  const preflight = args.has('--no-preflight')
    ? null
    : await runPreflight(url, model, fetchImpl);
  if (preflight !== null) {
    for (const check of preflight.checks) {
      console.log(`preflight ${check.path} status=${String(check.status)} ok=${check.ok}${check.error === null ? '' : ` error=${check.error}`}`);
    }
    if (!preflight.ok) console.error('preflight failed: no chat request will be sent');
  }

  const result = await runG07Batch({
    out,
    batchId,
    url,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    fetchImpl,
    mode: live ? 'live' : 'fake',
    ...(limit !== undefined ? { limit } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    preflight,
    log: line => console.log(line),
  });
  console.log(`batch -> ${result.batchDir}`);
  process.exit(result.exitCode);
}

if (require.main === module) {
  void main().catch(err => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(2);
  });
}
