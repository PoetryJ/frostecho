import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Provider, ProviderTransportError, createHttpProvider, createReferenceProvider, enableThinkingFromEnv,
  loadHttpConfigFromEnv,
} from '../agent';
import { saveGameRecord } from './game';
import { SCENARIO_IDS, ScenarioId, ScenarioJudgement, runScenario } from './scenarios';

export const G02_MAX_CALLS = 90;
export const G02_REPS = 3;

export interface ErrorCounts {
  transport: number;
  parse: number;
  decide: number;
  execute: number;
}

export interface G02GroupSummary {
  games: number;
  scenarioPass: number;
  passRate: number;
  goalReached: number;
  requestCount: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  errors: ErrorCounts;
}

export interface G02Summary {
  mode: 'fixture' | 'live';
  /** True only for a live run that uses the process HTTP stack. Injected fetch and fixture mode are false. */
  realModel: boolean;
  model: string | null;
  /** Production default. This batch does not change it. */
  thinkingDefault: true;
  batchId: string;
  gamesPlanned: number;
  gamesRun: number;
  maxProviderCalls: number;
  requestCount: number;
  callCapExceeded: boolean;
  serial: true;
  retries: 0;
  byScenario: Record<ScenarioId, { games: number; scenarioPass: number; passRate: number; goalReached: number }>;
  byThinking: { true: G02GroupSummary; false: G02GroupSummary };
  errors: ErrorCounts;
  notes: string[];
}

export interface G02EvalOptions {
  mode: 'fixture' | 'live';
  root: string;
  batchId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  providerFactory?: (ctx: { thinking: boolean; scenarioId: ScenarioId; rep: number }) => Provider;
  scenarios?: readonly ScenarioId[];
  reps?: number;
  thinkingValues?: readonly boolean[];
  maxCalls?: number;
  now?: () => number;
  timeoutMs?: number;
}

export interface G02EvalOutput {
  summary: G02Summary;
  exitCode: 0 | 1 | 2;
  batchDir: string | null;
}

function emptyErrors(): ErrorCounts {
  return { transport: 0, parse: 0, decide: 0, execute: 0 };
}

function emptyGroup(): G02GroupSummary {
  return {
    games: 0,
    scenarioPass: 0,
    passRate: 0,
    goalReached: 0,
    requestCount: 0,
    latencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    errors: emptyErrors(),
  };
}

function emptyScenarioMap(): G02Summary['byScenario'] {
  return {
    s1: { games: 0, scenarioPass: 0, passRate: 0, goalReached: 0 },
    s2: { games: 0, scenarioPass: 0, passRate: 0, goalReached: 0 },
    s3: { games: 0, scenarioPass: 0, passRate: 0, goalReached: 0 },
  };
}

function isTransport(stepError: string | undefined, parseError: string | undefined): boolean {
  if (parseError === 'timeout' || parseError === 'provider_error') return true;
  if (!stepError) return false;
  return stepError === 'timeout' || stepError === 'network error' || stepError === 'provider call cap' || /^http \d+$/.test(stepError);
}

function addStepErrors(bucket: ErrorCounts, judgement: ScenarioJudgement) {
  if (judgement.record.outcome === 'budget_exhausted') bucket.decide += 1;
  for (const step of judgement.record.steps) {
    const parseError = step.parse.ok ? undefined : step.parse.error;
    if (isTransport(step.error, parseError)) bucket.transport += 1;
    else if (!step.parse.ok) bucket.parse += 1;
    if (step.exec?.status === 'rejected') bucket.execute += 1;
  }
}

function addTokens(group: G02GroupSummary, judgement: ScenarioJudgement) {
  group.requestCount += judgement.record.providerCalls;
  let stepLatency = 0;
  let sawTransport = false;
  for (const step of judgement.record.steps) {
    const usage = step.transport?.usage;
    if (usage) {
      group.promptTokens += usage.prompt_tokens ?? 0;
      group.completionTokens += usage.completion_tokens ?? 0;
      group.totalTokens += usage.total_tokens ?? 0;
    }
    if (step.transport) {
      sawTransport = true;
      stepLatency += step.transport.latencyMs;
    }
  }
  if (sawTransport) group.latencyMs += stepLatency;
  else group.latencyMs += judgement.record.timing.calls.reduce((sum, call) => sum + call.ms, 0);
}

function rates(group: { games: number; scenarioPass: number; passRate: number }) {
  group.passRate = group.games === 0 ? 0 : group.scenarioPass / group.games;
}

