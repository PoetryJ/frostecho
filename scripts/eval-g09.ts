#!/usr/bin/env node
/**
 * G09-R1 worker D — the ORIGINAL goal-choice experiment runner.
 *
 * Frozen: 8 episodes = {40,60} × {self_only,choice} × 2, rep 2 reversed, one
 * S1 in both arms, recurring needs + event wake + timed_wait + [A,C], exactly
 * two HTTP calls per episode (goal, action) then the player's eat. The chat
 * budget is TASK-scoped and persisted in a campaign ledger; a batch name never
 * refreshes it and a restart never resets it.
 */
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createBatchStore, type BatchStore } from '../src/eval/store';
import { ACTIVE_GOAL_PROMPT_VERSION, activeGoalPromptFingerprint, createHttpProvider, renderDecidePrompt } from '../src/agent/providers/http';
import type { Provider, DecideInput, TransportRecord } from '../src/agent/contracts';
import { parseAction } from '../src/agent/parser';
import type { G08EffectiveConfig } from '../src/temporal/contracts';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import {
  G09_ALLOWED_GOALS, G09_EPISODE_SCHEMA, G09_HARD_CHAT_LIMIT, G09_REQUEST_TEXT, G09_TIMEOUT_MS, strictGoalChoice,
  type GoalRequestSnapshot,
} from '../src/negotiation/contracts';
import { createGoalRequest, decideGoalRequest } from '../src/negotiation/requests';
import { checkGoalFulfilment, replayRequestOutcome } from '../src/negotiation/goal-check';
import {
  G09_NPC, G09_PLAYER, G09_CELLS, canonical, createWireCollector, deriveG09, frozenPlanEntries, g09InitialState,
  g09Plan, g09Protocol, g09RuntimeConfig, projectG09Summary, readG09Batch, verifyG09Batch, verifyG09Prefix, wireUsage,
  classifyHttpExchange,
  type G09EpisodeRecord, type G09ExchangeKind, type G09HttpExchange, type G09Outcome, type G09PlanEntry,
} from './g09-eval-lib';
import {
  campaignCounts, finishCampaignChat, loadCampaign, openCampaign, reserveCampaignChat,
} from './campaign-budget';

interface Args {
  out: string; batch: string | null; http: string; model: string | null;
  live: boolean; verify: boolean; prefix: boolean;
  campaign: string | null; campaignLimit: number | null;
  fakeGoal: 'feed_self' | 'yield_once'; fakeAction: string;
}

const USAGE = `Usage:
  eval-g09 --out DIR --batch NAME --campaign DIR [--campaign-limit N]
           [--live --http URL --model M | --fake [--fake-goal G] [--fake-action JSON]]
  eval-g09 --verify --out DIR --batch NAME --campaign DIR`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'artifacts/g09-r1', batch: null,
    http: process.env.FROSTECHO_LLM_URL ?? 'http://127.0.0.1:18872/v1/chat/completions',
    model: process.env.FROSTECHO_LLM_MODEL ?? null,
    live: false, verify: false, prefix: false,
    campaign: null, campaignLimit: null,
    fakeGoal: 'yield_once', fakeAction: '{"type":"eat"}',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--out': args.out = argv[++i]; break;
      case '--batch': args.batch = argv[++i]; break;
      case '--http': args.http = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--campaign': args.campaign = argv[++i]; break;
      case '--campaign-limit': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v < 0) fail('--campaign-limit expects a non-negative integer');
        args.campaignLimit = v;
        break;
      }
      case '--live': args.live = true; break;
      case '--verify': args.verify = true; break;
      case '--prefix': args.prefix = true; break;
      case '--fake': args.live = false; break;
      case '--fake-goal': {
        const v = argv[++i];
        if (v !== 'feed_self' && v !== 'yield_once') fail('--fake-goal must be feed_self|yield_once');
        args.fakeGoal = v;
        break;
      }
      case '--fake-action': args.fakeAction = argv[++i]; break;
      case '--help': case '-h': console.log(USAGE); process.exit(0); break;
      default: fail(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    }
  }
  return args;
}

