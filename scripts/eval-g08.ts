/**
 * G08 worker D — eval-g08: the frozen 8-episode timed-wait experiment.
 *
 * Protocol per episode (identical to G07 except the capability axis):
 *   1. mailbox.send(S1 → npc_a)          — no model, no world, no budget
 *   2. ONE game.advance()                — npc_a's natural decision
 *   3. game.playerLine('player eat')     — the player's single eat attempt
 * No advance_time, no runUntilIdle, no second NPC request, no retry. A
 * transport/budget/structure failure stops the batch; the rest stay not_run.
 *
 * Modes: fake (default, --http <url>) and live (--live, env credentials,
 * frozen at 8 requests / 120000 ms, read-only preflight first). The first
 * legacy off/on pair is the structural gate before the remaining six run.
 * `--verify <batchId>` re-checks a finished batch from disk only.
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
import type { ReactiveAdvanceOutcome, ReactiveRecord } from '../src/reactive/contracts';
import type { createReactiveGame } from '../src/reactive/game';
import { canonical } from '../src/util';
import { preflightUrls, runPreflight, type G07Preflight } from './eval-g07';
import {
  G07_ACTOR_ORDER, G07_INITIAL_STATE, G07_STATUS_SCHEMA, G07_TARGET, G07_TIMEOUT_MS,
  commandViews, decisionOf, playerMessagesLine, readBatch, requestConfigFor, sha256,
  strictAction, stripPromptData, templateFingerprint,
  type G07AdvanceView, type G07Attempt, type G07Decision, type G07EpisodeOutcome,
  type G07EpisodeStatusFile, type G07HttpExchange,
} from './g07-eval-lib';
import {
  G08_HARD_CHAT_LIMIT, G08_PLAN, G08_PLAN_SCHEMA, G08_SUMMARY_SCHEMA, G08_SCENARIO_TEXT,
  G08_EPISODE_SCHEMA,
  stripG08PromptData, verifyG08Batch, verifyG08Prefix,
  type G08Behavior, type G08EpisodeRecord, type G08ParseOutcome, type G08PlanEntry,
  type G08VerifyResult,
} from './g08-eval-lib';

export { G08_HARD_CHAT_LIMIT, G08_PLAN, verifyG08Batch };

export interface G08RunOptions {
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

export interface G08RunResult {
  batchDir: string;
  exitCode: number;
  verify: G08VerifyResult;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function positionsOf(record: ReactiveRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, npc] of Object.entries(record.finalState.npcs)) out[id] = npc.location;
  return out;
}

function advanceViewOf(outcome: ReactiveAdvanceOutcome): G07AdvanceView {
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

/** The verifier-side re-parse: wait is legal ONLY on the timed_wait axis. */
function strictG08Reparse(raw: string | null, actionSet: G08PlanEntry['actionSet']): G08ParseOutcome {
  const strict = strictAction(raw);
  if (strict !== null && typeof strict !== 'string') return strict;
  if (actionSet === 'timed_wait' && raw !== null) {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (Object.keys(value).length === 1 && value.type === 'wait') return { type: 'wait' };
    } catch {
      /* falls through */
    }
  }
  return strict;
}

function g08BehaviorOf(
  record: ReactiveRecord,
  entry: G08PlanEntry,
  action: G08ParseOutcome,
  playerEat: { ok: boolean; detail: string },
  game: ReturnType<typeof createReactiveGame>,
): G08Behavior {
  const initial = record.initialState;
  const final = record.finalState;
  const views = commandViews(record);
  const npcEat = record.commands.find(c => c.command.actorId === G07_TARGET && c.command.type === 'eat') ?? null;
  const playerEatEntry = record.commands.find(c => c.command.actorId === 'npc_b' && c.command.type === 'eat') ?? null;
  const playerOk = playerEatEntry?.result.status === 'accepted';
  const waitAccepted = game.actorStateOf(G07_TARGET) === 'timed_wait';
  const wakeAtSimTime = waitAccepted
    ? (game.status().wakeAtSimTime as Record<string, number | null> | undefined)?.[G07_TARGET] ?? null
    : null;
  return {
    actionSet: entry.actionSet,
    wait: { accepted: waitAccepted, wakeAtSimTime },
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

function writeStatus(store: BatchStore, episodeId: string, status: G07EpisodeStatusFile): void {
  store.writeJson(`status/${episodeId}.json`, status);
}

function statusOf(episodeId: string, run: EpisodeRun): G07EpisodeStatusFile {
  return {
    schema: G07_STATUS_SCHEMA,
    episodeId,
    status: run.outcome === 'completed' ? 'completed' : 'failed',
    outcome: run.outcome,
    detail: run.failure,
    at: new Date().toISOString(),
  };
}

function notRunStatus(episodeId: string, detail: string): G07EpisodeStatusFile {
  return {
    schema: G07_STATUS_SCHEMA,
    episodeId,
    status: 'not_run',
    outcome: null,
    detail,
    at: new Date().toISOString(),
  };
}

function promptEvidence(http: G07HttpExchange[]): G08EpisodeRecord['prompt'] {
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
      playerMessages = null;
    }
  }
  return {
    sha256: sha256(content),
    templateSha256: sha256(stripG08PromptData(content)),
    playerMessagesLine: line,
    playerMessages,
  };
}