export function allocateG02BatchId(mode: 'fixture' | 'live', now: () => number = Date.now): string {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${mode}-${stamp}-${suffix}`;
}

function capProvider(inner: Provider, budget: { calls: number; max: number; exceeded: boolean }): Provider {
  return {
    decide(input, signal) {
      if (budget.calls >= budget.max) {
        budget.exceeded = true;
        return Promise.reject(new ProviderTransportError('provider call cap'));
      }
      budget.calls += 1;
      return Promise.resolve(inner.decide(input, signal));
    },
    consumeTransport() {
      return inner.consumeTransport?.() ?? null;
    },
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * 3 scenarios × reps × thinking on/off. Requests are serial. No implicit retry.
 * The call cap defaults to 90. Fixture mode does not contact a model.
 */
export async function runG02Eval(options: G02EvalOptions): Promise<G02EvalOutput> {
  const env = options.env ?? process.env;
  const scenarios = options.scenarios ?? SCENARIO_IDS;
  const reps = options.reps ?? G02_REPS;
  const thinkingValues = options.thinkingValues ?? [true, false];
  const maxCalls = options.maxCalls ?? G02_MAX_CALLS;
  const config = options.mode === 'live' ? loadHttpConfigFromEnv(env) : null;
  if (options.mode === 'live' && !config && !options.providerFactory) {
    const missing = ['FROSTECHO_LLM_URL', 'FROSTECHO_LLM_MODEL'].filter(name => !env[name]?.trim());
    return {
      summary: {
        mode: 'live',
        realModel: false,
        model: null,
        thinkingDefault: true,
        batchId: '',
        gamesPlanned: scenarios.length * reps * thinkingValues.length,
        gamesRun: 0,
        maxProviderCalls: maxCalls,
        requestCount: 0,
        callCapExceeded: false,
        serial: true,
        retries: 0,
        byScenario: emptyScenarioMap(),
        byThinking: { true: emptyGroup(), false: emptyGroup() },
        errors: emptyErrors(),
        notes: [`missing required live config: ${missing.join(', ')}`],
      },
      exitCode: 2,
      batchDir: null,
    };
  }

  const batchId = options.batchId ?? allocateG02BatchId(options.mode, options.now);
  const batchDir = join(options.root, batchId);
  mkdirSync(join(batchDir, 'games'), { recursive: true });
  const budget = { calls: 0, max: maxCalls, exceeded: false };
  const judgements: ScenarioJudgement[] = [];
  const factory = options.providerFactory ?? ((ctx: { thinking: boolean }) => {
    if (options.mode === 'fixture' || !config) return createReferenceProvider();
    return createHttpProvider({
      ...config,
      enableThinking: ctx.thinking,
      fetchImpl: options.fetchImpl,
    });
  });

  let stopped = false;
  for (const thinking of thinkingValues) {
    if (stopped) break;
    for (const scenarioId of scenarios) {
      if (stopped) break;
      for (let rep = 1; rep <= reps; rep++) {
        if (budget.calls >= budget.max) {
          budget.exceeded = true;
          stopped = true;
          break;
        }
        const gameId = `${scenarioId}-thinking-${thinking ? 'on' : 'off'}-rep-${rep}`;
        try {
          const judgement = await runScenario({
            scenarioId,
            provider: capProvider(factory({ thinking, scenarioId, rep }), budget),
            batchId: gameId,
            thinking,
            mode: options.mode === 'live' && config ? 'live' : 'fixture',
            timeoutMs: options.timeoutMs,
            now: options.now,
          });
          judgements.push(judgement);
          saveGameRecord(join(batchDir, 'games'), judgement.record);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'scenario failed';
          const failed = {
            scenarioId,
            thinking,
            rep,
            scenarioPass: false,
            goalReached: false,
            error: message,
          };
          mkdirSync(join(batchDir, 'games', gameId), { recursive: true });
          writeJson(join(batchDir, 'games', gameId, 'error.json'), failed);
          budget.exceeded = budget.exceeded || message === 'provider call cap';
        }
      }
    }
  }

  const byScenario = emptyScenarioMap();
  const byThinking = { true: emptyGroup(), false: emptyGroup() };
  const errors = emptyErrors();
  for (const judgement of judgements) {
    const scenario = byScenario[judgement.scenarioId];
    scenario.games += 1;
    if (judgement.scenarioPass) scenario.scenarioPass += 1;
    if (judgement.goalReached) scenario.goalReached += 1;
    const key = judgement.record.thinking ? 'true' : 'false';
    const group = byThinking[key];
    group.games += 1;
    if (judgement.scenarioPass) group.scenarioPass += 1;
    if (judgement.goalReached) group.goalReached += 1;
    addTokens(group, judgement);
    addStepErrors(group.errors, judgement);
    addStepErrors(errors, judgement);
  }
  for (const scenario of Object.values(byScenario)) rates(scenario);
  rates(byThinking.true);
  rates(byThinking.false);

  const gamesPlanned = scenarios.length * reps * thinkingValues.length;
  const realModel = options.mode === 'live' && !!config && !options.fetchImpl && !options.providerFactory;
  const failedGame = judgements.some(item => !item.scenarioPass) || judgements.length !== gamesPlanned || budget.exceeded;
  const summary: G02Summary = {
    mode: options.mode,
    realModel,
    model: config?.model ?? null,
    thinkingDefault: true,
    batchId,
    gamesPlanned,
    gamesRun: judgements.length,
    maxProviderCalls: maxCalls,
    requestCount: budget.calls,
    callCapExceeded: budget.exceeded,
    serial: true,
    retries: 0,
    byScenario,
    byThinking,
    errors,
    notes: [
      'Production default enable_thinking remains true. This batch compares true and false and does not switch the default.',
      options.mode === 'fixture'
        ? 'mode=fixture uses the reference policy in process. It is not a real-model result.'
        : 'mode=live sends one HTTP chat completion at a time. Failures are not retried.',
      'scenarioPass is separate from goalReached. S2 and S3 pass when A stops with hunger still 40. stop is never goalReached.',
      'An execute rejection such as S3 NO_FOOD is counted here and can still be a scenario pass.',
      `thinking env default at process start: ${enableThinkingFromEnv(env)}`,
    ],
  };
  writeJson(join(batchDir, 'summary.json'), summary);
  return { summary, exitCode: failedGame ? 1 : 0, batchDir };
}