function config(args: Args): G08EffectiveConfig {
  if (args.live && args.model === null) fail('--live requires --model (or FROSTECHO_LLM_MODEL)');
  return { mode: args.live ? 'live' : 'reference', requestModel: args.model, thinking: true, timeoutMs: G09_TIMEOUT_MS };
}

async function preflight(url: string, model: string): Promise<void> {
  const base = url.replace(/\/v1\/chat\/completions\/?$/, '');
  for (const path of ['/health', '/v1/models']) {
    const response = await fetch(`${base}${path}`, { method: 'GET' });
    if (!response.ok) fail(`preflight ${path} status=${response.status}`);
    if (path === '/v1/models') {
      const body = await response.json() as { data?: { id?: string }[] };
      const ids = (body.data ?? []).map(entry => entry.id);
      if (!ids.includes(model)) fail(`preflight /v1/models does not list ${model} (got ${ids.join(', ')})`);
    }
    console.log(`preflight ${path} status=200 ok=true`);
  }
}

/** Deterministic responder: same shape as the live wire, deterministic content. */
function fakeResponder(args: Args): { fetchImpl: typeof fetch; last: { body: Record<string, unknown>; status: number; text: string } } {
  const last = { body: {} as Record<string, unknown>, status: 0, text: '' };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    last.body = body;
    const messages = body.messages as { content?: string }[] | undefined;
    const prompt = String(messages?.[0]?.content ?? '');
    const isGoal = prompt.includes('candidateGoals:');
    const content = isGoal
      ? (prompt.includes('"yield_once"') ? JSON.stringify({ goal: args.fakeGoal }) : '{"goal":"feed_self"}')
      : args.fakeAction;
    const text = JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });
    last.status = 200;
    last.text = text;
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, last };
}

interface EpisodeRuntime {
  store: BatchStore;
  args: Args;
  config: G08EffectiveConfig;
  campaignDir: string;
  batch: string;
}