async function runG08Episode(
  entry: G08PlanEntry,
  store: BatchStore,
  gate: ChatBudgetGate,
  options: G08RunOptions & { requestConfig: ReturnType<typeof requestConfigFor> },
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
    mode: options.mode === 'live' ? 'live' : 'fixture',
    thinking: true,
    needPolicy: 'recurring',
    timeoutMs: options.timeoutMs,
    requestModel: options.model,
    actionSet: entry.actionSet,
  });

  // --- send: mailbox only, no model, no world, no budget ----------------
  const before = game.snapshot();
  const spentBeforeSend = gate.spent;
  const httpBeforeSend = http.length;
  const attemptsBeforeSend = attempts.length;
  const command = { commandId: `${entry.episodeId}:say:1`, to: G07_TARGET, text: G08_SCENARIO_TEXT };
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
    behavior: G08Behavior | null;
    snapshot: ReactiveRecord;
    prompt: G08EpisodeRecord['prompt'];
  }): G08EpisodeRecord => ({
    schema: G08_EPISODE_SCHEMA,
    plan: entry,
    scenarioText: G08_SCENARIO_TEXT,
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
    store.writeJson(`episodes/${entry.episodeId}.json`, record(run.outcome, run.failure, {
      decision: null,
      behavior: null,
      snapshot: game.snapshot(),
      prompt: { sha256: null, templateSha256: null, playerMessagesLine: null, playerMessages: null },
    }));
    writeStatus(store, entry.episodeId, statusOf(entry.episodeId, run));
    return run;
  }

  // --- exactly one advance: npc_a's natural decision -------------------
  const blockedBefore = gate.blocked;
  let advance: G07AdvanceView;
  let thrown: string | null = null;
  try {
    advance = advanceViewOf(await game.advance());
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
    store.writeJson(`episodes/${entry.episodeId}.json`, record(outcome, failure, {
      decision,
      behavior: null,
      snapshot: afterNpc,
      prompt: promptEvidence(http),
    }));
    writeStatus(store, entry.episodeId, statusOf(entry.episodeId, { outcome, failure }));
    return { outcome, failure };
  }

  // --- C1: an illegal action fails THIS experiment fast -----------------
  // The general NPC session keeps its own invalid-output retry strategy; the
  // experiment does not. A legacy wait (or any strict re-parse failure) is a
  // first-class failed episode: no player action, no second decision, and the
  // batch stops with the remaining slots not_run.
  const rawAction = decision.turns.find(turn => turn.providerCalled)?.raw ?? null;
  const action = strictG08Reparse(rawAction, entry.actionSet);
  if (action === 'invalid_output') {
    const run: EpisodeRun = {
      outcome: 'invalid_output',
      failure: `illegal action for the ${entry.actionSet} axis (strict re-parse failed); the experiment stops here without a player action`,
    };
    store.writeJson(`episodes/${entry.episodeId}.json`, record(run.outcome, run.failure, {
      decision,
      behavior: null,
      snapshot: afterNpc,
      prompt: promptEvidence(http),
    }));
    writeStatus(store, entry.episodeId, statusOf(entry.episodeId, run));
    return run;
  }

  // --- the player's single eat attempt (only after a real decision) -----
  const playerEat = game.playerLine('player eat');
  const final = game.snapshot();
  const behavior = g08BehaviorOf(final, entry, action, playerEat, game);
  const run: EpisodeRun = { outcome: 'completed', failure: null };
  store.writeJson(`episodes/${entry.episodeId}.json`, record(run.outcome, run.failure, {
    decision,
    behavior,
    snapshot: final,
    prompt: promptEvidence(http),
  }));
  writeStatus(store, entry.episodeId, statusOf(entry.episodeId, run));
  return run;
}

