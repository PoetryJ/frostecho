#!/usr/bin/env node
/**
 * G09 worker D — the goal-choice experiment runner.
 *
 * Frozen protocol: 8 episodes = {satiety 40|60} x {self_only|choice} x 2 reps,
 * each episode exactly two phases (goal, action) in ONE session, every phase
 * charged to the same budget, hard cap 16 chat requests for the whole batch.
 *
 * Flow: preflight (read-only GET) → create batch → run episodes serially →
 * structural gate after the first pair → write the deriving summary → verify
 * the whole batch READ-ONLY → exit from that verification.
 *
 * Fail-stop: a structural or goal violation stops the batch (the rest stay
 * not_run) and the exit code is nonzero. No retries, no extra batches.
 */
import { join, resolve } from 'node:path';
import { createBatchStore, type BatchStore } from '../src/eval/store';
import { ChatBudgetGate, createBudgetedProvider } from '../src/needs/live-budget';
import type { LiveAttemptBegin, LiveAttemptFinish, LiveBlockedRecord } from '../src/needs/live-contracts';
import type { TransportRecord } from '../src/agent/contracts';
import { createHttpProvider } from '../src/agent/providers/http';
import { parseAction } from '../src/agent/parser';
import type { Provider } from '../src/agent/contracts';
import type { G08EffectiveConfig } from '../src/temporal/contracts';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { createG09ReferenceProvider } from '../src/negotiation/reference';
import {
  G09_BINDING_SCHEMA, G09_EPISODE_SCHEMA, G09_GOAL_DEADLINE_ROUND, G09_HARD_CHAT_LIMIT,
  type GoalBinding, type GoalChoiceId, type GoalRequestSnapshot,
} from '../src/negotiation/contracts';
import { createGoalRequest, decideGoalRequest } from '../src/negotiation/requests';
import { checkGoalFulfilment } from '../src/negotiation/goal-check';
import {
  G09_CELLS, G09_NPC, G09_PLAYER, G09_TIMEOUT_MS, canonical, deriveG09, g09InitialState, g09Plan, g09Protocol,
  projectG09Summary, readG09Batch, verifyG09Batch, verifyG09Prefix,
  type G09EpisodeRecord, type G09Exchange, type G09PlanEntry,
} from './g09-eval-lib';

interface Args {
  out: string; batch: string | null; http: string; model: string | null;
  live: boolean; verify: boolean; prefix: boolean;
  fakeGoal: GoalChoiceId; fakeAction: string;
}

const USAGE = `Usage:
  eval-g09 --out DIR --batch NAME [--live --http URL --model M | --fake [--fake-goal G] [--fake-action JSON]]
  eval-g09 --verify --out DIR --batch NAME`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'artifacts/g09', batch: null,
    http: process.env.FROSTECHO_LLM_URL ?? 'http://127.0.0.1:18872/v1/chat/completions',
    model: process.env.FROSTECHO_LLM_MODEL ?? null,
    live: false, verify: false, prefix: false,
    fakeGoal: 'yield_once', fakeAction: '{"type":"eat"}',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--out': args.out = argv[++i]; break;
      case '--batch': args.batch = argv[++i]; break;
      case '--http': args.http = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
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
  return {
    mode: args.live ? 'live' : 'reference',
    requestModel: args.live ? args.model : args.model,
    thinking: true,
    timeoutMs: G09_TIMEOUT_MS,
  };
}