async function runEpisode(entry: G09PlanEntry, rt: EpisodeRuntime): Promise<G09EpisodeRecord> {
  const exchanges: G09HttpExchange[] = [];
  const attempts: { attemptId: string; outcome: string }[] = [];
  const runtime = g09RuntimeConfig();
  const initialState = g09InitialState(entry.satiety);
  const requestBuilt = createGoalRequest({
    requestId: entry.requestId, episodeId: entry.episodeId, to: G09_NPC,
    text: G09_REQUEST_TEXT, options: G09_ALLOWED_GOALS[entry.arm],
    createdAtSimTime: Number(initialState.simTime ?? 0), arm: entry.arm,
  });
  if (!requestBuilt.ok) throw new Error(`cannot build the request: ${requestBuilt.issues.join('; ')}`);
  let request: GoalRequestSnapshot = requestBuilt.value;

  const fake = rt.args.live ? null : fakeResponder(rt.args);
  // ONE collection chain for both branches: the provider always goes through
  // the wrapped fetch, so the recorded body/status/text are the real wire.
  const collector = createWireCollector(rt.args.live ? fetch : fake!.fetchImpl);
  const inner = createHttpProvider({
    url: rt.args.live ? rt.args.http : 'http://fake.local/v1/chat/completions',
    model: rt.args.live ? String(rt.config.requestModel) : 'fake-model',
    enableThinking: rt.config.thinking,
    fetchImpl: collector.fetchImpl,
  });

  const providerFor = (): Provider => {
    let transport: TransportRecord | null = null;
    return {
      async decide(input: DecideInput, signal?: AbortSignal) {
        const phase = input.goalChoice !== undefined ? 'goal' : 'action';
        // The attempt id is captured AFTER the reserve, immutably, for THIS call.
        const reservation = reserveCampaignChat(rt.campaignDir, {
          batch: rt.batch, episodeId: entry.episodeId, phase,
        });
        if (!reservation.ok) {
          const blocked = { attemptId: null, at: new Date().toISOString(), episodeId: entry.episodeId, actorId: G09_NPC, cycle: 1, round: 1, code: 'CHAT_BUDGET_EXHAUSTED' };
          rt.store.writeJson(`attempts/blocked-${String(rt.store.path('attempts')).length}.json`, blocked);
          throw new Error(`campaign budget: ${reservation.reason}`);
        }
        const attemptId = reservation.attemptId;
        const prompt = renderDecidePrompt(input);
        const requestConfig = {
          model: rt.args.live ? rt.config.requestModel : 'fake-model',
          temperature: 0, max_tokens: 1024, stream: false,
          enableThinking: [rt.config.thinking], timeoutMs: rt.config.timeoutMs,
        };
        rt.store.writeJson(`attempts/${attemptId}.begin.json`, {
          attemptId, seq: Number(attemptId.slice(4)), episodeId: entry.episodeId,
          actorId: G09_NPC, cycle: 1, round: phase === 'goal' ? 1 : 2,
          at: new Date().toISOString(), requestConfig, prompt, phase,
        });
        const started = Date.now();
        try {
          const raw = await inner.decide(input, signal as AbortSignal);
          transport = inner.consumeTransport?.() ?? null;
          const wire = collector.take();
          const elapsedMs = Date.now() - started;
          const usage = wire === null || wire.responseBody === null ? null : wireUsage(wire.responseBody);
          rt.store.writeJson(`attempts/${attemptId}.finish.json`, {
            attemptId, at: new Date().toISOString(), outcome: 'success',
            status: wire?.status ?? transport?.status ?? null, error: null,
            usage: usage ?? transport?.usage ?? null, elapsedMs,
          });
          attempts.push({ attemptId, outcome: 'success' });
          finishCampaignChat(rt.campaignDir, attemptId, { outcome: 'success', totalTokens: usage?.total_tokens ?? null });
          exchanges.push({
            phase, attemptId,
            requestBody: wire?.requestBody ?? {},
            response: {
              status: wire?.status ?? null,
              body: wire?.responseBody ?? null,
              usage,
            },
            prompt, promptFingerprint: createHash('sha256').update(prompt).digest('hex'),
            elapsedMs, error: null,
          });
          return raw;
        } catch (err) {
          const elapsedMs = Date.now() - started;
          transport = inner.consumeTransport?.() ?? null;
          const wire = collector.take();
          const message = err instanceof Error ? err.message : String(err);
          const outcome = message.includes('timeout') ? 'timeout' : 'provider_error';
          const usage = wire === null || wire.responseBody === null ? null : wireUsage(wire.responseBody);
          rt.store.writeJson(`attempts/${attemptId}.finish.json`, {
            attemptId, at: new Date().toISOString(), outcome,
            status: wire?.status ?? transport?.status ?? null, error: message,
            // G10: the wire classification travels with the attempt, so the
            // truncated/empty distinction survives independently of the text.
            classification: transport?.classification ?? null,
            finishReason: transport?.finishReason ?? null,
            usage: usage ?? transport?.usage ?? null, elapsedMs,
          });
          attempts.push({ attemptId, outcome });
          finishCampaignChat(rt.campaignDir, attemptId, { outcome, totalTokens: usage?.total_tokens ?? null });
          exchanges.push({
            phase, attemptId,
            requestBody: wire?.requestBody ?? {},
            response: { status: wire?.status ?? null, body: wire?.responseBody ?? null, usage },
            prompt, promptFingerprint: createHash('sha256').update(prompt).digest('hex'),
            elapsedMs, error: message,
          });
          throw err;
        }
      },
      consumeTransport: () => {
        const slot = transport;
        transport = null;
        return slot;
      },
    };
  };

  const game = createNeedsGame({
    episodeId: entry.episodeId,
    initialState,
    actorIds: runtime.actorIds,
    providerFor,
    mode: rt.args.live ? 'live' : 'reference',
    thinking: rt.config.thinking,
    needPolicy: runtime.needPolicy,
    requestModel: rt.args.live ? rt.config.requestModel ?? undefined : 'fake-model',
    timeoutMs: rt.config.timeoutMs,
    actionSet: runtime.actionSet,
    goalMode: runtime.goalMode,
    candidateSet: entry.arm,
    playerId: G09_PLAYER,
  });
  const controller = game as unknown as { submitGoalRequest(r: GoalRequestSnapshot): { ok: boolean; issues?: string[] } };
  const enqueued = controller.submitGoalRequest(request);
  if (!enqueued.ok) throw new Error(`cannot enqueue the request: ${(enqueued.issues ?? []).join('; ')}`);

  // G10: a phase is a success only when the WIRE served usable content AND
  // the strict parser accepted it AND the session actually processed it. The
  // mere existence of a POST is NOT a completed phase.
  let outcome: G09Outcome = 'not_run';
  let failure: string | null = null;
  let playerEat: G09EpisodeRecord['playerEat'] = null;

  const stepSession = () => game.sessionsOf().find(entry2 => entry2.actorId === G09_NPC)?.session ?? null;
  const exchangeOf = (phase: 'goal' | 'action'): G09HttpExchange | undefined => exchanges.find(exchange => exchange.phase === phase);

  // Phase 1 — goal choice. The GAME store is the authority: the session's
  // decision is folded into it at the decision point.
  await game.advance();
  const storeRef = (game as unknown as { goalRequests(): { requests: Record<string, GoalRequestSnapshot> } }).goalRequests();
  request = storeRef.requests[entry.requestId] ?? request;
  const binding = stepSession()?.goalBinding ?? null;
  const goalClass = classifyHttpExchange(exchangeOf('goal'));
  const goalParsed = strictGoalChoice(goalClass.content, G09_ALLOWED_GOALS[entry.arm]);
  const goalOk = goalClass.kind === 'ok' && goalParsed.ok;

  if (!goalOk) {
    outcome = goalClass.kind === 'ok' ? 'invalid_run' : mapExchangeKind(goalClass.kind);
    failure = `goal phase failed: ${goalClass.kind}${goalClass.finishReason === null ? '' : ` (finish_reason=${goalClass.finishReason})`}${goalParsed.ok ? '' : ` / ${goalParsed.error}`}`;
  } else {
    // Phase 2 — the action, same session and budget. A declined (feed_self)
    // request still runs the ordinary hunger goal and is NOT blocked.
    await game.advance();
    const after = stepSession();
    const actionClass = classifyHttpExchange(exchangeOf('action'));
    const actionParsed = actionClass.kind === 'ok'
      ? parseAction(actionClass.content, 'timed_wait')
      : { ok: false as const, error: actionClass.kind };
    const terminal = after === null ? null : after.result().outcome;
    if (exchangeOf('action') === undefined) {
      outcome = mapTerminal(terminal, after?.status);
      failure = `action phase was never called (${after?.status ?? 'no session'})`;
    } else if (actionClass.kind !== 'ok') {
      outcome = mapExchangeKind(actionClass.kind);
      failure = `action phase failed: ${actionClass.kind}${actionClass.finishReason === null ? '' : ` (finish_reason=${actionClass.finishReason})`}`;
    } else if (!actionParsed.ok) {
      outcome = 'invalid_action';
      failure = `action answer is not a legal timed_wait action: ${actionParsed.error}`;
    } else if (terminal !== null && terminal !== 'stopped' && terminal !== 'selected_goal_yield' && terminal !== 'goal_reached') {
      // A legally parsed action that the session DISCARDED (late/expired
      // answer, budget) is not a completion either.
      outcome = mapTerminal(terminal, after?.status);
      failure = `action phase was discarded: ${terminal}`;
    } else {
      outcome = 'completed';
      // The scripted player eat runs ONLY after a legal, processed action.
      const eat = game.playerLine('player eat');
      playerEat = { ok: eat.ok, detail: eat.detail ?? null };
    }
  }

  // Replay the authoritative ledger into the request, in order, with each
  // command's own time (the request's decision time is the anchor).
  const snapshot = game.snapshot();
  const ledgerCommands = (snapshot.commands as { seq: number; command: { actorId: string; type: string }; result?: { status?: string; reason?: string } }[]) ?? [];
  const replayed = replayRequestOutcome(request, binding, { commands: ledgerCommands as never, finalSimTime: snapshot.finalState?.simTime });
  request = replayed;
  const fulfilment = binding === null
    ? null
    : checkGoalFulfilment(binding, { commands: ledgerCommands as never }, G09_NPC, G09_PLAYER);

  const goalExchange = exchanges.find(exchange => exchange.phase === 'goal');
  const actionExchange = exchanges.find(exchange => exchange.phase === 'action');
  const goalClassFinal = classifyHttpExchange(goalExchange);
  const actionClassFinal = classifyHttpExchange(actionExchange);
  const goalParsedFinal = goalExchange === undefined
    ? { ok: false as const, error: 'no goal call' }
    : strictGoalChoice(goalClassFinal.content, G09_ALLOWED_GOALS[entry.arm]);
  const actionParsedFinal = actionExchange === undefined
    ? { ok: false as const, error: 'no action call' }
    : parseAction(actionClassFinal.content, 'timed_wait');
  const goalTokens = goalExchange?.response.usage?.total_tokens ?? null;
  const actionTokens = actionExchange?.response.usage?.total_tokens ?? null;
  return {
    schema: G09_EPISODE_SCHEMA,
    episodeId: entry.episodeId,
    cell: entry.cell,
    satiety: entry.satiety,
    arm: entry.arm,
    outcome,
    request,
    binding,
    goal: {
      // The strict parse of the WIRE answer, not `binding !== null`: a legal
      // feed_self parses ok and carries no binding.
      round: binding?.decidedRound ?? 1,
      raw: goalExchange === undefined ? null : goalClassFinal.content,
      parseOk: goalParsedFinal.ok,
      error: goalParsedFinal.ok ? null : `goal: ${goalParsedFinal.error}`,
    },
    action: {
      round: actionExchange === undefined ? null : 2,
      raw: actionExchange === undefined ? null : actionClassFinal.content,
      parseOk: actionParsedFinal.ok,
      type: actionParsedFinal.ok ? actionParsedFinal.action.type : null,
      error: actionParsedFinal.ok ? null : actionParsedFinal.error,
    },
    fulfilment: fulfilment === null ? null : { verdict: fulfilment.verdict, evidence: fulfilment.evidence, outcome: request.outcome, reason: request.outcomeReason },
    playerEat,
    http: exchanges,
    attempts,
    tokens: {
      goal: goalTokens,
      action: actionTokens,
      total: goalTokens !== null && actionTokens !== null ? goalTokens + actionTokens : null,
    },
    snapshot: { initialState: snapshot.initialState, commands: snapshot.commands, events: snapshot.events, finalState: snapshot.finalState },
    runtime,
    failure,
  };
}

