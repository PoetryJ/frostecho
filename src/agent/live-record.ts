import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replay } from '../engine';
import { canonical } from '../util';
import { MAX_PROVIDER_CALLS, RunResult, StepRecord } from './contracts';
import { HTTP_SAMPLING } from './providers/http';
import type { WorldState } from '../types';

export const LIVE_RUN_COUNT = 3;
export const DEFAULT_LIVE_ARTIFACT_DIR = 'artifacts/g01-live';

export function liveArtifactDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.FROSTECHO_LIVE_ARTIFACT_DIR?.trim();
  return custom && custom.length > 0 ? custom : DEFAULT_LIVE_ARTIFACT_DIR;
}

/** Optional override. Missing or invalid values keep the runner default. Not a required live config. */
export function liveTimeoutMs(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.FROSTECHO_LIVE_TIMEOUT_MS?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function replayMatches(result: Pick<RunResult, 'initialState' | 'events' | 'finalState'>): boolean {
  return canonical(replay(result.initialState, result.events)) === canonical(result.finalState);
}

export interface LiveRunMeta {
  model: string;
  apiKeyPresent: boolean;
  timeoutMs: number;
  /** Exact strings to strip from every written record. Never written themselves. */
  secrets: string[];
}

export interface LiveSummaryRun {
  name: string;
  runId: string;
  actorId: string;
  outcome: string;
  goalReached: boolean;
  replayMatches: boolean;
  providerCalls: number;
  error: string | null;
  stepCount: number;
  raw: string[];
  commands: (string | null)[];
  stepErrors: (string | null)[];
  model: string;
  apiKey: 'present' | 'absent';
  sampling: {
    temperature: number;
    max_tokens: number;
    stream: boolean;
    chat_template_kwargs: { enable_thinking: boolean };
  };
  timing: RunResult['timing'];
  requestStats: { providerCalls: number; maxDecisions: number; timeoutMs: number; retries: number };
  finalHunger: number | null;
}

export interface LiveSummary {
  runs: LiveSummaryRun[];
  successCount: number;
  requestCount: number;
  allGoalReached: boolean;
  allReplayMatch: boolean;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((out, secret) => (secret ? out.split(secret).join('[redacted]') : out), value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = redact((value as Record<string, unknown>)[key], secrets);
    return out;
  }
  return value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function samplingRecord() {
  return {
    temperature: HTTP_SAMPLING.temperature,
    max_tokens: HTTP_SAMPLING.max_tokens,
    stream: HTTP_SAMPLING.stream,
    chat_template_kwargs: { enable_thinking: HTTP_SAMPLING.chat_template_kwargs.enable_thinking },
  };
}

/** One live run directory. Failed runs use the same files. Secrets are stripped before write. */
export function writeLiveRun(root: string, index: number, result: RunResult, meta: LiveRunMeta): void {
  const dir = join(root, `run-${index}`);
  mkdirSync(dir, { recursive: true });
  const secrets = meta.secrets.filter(secret => secret.length > 0);
  const dump = (name: string, value: unknown) => writeJson(join(dir, name), redact(value, secrets));
  dump('initial-state.json', result.initialState);
  dump('steps.json', result.steps);
  dump('events.json', result.events);
  dump('final-state.json', result.finalState);
  dump('replay.json', { matches: replayMatches(result) });
  dump('meta.json', {
    runId: result.runId,
    actorId: result.actorId,
    outcome: result.outcome,
    goalReached: result.goalReached,
    providerCalls: result.providerCalls,
    error: result.error ?? null,
    model: meta.model,
    apiKey: meta.apiKeyPresent ? 'present' : 'absent',
    sampling: samplingRecord(),
    timing: result.timing,
    requestStats: {
      providerCalls: result.providerCalls,
      maxDecisions: MAX_PROVIDER_CALLS,
      timeoutMs: meta.timeoutMs,
      retries: 0,
    },
  });
}

function hungerOf(state: WorldState): number | null {
  const npc = state.npcs?.npc_a;
  return npc && typeof npc.hunger === 'number' ? npc.hunger : null;
}

function readJson(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), 'utf8'));
}

/**
 * Summary is read back from the run directories. It does not take the in-memory results.
 * replayMatches is the record's flag AND a fresh replay of the saved initial state and events.
 */
export function summarizeLiveDir(root: string): LiveSummary {
  const names = readdirSync(root)
    .filter(name => /^run-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  const runs: LiveSummaryRun[] = names.map(name => {
    const dir = join(root, name);
    const steps = readJson(dir, 'steps.json') as StepRecord[];
    const meta = readJson(dir, 'meta.json') as Omit<LiveSummaryRun, 'name' | 'stepCount' | 'raw' | 'commands' | 'stepErrors' | 'finalHunger' | 'replayMatches'> & {
      sampling: LiveSummaryRun['sampling'];
      timing: LiveSummaryRun['timing'];
      requestStats: LiveSummaryRun['requestStats'];
    };
    const recorded = readJson(dir, 'replay.json') as { matches?: boolean };
    const initial = readJson(dir, 'initial-state.json') as WorldState;
    const events = readJson(dir, 'events.json') as RunResult['events'];
    const finalState = readJson(dir, 'final-state.json') as WorldState;
    const actual = canonical(replay(initial, events)) === canonical(finalState);
    return {
      name,
      runId: meta.runId,
      actorId: meta.actorId,
      outcome: meta.outcome,
      goalReached: meta.goalReached,
      replayMatches: recorded.matches === true && actual,
      providerCalls: meta.providerCalls,
      error: meta.error,
      stepCount: steps.length,
      raw: steps.map(step => step.raw),
      commands: steps.map(step => step.command?.type ?? null),
      stepErrors: steps.map(step => step.error ?? null),
      model: meta.model,
      apiKey: meta.apiKey,
      sampling: meta.sampling,
      timing: meta.timing,
      requestStats: meta.requestStats,
      finalHunger: hungerOf(finalState),
    };
  });
  const summary: LiveSummary = {
    runs,
    successCount: runs.filter(run => run.goalReached && run.replayMatches).length,
    requestCount: runs.reduce((sum, run) => sum + (typeof run.providerCalls === 'number' ? run.providerCalls : 0), 0),
    allGoalReached: runs.length > 0 && runs.every(run => run.goalReached),
    allReplayMatch: runs.length > 0 && runs.every(run => run.replayMatches),
  };
  writeJson(join(root, 'summary.json'), summary);
  return summary;
}

/** Exit 0 only when every expected run reached the goal and replayed. Empty or partial sessions are 1. */
export function liveExitCode(summary: LiveSummary, expectedRuns = LIVE_RUN_COUNT): 0 | 1 {
  if (summary.runs.length !== expectedRuns) return 1;
  if (!summary.runs.every(run => run.goalReached && run.replayMatches)) return 1;
  return 0;
}