async function preflight(url: string, model: string): Promise<void> {
  const base = url.replace(/\/v1\/chat\/completions\/?$/, '');
  for (const [label, path] of [['health', '/health'], ['models', '/v1/models']] as const) {
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

interface EpisodeRuntime {
  store: BatchStore;
  gate: ChatBudgetGate;
  config: G08EffectiveConfig;
  args: Args;
}

/** One episode: goal phase, action phase, the player's single eat attempt. */
async function runEpisode(entry: G09PlanEntry, rt: EpisodeRuntime): Promise<G09EpisodeRecord> {
  const exchanges: G09Exchange[] = [];
  const attempts: { attemptId: string; outcome: string }[] = [];
  const blocked: LiveBlockedRecord[] = [];
  let lastAttemptId: string | null = null;
  let seq = 0;
  const requestConfig = {
    model: rt.config.requestModel, temperature: 0, max_tokens: 1024, stream: false,
    enableThinking: [rt.config.thinking], timeoutMs: rt.config.timeoutMs,
  };

  const request: GoalRequestSnapshot | null = entry.requestId === null ? null : (() => {
    const built = createGoalRequest({
      requestId: entry.requestId!, episodeId: entry.episodeId, to: G09_NPC,
      text: g09Protocol(entry).text, options: g09Protocol(entry).options,
      createdAtSimTime: 0, arm: entry.arm,
    });
    if (!built.ok) throw new Error(`cannot build the request: ${built.issues.join('; ')}`);
    return built.value;
  })();
  let requestState = request;

  const inner = rt.args.live
    ? createHttpProvider({
      url: rt.args.http, model: String(rt.config.requestModel),
      enableThinking: rt.config.thinking,
    })
    // Fake mode goes through the SAME HTTP adapter with an injected fetch, so
    // the evidence (transport, usage, tokens) has exactly the live shape.
    : createHttpProvider({
      url: 'http://fake.local/v1/chat/completions',
      model: 'fake-model',
      enableThinking: rt.config.thinking,
      fetchImpl: fakeResponder(rt.args),
    });

  const providerFor = (): Provider => {
    const budgeted = createBudgetedProvider({
      gate: rt.gate,
      requestConfig,
      episodeId: entry.episodeId,
      actorId: G09_NPC,
      cycle: 1,
      inner,
      hooks: {
        beginAttempt: (begin: LiveAttemptBegin) => {
          lastAttemptId = begin.attemptId;
          seq += 1;
          rt.store.writeJson(`attempts/${begin.attemptId}.begin.json`, begin);
          attempts.push({ attemptId: begin.attemptId, outcome: 'pending' });
        },
        finishAttempt: (finish: LiveAttemptFinish) => {
          rt.store.writeJson(`attempts/${finish.attemptId}.finish.json`, finish);
          const slot = attempts.find(candidate => candidate.attemptId === finish.attemptId);
          if (slot !== undefined) slot.outcome = finish.outcome;
        },
        recordBlocked: (record: LiveBlockedRecord) => {
          blocked.push(record);
          rt.store.writeJson(`attempts/blocked-${String(blocked.length).padStart(4, '0')}.json`, { ...record, seq: blocked.length });
        },
      },
    });
    let transport: TransportRecord | null = null;
    const wrapped: Provider = {
      async decide(input, signal) {
        const attemptId = lastAttemptId;
        const raw = await budgeted.decide(input, signal);
        transport = budgeted.consumeTransport?.() ?? null;
        exchanges.push({
          stage: input.goalChoice !== undefined ? 'goal' : 'action',
          attemptId,
          status: transport?.status ?? null,
          raw,
          usage: transport?.usage ?? null,
          error: null,
        });
        return raw;
      },
      consumeTransport: () => {
        const slot = transport;
        transport = null;
        return slot;
      },
    };
    return wrapped;
  };

  const game = createNeedsGame({
    episodeId: entry.episodeId,
    initialState: g09InitialState(entry.satiety),
    actorIds: [G09_NPC],
    providerFor,
    mode: rt.args.live ? 'live' : 'reference',
    thinking: rt.config.thinking,
    needPolicy: 'one-shot',
    requestModel: rt.config.requestModel ?? undefined,
    timeoutMs: rt.config.timeoutMs,
    actionSet: 'legacy',
    goalProtocol: g09Protocol(entry),
  });

  let outcome: G09EpisodeRecord['outcome'] = 'completed';
  let failure: string | null = null;
  let playerEat: G09EpisodeRecord['playerEat'] = null;

  // Phase 1 — goal choice (one provider call, no world command).
  await game.advance();
  const session = game.sessionsOf()[0]?.session;
  const binding: GoalBinding | null = session?.goalBinding ?? null;
  if (binding === null) {
    outcome = mapFailure(session?.status);
    failure = `goal phase failed: ${session?.status ?? 'no session'}`;
  } else {
    if (requestState !== null) {
      const applied = decideGoalRequest({
        raw: binding.raw, round: binding.decidedRound, decidedAtSimTime: binding.decidedAtSimTime,
        request: requestState, episodeId: entry.episodeId,
      });
      if (applied.ok) requestState = applied.value.request;
    }
    // Phase 2 — the action, same session, same budget.
    await game.advance();
    const actionCalled = exchanges.some(exchange => exchange.stage === 'action');
    if (!actionCalled) {
      const after = game.sessionsOf()[0]?.session;
      outcome = mapFailure(after?.status);
      failure = `action phase failed: ${after?.status ?? 'no session'}`;
    } else {
      const eat = game.playerLine('player eat');
      playerEat = { ok: eat.ok, detail: eat.detail ?? null };
    }
  }

  const snapshot = game.snapshot();
  const fulfilment = binding === null ? null : checkGoalFulfilment(binding, { commands: snapshot.commands as never }, G09_NPC, G09_PLAYER);
  const goalExchange = exchanges.find(exchange => exchange.stage === 'goal');
  const actionExchange = exchanges.find(exchange => exchange.stage === 'action');
  const goalParse = binding === null ? { round: 1, raw: goalExchange?.raw ?? null, parseOk: false, error: goalExchange === undefined ? 'no response' : null } : { round: binding.decidedRound, raw: binding.raw, parseOk: true, error: null };
  const actionParse = actionExchange === undefined
    ? { round: null as number | null, raw: null as string | null, parseOk: false, type: null as string | null, error: 'no action call' }
    : (() => {
      const parsed = parseActionSafe(actionExchange.raw);
      return {
        round: 2 as number | null, raw: actionExchange.raw, parseOk: parsed.ok,
        type: parsed.ok ? parsed.type : null, error: parsed.ok ? null : parsed.error,
      };
    })();

  return {
    schema: G09_EPISODE_SCHEMA,
    episodeId: entry.episodeId,
    cell: entry.cell,
    satiety: entry.satiety,
    arm: entry.arm,
    outcome,
    request: requestState,
    binding,
    goal: goalParse,
    action: actionParse,
    fulfilment: fulfilment === null ? null : { verdict: fulfilment.verdict, evidence: fulfilment.evidence },
    playerEat,
    http: exchanges,
    attempts,
    tokens: {
      goal: goalExchange?.usage?.total_tokens ?? null,
      action: actionExchange?.usage?.total_tokens ?? null,
      total: null,
    },
    snapshot: {
      initialState: snapshot.initialState,
      commands: snapshot.commands,
      events: snapshot.events,
      finalState: snapshot.finalState,
    },
    failure,
  };
}

/** Deterministic responder: goal prompts get a goal, action prompts an action. */
function fakeResponder(args: Args): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? '');
    const isGoal = prompt.includes('allowedGoals:');
    const content = isGoal
      ? (prompt.includes('"yield_once"') ? JSON.stringify({ goal: args.fakeGoal }) : '{"goal":"feed_self"}')
      : args.fakeAction;
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function parseActionSafe(raw: string): { ok: boolean; type: string; error: string | null } {
  const parsed = parseAction(raw, 'legacy');
  return parsed.ok ? { ok: true, type: parsed.action.type, error: null } : { ok: false, type: '', error: parsed.error };
}

function mapFailure(status: string | undefined): G09EpisodeRecord['outcome'] {
  switch (status) {
    case 'budget_exhausted': return 'budget_exhausted';
    case 'timeout': return 'timeout';
    case 'provider_error': return 'provider_error';
    default: return 'invalid_run';
  }
}

async function run(args: Args): Promise<number> {
  if (args.batch === null) fail('--batch is required');
  const cfg = config(args);
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
    protocol: 'goal_choice -> action, one session, two phases, one budget',
    initialStates: Object.fromEntries(G09_CELLS.map(cell => [cell.cell, g09InitialState(cell.satiety)])),
  });

  const gate = new ChatBudgetGate(G09_HARD_CHAT_LIMIT);
  const rt: EpisodeRuntime = { store, gate, config: cfg, args };
  let stop = false;

  for (const entry of plan.plan) {
    if (stop) {
      store.writeJson(`episodes/${entry.episodeId}.json`, notRunRecord(entry));
      console.log(`NOT_RUN ${entry.episodeId}`);
      continue;
    }
    const record = await runEpisode(entry, rt);
    record.tokens.total = record.tokens.goal !== null && record.tokens.action !== null
      ? record.tokens.goal + record.tokens.action
      : null;
    store.writeJson(`episodes/${entry.episodeId}.json`, record);
    console.log(`${record.outcome.toUpperCase()} ${entry.episodeId} goal=${record.binding?.goal ?? '-'} verdict=${record.fulfilment?.verdict ?? '-'}`);
    if (record.outcome !== 'completed') {
      stop = true;
      continue;
    }
    // Structural gate after the first pair.
    if (entry.index === 2) {
      const prefix = verifyG09Prefix(store.dir);
      console.log(`structural gate ok=${prefix.evidenceOk}`);
      if (!prefix.evidenceOk) {
        console.log(prefix.issues.join('\n'));
        stop = true;
      }
    }
  }

  const batch = readG09Batch(store.dir);
  const derivation = deriveG09(batch, plan);
  const summary = projectG09Summary(args.batch, args.live ? 'live' : 'fake', cfg.requestModel, derivation);
  store.writeJson('summary.json', summary);
  store.writeJson('status/finished.json', {
    at: new Date().toISOString(), chatRequests: gate.spent, blocked: gate.blocked,
    planned: plan.plan.length,
  });

  const verify = verifyG09Batch(store.dir);
  const p = verify.derivation.protocol;
  console.log(`completed=${p.completed} failed=${p.failed} notRun=${p.notRun} chats=${verify.derivation.costs.chatRequests}/${G09_HARD_CHAT_LIMIT}`);
  console.log(`batch -> ${store.dir}`);
  console.log(`verify ${args.batch}: ok=${verify.ok}`);
  console.log(`  protocol complete=${verify.complete} evidenceOk=${verify.evidenceOk}`);
  console.log(`  goals=${JSON.stringify(verify.derivation.goals)}`);
  console.log(`  fulfilment=${JSON.stringify(verify.derivation.fulfilment)}`);
  console.log(`  costs goal=${verify.derivation.costs.goalTokens} action=${verify.derivation.costs.actionTokens} total=${verify.derivation.costs.totalTokens}`);
  for (const episode of verify.derivation.episodes) {
    console.log(`  ${episode.episodeId}: ${episode.outcome} goal=${episode.goal ?? '-'} request=${episode.request ?? '-'} verdict=${episode.verdict ?? '-'} goalTokens=${episode.goalTokens} actionTokens=${episode.actionTokens}`);
  }
  if (!verify.ok) {
    for (const issue of verify.issues) console.log(`  ! ${issue}`);
  }
  return verify.runSucceeded ? 0 : 1;
}

function notRunRecord(entry: G09PlanEntry): G09EpisodeRecord {
  return {
    schema: G09_EPISODE_SCHEMA,
    episodeId: entry.episodeId,
    cell: entry.cell,
    satiety: entry.satiety,
    arm: entry.arm,
    outcome: 'not_run',
    request: null,
    binding: null,
    goal: { round: 1, raw: null, parseOk: false, error: null },
    action: { round: null, raw: null, parseOk: false, type: null, error: null },
    fulfilment: null,
    playerEat: null,
    http: [],
    attempts: [],
    tokens: { goal: null, action: null, total: null },
    snapshot: { initialState: g09InitialState(entry.satiety), commands: [], events: [], finalState: g09InitialState(entry.satiety) },
    failure: 'not_run',
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) {
    if (args.batch === null) fail('--batch is required');
    const dir = resolve(args.out, args.batch);
    const verify = verifyG09Batch(dir);
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

main().then(code => process.exit(code)).catch(error => fail(error instanceof Error ? error.message : String(error)));