/** Wire classification → episode outcome (never a silent `completed`). */
function mapExchangeKind(kind: G09ExchangeKind): G09Outcome {
  switch (kind) {
    case 'output_truncated': return 'output_truncated';
    case 'empty_output': return 'empty_output';
    case 'timeout': return 'timeout';
    case 'provider_error': return 'provider_error';
    case 'http_error': return 'provider_error';
    case 'invalid_response_json': return 'provider_error';
    default: return 'invalid_run';
  }
}

/** Session terminal outcome → episode outcome, for a discarded/failed phase. */
function mapTerminal(terminal: string | null, status: string | undefined): G09Outcome {
  switch (terminal) {
    case 'request_expired': return 'request_expired';
    case 'selected_goal_yield': return 'request_expired';
    case 'insufficient_budget': return 'insufficient_budget';
    case 'budget_exhausted': return 'insufficient_budget';
    case 'timeout': return 'timeout';
    case 'provider_error': return 'provider_error';
    case 'failed': return 'provider_error';
    default:
      switch (status) {
        case 'timeout': return 'timeout';
        case 'provider_error': return 'provider_error';
        case 'invalid_run': return 'invalid_run';
        case 'budget_exhausted': return 'insufficient_budget';
        default: return 'invalid_run';
      }
  }
}