/* ------------------------------------------------------------------ */
/* batch                                                               */
/* ------------------------------------------------------------------ */

export async function runG08Batch(options: G08RunOptions): Promise<G08RunResult> {
  const limit = options.limit ?? G08_HARD_CHAT_LIMIT;
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
    schema: G08_PLAN_SCHEMA,
    batch: options.batchId,
    createdAt: new Date().toISOString(),
    version,
    mode: options.mode,
    model: options.model,
    endpointHost,
    hardChatLimit: limit,
    requestConfig,
    templateFingerprint: templateFingerprint(),
    scenarios: G08_SCENARIO_TEXT,
    initialState: 'A/B kitchen 40, C kitchen 70, kitchen food 1, dorm 0, simTime 0, actorOrder [A,C], recurring/event',
    plan: G08_PLAN,
    oneDecisionPerEpisode: true,
    noAdvanceTime: true,
    noRetries: true,
  });
  if (options.preflight !== undefined && options.preflight !== null) {
    store.writeJson('preflight.json', options.preflight);
  }

  const gate = new ChatBudgetGate(limit);
  if (options.preflight !== undefined && options.preflight !== null && !options.preflight.ok) {
    for (const entry of G08_PLAN) writeStatus(store, entry.episodeId, notRunStatus(entry.episodeId, 'preflight failed; no chat request was sent'));
    const verify = verifyG08Batch(store.dir);
    store.writeJson('summary.json', buildG08Summary(store.dir, options.batchId, options.mode, options.model, version, limit, gate, 'preflight_failed', verify));
    return { batchDir: store.dir, exitCode: 2, verify };
  }

  let fatal: string | null = null;
  for (const entry of G08_PLAN) {
    if (fatal !== null) {
      writeStatus(store, entry.episodeId, notRunStatus(entry.episodeId, `batch stopped earlier: ${fatal}`));
      continue;
    }
    const run = await runG08Episode(entry, store, gate, { ...options, timeoutMs, requestConfig });
    log(`${run.outcome.toUpperCase()} ${entry.episodeId}${run.failure === null ? '' : ` (${run.failure})`}`);
    if (run.outcome !== 'completed') {
      fatal = `${entry.episodeId}: ${run.outcome}${run.failure === null ? '' : ` (${run.failure})`}`;
      continue;
    }
    // The first legacy off/on pair is the structural gate: prove the wiring
    // and the shared template before spending the remaining six requests.
    if (entry.index === 2) {
      // Independent prefix scope: only the first legacy off/on pair is proven
      // here; zero completed episodes can never pass this gate.
      const gateResult = verifyG08Prefix(store.dir);
      log(`structural gate ${gateResult.ok ? 'ok' : `failed: ${[...gateResult.issues, ...gateResult.configurationIssues].join('; ')}`}`);
      if (!gateResult.evidenceOk) fatal = `structural gate failed: ${[...gateResult.issues, ...gateResult.configurationIssues].join('; ')}`;
    }
  }

  const verify = verifyG08Batch(store.dir);
  store.writeJson('summary.json', buildG08Summary(store.dir, options.batchId, options.mode, options.model, version, limit, gate, fatal, verify));
  // 0 only for a complete, self-consistent 8/8 batch.
  const exitCode = verify.runSucceeded ? 0 : 1;
  log(`completed=${verify.stats.completed} failed=${verify.stats.failed} notRun=${verify.stats.notRun} spent=${gate.spent}/${limit}${fatal === null ? '' : ` fatal=${fatal}`}`);
  return { batchDir: store.dir, exitCode, verify };
}

