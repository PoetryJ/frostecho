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
import { createBatchStore, type BatchStore } from '../src/eval/store';
import { createHttpProvider, renderDecidePrompt } from '../src/agent/providers/http';
import type { Provider, DecideInput, TransportRecord } from '../src/agent/contracts';
import { parseAction } from '../src/agent/parser';
import type { G08EffectiveConfig } from '../src/temporal/contracts';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import {
  G09_ALLOWED_GOALS, G09_HARD_CHAT_LIMIT, G09_REQUEST_TEXT, G09_TIMEOUT_MS,
  type GoalRequestSnapshot,
} from '../src/negotiation/contracts';
import { createGoalRequest, decideGoalRequest } from '../src/negotiation/requests';
import { checkGoalFulfilment, replayRequestOutcome } from '../src/negotiation/goal-check';
import {
  G09_NPC, G09_PLAYER, G09_CELLS, canonical, deriveG09, frozenPlanEntries, g09InitialState, g09Plan,
  g09Protocol, g09RuntimeConfig, projectG09Summary, readG09Batch, verifyG09Batch, verifyG09Prefix,
  type G09EpisodeRecord, type G09HttpExchange, type G09PlanEntry,
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
  const inner = rt.args.live
    ? createHttpProvider({
      url: rt.args.http, model: String(rt.config.requestModel), enableThinking: rt.config.thinking,
    })
    : createHttpProvider({
      url: 'http://fake.local/v1/chat/completions', model: 'fake-model',
      enableThinking: rt.config.thinking, fetchImpl: fake!.fetchImpl,
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
          const elapsedMs = Date.now() - started;
          rt.store.writeJson(`attempts/${attemptId}.finish.json`, {
            attemptId, at: new Date().toISOString(), outcome: 'success',
            status: transport?.status ?? null, error: null,
            usage: transport?.usage ?? null, elapsedMs,
          });
          attempts.push({ attemptId, outcome: 'success' });
          finishCampaignChat(rt.campaignDir, attemptId, { outcome: 'success', totalTokens: transport?.usage?.total_tokens ?? null });
          exchanges.push({
            phase, attemptId,
            requestBody: fake === null ? { prompt, model: requestConfig.model, temperature: 0, max_tokens: 1024, stream: false, enableThinking: rt.config.thinking } : fake.last.body,
            response: { status: transport?.status ?? null, body: fake === null ? JSON.stringify({ content: raw }) : fake.last.text, usage: transport?.usage ?? null },
            prompt, promptFingerprint: createHash('sha256').update(prompt).digest('hex'),
            elapsedMs, error: null,
          });
          return raw;
        } catch (err) {
          const elapsedMs = Date.now() - started;
          transport = inner.consumeTransport?.() ?? null;
          const message = err instanceof Error ? err.message : String(err);
          const outcome = message.includes('timeout') ? 'timeout' : 'provider_error';
          rt.store.writeJson(`attempts/${attemptId}.finish.json`, {
            attemptId, at: new Date().toISOString(), outcome,
            status: transport?.status ?? null, error: message, usage: transport?.usage ?? null, elapsedMs,
          });
          attempts.push({ attemptId, outcome });
          finishCampaignChat(rt.campaignDir, attemptId, { outcome, totalTokens: transport?.usage?.total_tokens ?? null });
          exchanges.push({
            phase, attemptId,
            requestBody: fake === null ? { prompt, model: requestConfig.model } : fake.last.body,
            response: { status: transport?.status ?? null, body: fake === null ? '' : fake.last.text, usage: transport?.usage ?? null },
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

  let outcome: G09EpisodeRecord['outcome'] = 'completed';
  let failure: string | null = null;
  let playerEat: G09EpisodeRecord['playerEat'] = null;

  const stepSession = () => game.sessionsOf().find(entry2 => entry2.actorId === G09_NPC)?.session ?? null;

  // Phase 1 — goal choice. The GAME store is the authority: the session's
  // decision is folded into it at the decision point.
  await game.advance();
  const session = stepSession();
  const storeRef = (game as unknown as { goalRequests(): { requests: Record<string, GoalRequestSnapshot> } }).goalRequests();
  request = storeRef.requests[entry.requestId] ?? request;
  const binding = session?.goalBinding ?? null;
  const decided = request.status === 'accepted' || request.status === 'declined';
  if (!decided) {
    outcome = request.status === 'expired' ? 'request_expired' : mapFailure(session?.status);
    failure = `goal phase ended: ${request.status} (${session?.status ?? 'no session'})`;
  } else {
    // Phase 2 — the action, same session and budget. A declined (feed_self)
    // request still runs the ordinary hunger goal and is NOT blocked.
    await game.advance();
    const after = stepSession();
    const actionCalled = exchanges.some(exchange => exchange.phase === 'action');
    if (!actionCalled) {
      outcome = mapFailure(after?.status);
      failure = `action phase ended: ${after?.status ?? 'no session'}`;
    } else {
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
  return {
    schema: 'frostecho.g09.episode/2',
    episodeId: entry.episodeId,
    cell: entry.cell,
    satiety: entry.satiety,
    arm: entry.arm,
    outcome,
    request,
    binding,
    goal: {
      round: binding?.decidedRound ?? 1,
      raw: goalExchange === undefined ? null : responseContentOf(goalExchange),
      parseOk: binding !== null,
      error: binding === null ? (failure ?? 'no goal binding') : null,
    },
    action: (() => {
      if (actionExchange === undefined) return { round: null, raw: null, parseOk: false, type: null, error: 'no action call' };
      const content = responseContentOf(actionExchange);
      const parsed = parseAction(content, 'timed_wait');
      return {
        round: 2, raw: content, parseOk: parsed.ok,
        type: parsed.ok ? parsed.action.type : null,
        error: parsed.ok ? null : parsed.error,
      };
    })(),
    fulfilment: fulfilment === null ? null : { verdict: fulfilment.verdict, evidence: fulfilment.evidence, outcome: request.outcome, reason: request.outcomeReason },
    playerEat,
    http: exchanges,
    attempts,
    tokens: {
      goal: goalExchange?.response.usage?.total_tokens ?? null,
      action: actionExchange?.response.usage?.total_tokens ?? null,
      total: goalExchange !== undefined && actionExchange !== undefined
        ? (goalExchange.response.usage?.total_tokens ?? 0) + (actionExchange.response.usage?.total_tokens ?? 0)
        : null,
    },
    snapshot: { initialState: snapshot.initialState, commands: snapshot.commands, events: snapshot.events, finalState: snapshot.finalState },
    runtime,
    failure,
  };
}

function responseContentOf(exchange: G09HttpExchange): string {
  try {
    const body = JSON.parse(exchange.response.body) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

function mapFailure(status: string | undefined): G09EpisodeRecord['outcome'] {
  switch (status) {
    case 'budget_exhausted': return 'insufficient_budget';
    case 'insufficient_budget': return 'insufficient_budget';
    case 'timeout': return 'timeout';
    case 'provider_error': return 'provider_error';
    case 'request_expired': return 'request_expired';
    case 'stopped': return 'request_expired';
    default: return 'invalid_run';
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
    schema: 'frostecho.g09.episode/2',
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