async function run(args: Args): Promise<number> {
  if (args.batch === null) fail('--batch is required');
  if (args.campaign === null) fail('--campaign is required (the budget belongs to the task, not the batch)');
  const cfg = config(args);
  const campaignDir = resolve(args.campaign);
  const limit = args.campaignLimit ?? G09_HARD_CHAT_LIMIT;
  const campaign = existsSyncCampaign(campaignDir) ? loadCampaign(campaignDir) : openCampaign(campaignDir, limit);
  const counts = campaignCounts(campaign);
  if (counts.spent >= counts.limit) {
    console.log(`campaign ${campaign.campaignId}: ${counts.spent}/${counts.limit} spent — no chat may be sent`);
    return 2;
  }
  if (args.live) await preflight(args.http, String(cfg.requestModel));

  const store = createBatchStore(resolve(args.out), args.batch);
  const plan = g09Plan(args.batch);
  store.writeJson('plan.json', {
    ...plan,
    createdAt: new Date().toISOString(),
    mode: cfg.mode,
    model: cfg.requestModel,
    thinking: cfg.thinking,
    timeoutMs: cfg.timeoutMs,
    cells: G09_CELLS,
    frozen: { source: 'spec-lock', matrix: plan.plan.map(entry => [entry.rep, entry.satiety, entry.arm]) },
    initialStates: Object.fromEntries(G09_CELLS.map(cell => [cell.cell, g09InitialState(cell.satiety)])),
    // G10: the action-template version and the exact rendered-template hash
    // are frozen into the plan BEFORE the batch runs, together with the source
    // commit that produced this binary.
    actionContract: {
      version: ACTIVE_GOAL_PROMPT_VERSION,
      promptFingerprint: activeGoalPromptFingerprint(),
      reportSchema: 'g10-action-contract/1',
    },
    source: sourceIdentity(),
  });

  const rt: EpisodeRuntime = { store, args, config: cfg, campaignDir, batch: args.batch };
  let stop = false;
  for (const entry of plan.plan) {
    if (stop) {
      store.writeJson(`episodes/${entry.episodeId}.json`, notRunRecord(entry));
      console.log(`NOT_RUN ${entry.episodeId}`);
      continue;
    }
    const record = await runEpisode(entry, rt);
    store.writeJson(`episodes/${entry.episodeId}.json`, record);
    console.log(`${record.outcome.toUpperCase()} ${entry.episodeId} goal=${record.binding?.goal ?? '-'} verdict=${record.fulfilment?.verdict ?? '-'} outcome=${record.fulfilment?.outcome ?? '-'}`);
    if (record.outcome !== 'completed') { stop = true; continue; }
    if (entry.index === 2) {
      const prefix = verifyG09Prefix(store.dir, campaignCounts(loadCampaign(campaignDir)));
      console.log(`structural gate ok=${prefix.evidenceOk}`);
      if (!prefix.evidenceOk) { console.log(prefix.issues.join('\n')); stop = true; }
    }
  }

  const after = campaignCounts(loadCampaign(campaignDir));
  const batch = readG09Batch(store.dir);
  const derivation = deriveG09(batch, frozenPlanEntries(), after);
  const summary = projectG09Summary(args.batch, args.live ? 'live' : 'fake', cfg.requestModel, derivation);
  store.writeJson('summary.json', summary);
  store.writeJson('status/finished.json', {
    at: new Date().toISOString(), campaign: { limit: after.limit, spent: after.spent, known: after.known },
    planned: plan.plan.length,
  });

  const verify = verifyG09Batch(store.dir, after);
  const p = verify.derivation.protocol;
  console.log(`completed=${p.completed} failed=${p.failed} notRun=${p.notRun} chats=${verify.derivation.costs.chatRequests}/${G09_HARD_CHAT_LIMIT} campaign=${after.spent}/${after.limit}`);
  console.log(`batch -> ${store.dir}`);
  console.log(`verify ${args.batch}: ok=${verify.ok} complete=${verify.complete} evidenceOk=${verify.evidenceOk}`);
  console.log(`  goals=${JSON.stringify(verify.derivation.goals)}`);
  console.log(`  fulfilment=${JSON.stringify(verify.derivation.fulfilment)}`);
  console.log(`  costs goal=${verify.derivation.costs.goalTokens} action=${verify.derivation.costs.actionTokens} total=${verify.derivation.costs.totalTokens}`);
  for (const episode of verify.derivation.episodes) {
    console.log(`  ${episode.episodeId}: ${episode.outcome} goal=${episode.goal ?? '-'} request=${episode.request ?? '-'} verdict=${episode.verdict ?? '-'}`);
  }
  if (!verify.ok) for (const issue of verify.issues) console.log(`  ! ${issue}`);
  return verify.runSucceeded ? 0 : 1;
}