function buildG08Summary(
  batchDir: string, batchId: string, mode: 'live' | 'fake', model: string,
  version: unknown, limit: number, gate: ChatBudgetGate, fatal: string | null, verify: G08VerifyResult,
): Record<string, unknown> {
  const batch = readBatch(batchDir);
  const cellOf = (key: string) => verify.stats.cells.find(c => c.episodeId === key) ?? null;
  const byCell = {
    'legacy-off': cellOf('g08-r1-legacy-off') ?? cellOf('g08-r2-legacy-off'),
    'legacy-on': cellOf('g08-r1-legacy-on') ?? cellOf('g08-r2-legacy-on'),
    'timed_wait-off': cellOf('g08-r1-timed_wait-off') ?? cellOf('g08-r2-timed_wait-off'),
    'timed_wait-on': cellOf('g08-r1-timed_wait-on') ?? cellOf('g08-r2-timed_wait-on'),
  };
  return {
    schema: G08_SUMMARY_SCHEMA,
    batch: batchId,
    createdAt: new Date().toISOString(),
    mode,
    model,
    version,
    endpointHost: (batch.plan as { endpointHost?: string } | null)?.endpointHost ?? null,
    hardChatLimit: limit,
    gateSpent: gate.spent,
    gateBlocked: gate.blocked,
    fatal,
    totals: { planned: verify.stats.planned, completed: verify.stats.completed, failed: verify.stats.failed, notRun: verify.stats.notRun },
    chatRequests: verify.stats.chatRequests,
    structuralGate: { ok: verify.issues.length === 0 && verify.configurationIssues.length === 0, issues: verify.issues, configurationIssues: verify.configurationIssues },
    cells: byCell,
    episodes: verify.stats.cells,
    tokens: verify.stats.cells.map(c => ({ episodeId: c.episodeId, totalTokens: c.totalTokens })),
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
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith('--')) {
      args.set(key, value);
      i += 1;
    } else {
      args.set(key, '');
    }
  }
  return args;
}

function printVerify(result: G08VerifyResult, batchId: string): void {
  console.log(`verify ${batchId}: ok=${result.ok}`);
  for (const issue of result.issues) console.log(`  issue: ${issue}`);
  for (const issue of result.configurationIssues) console.log(`  config: ${issue}`);
  console.log(`  completed=${result.stats.completed}/${result.stats.planned} failed=${result.stats.failed} notRun=${result.stats.notRun} chatRequests=${result.stats.chatRequests}`);
  for (const cell of result.stats.cells) {
    console.log(`  ${cell.episodeId}: ${cell.outcome} action=${String(cell.npcAction)} npcAte=${String(cell.npcAte)} playerAte=${String(cell.playerAte)} wait=${String(cell.waitAccepted)} deadline=${String(cell.wakeAtSimTime)} tokens=${String(cell.totalTokens)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(args.get('--out') ?? 'artifacts/g08');
  if (args.has('--verify')) {
    // Accept both `--verify <batchId>` and the G07-style `--verify --batch <id>`.
    const batchId = args.get('--verify') !== '' ? args.get('--verify') : args.get('--batch');
    if (batchId === undefined || batchId === '' || !BATCH_NAME_RE.test(batchId)) {
      console.error('--verify expects a batch id');
      process.exit(2);
    }
    const batchDir = resolve(out, batchId);
    if (!existsSync(batchDir)) {
      console.error(`no such batch: ${batchDir}`);
      process.exit(2);
    }
    const result = verifyG08Batch(batchDir);
    printVerify(result, batchId);
    process.exit(result.ok ? 0 : 1);
  }

  const batchId = args.get('--batch');
  if (batchId === undefined || !BATCH_NAME_RE.test(batchId)) {
    console.error('need --batch <name> matching ^[a-z0-9][a-z0-9-]{0,63}$');
    process.exit(2);
  }
  const live = args.has('--live');
  let url = args.get('--http');
  let model = args.get('--model');
  let apiKey = args.get('--api-key');
  if (live) {
    const env = loadHttpConfigFromEnv();
    if (env === null) {
      console.error('--live requires the FROSTECHO_LLM_* environment for url/model');
      process.exit(2);
    }
    ({ url, model } = env);
    apiKey = env.apiKey ?? apiKey;
  }
  if (url === undefined || model === undefined) {
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
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > G08_HARD_CHAT_LIMIT)) {
    console.error(`--limit must be an integer in 1..${G08_HARD_CHAT_LIMIT}`);
    process.exit(2);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > G07_TIMEOUT_MS)) {
    console.error(`--timeout must be in 1..${G07_TIMEOUT_MS}`);
    process.exit(2);
  }

  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  let preflight: G07Preflight | null = null;
  if (!args.has('--no-preflight')) {
    preflight = await runPreflight(url, model, fetchImpl);
    for (const check of preflight.checks) {
      console.log(`preflight ${check.path} status=${String(check.status)} ok=${check.ok}${check.error === null ? '' : ` error=${check.error}`}`);
    }
    if (!preflight.ok) console.error('preflight failed: no chat request will be sent');
  }
  const result = await runG08Batch({
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
  printVerify(result.verify, batchId);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

if (require.main === module) {
  void main().catch(err => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(2);
  });
}