function sourceIdentity(): { commit: string | null; branch: string | null } {
  try {
    const run = (cmd: string): string | null => {
      const out = execSync(cmd, { encoding: 'utf8' }).trim();
      return out.length > 0 ? out : null;
    };
    return { commit: run('git rev-parse HEAD'), branch: run('git rev-parse --abbrev-ref HEAD') };
  } catch {
    return { commit: null, branch: null };
  }
}

function existsSyncCampaign(dir: string): boolean {
  try {
    loadCampaign(dir);
    return true;
  } catch {
    return false;
  }
}

function notRunRecord(entry: G09PlanEntry): G09EpisodeRecord {
  const initial = g09InitialState(entry.satiety);
  return {
    schema: G09_EPISODE_SCHEMA,
    episodeId: entry.episodeId, cell: entry.cell, satiety: entry.satiety, arm: entry.arm,
    outcome: 'not_run', request: null, binding: null,
    goal: { round: 1, raw: null, parseOk: false, error: null },
    action: { round: null, raw: null, parseOk: false, type: null, error: null },
    fulfilment: null, playerEat: null, http: [], attempts: [],
    tokens: { goal: null, action: null, total: null },
    snapshot: { initialState: initial, commands: [], events: [], finalState: initial },
    runtime: g09RuntimeConfig(),
    failure: 'not_run',
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) {
    if (args.batch === null || args.campaign === null) fail('--verify requires --batch and --campaign');
    const after = campaignCounts(loadCampaign(resolve(args.campaign)));
    const verify = verifyG09Batch(resolve(args.out, args.batch), after);
    console.log(`verify ${args.batch}: ok=${verify.ok} complete=${verify.complete} evidenceOk=${verify.evidenceOk}`);
    console.log(`  protocol=${JSON.stringify(verify.derivation.protocol)}`);
    console.log(`  goals=${JSON.stringify(verify.derivation.goals)}`);
    console.log(`  fulfilment=${JSON.stringify(verify.derivation.fulfilment)}`);
    console.log(`  costs=${JSON.stringify(verify.derivation.costs)}`);
    if (!verify.ok) for (const issue of verify.issues) console.log(`  ! ${issue}`);
    return verify.runSucceeded ? 0 : 1;
  }
  return run(args);
}

void canonical;
void g09Protocol;
void G09_REQUEST_TEXT;

main().then(code => process.exit(code)).catch(error => fail(error instanceof Error ? error.message : String(error)));
