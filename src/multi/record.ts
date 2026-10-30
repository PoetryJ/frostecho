/**
 * G03 workstream C — episode persistence and deterministic verification.
 * Layout (versioned, G03-owned; G02 artifacts untouched):
 *   artifacts/g03/<batch>/batch.json
 *   artifacts/g03/<batch>/episodes/<episodeId>/{game.json, meta.json, replay.json}
 *   artifacts/g03/<batch>/summary.json
 * Verification re-derives everything: sidecar equality, engine re-execution,
 * event replay, goal recomputation per actor, scenario re-judgement, the
 * command ledger, and parse re-checks. Never throws.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOAL_HUNGER_AT_LEAST, MAX_PROVIDER_CALLS } from '../agent/contracts';
import { parseAction } from '../agent/parser';
import { Engine, replay } from '../engine';
import type { LogEntry } from '../engine';
import { canonical } from '../util';
import type { WorldState } from '../types';
import type { MultiRecord } from './contracts';
import { G03_SCHEMA } from './contracts';
import { isMultiScenarioId, judgeMultiScenario, loadMultiScenario, type MultiScenarioId } from './scenarios';

export const MULTI_BATCH_SCHEMA = 'frostecho.g03.batch/1';
export const MULTI_SUMMARY_SCHEMA = 'frostecho.g03.summary/1';

export interface MultiEpisodeMeta {
  episodeId: string;
  scenarioId: MultiScenarioId | null;
  actorOrder: string[];
  mode: string;
  thinking: boolean | null;
  stopReason: string;
  scenarioPass: boolean | null;
  replayMatches: boolean;
  providerCalls: Record<string, number>;
  totalChatRequests: number;
  totalMs: number;
}

export interface MultiEpisodeVerification {
  ok: boolean;
  issues: string[];
  record: MultiRecord | null;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readJsonFile(path: string, name: string, issues: string[]): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    issues.push(`${name} unreadable: ${msg(err)}`);
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Total chat requests = turns whose step carries transport (CONTRACTS §4). */
export function countChatRequests(record: MultiRecord): number {
  return record.turns.filter(t => t.step?.transport !== undefined && t.step?.transport !== null).length;
}

export function chatRequestsByActor(record: MultiRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const turn of record.turns) {
    if (turn.step?.transport !== undefined && turn.step?.transport !== null) {
      out[turn.actorId] = (out[turn.actorId] ?? 0) + 1;
    }
  }
  return out;
}

export function writeMultiEpisode(batchDir: string, record: MultiRecord): void {
  const episodeDir = join(batchDir, 'episodes', record.episodeId);
  mkdirSync(episodeDir, { recursive: true });
  const meta: MultiEpisodeMeta = {
    episodeId: record.episodeId,
    scenarioId: record.scenarioId as MultiEpisodeMeta['scenarioId'],
    actorOrder: [...record.actorOrder],
    mode: record.mode,
    thinking: record.thinking,
    stopReason: record.stopReason,
    scenarioPass: record.scenarioPass,
    replayMatches: record.replayMatches,
    providerCalls: Object.fromEntries(Object.entries(record.actors).map(([id, a]) => [id, a.providerCalls])),
    totalChatRequests: countChatRequests(record),
    totalMs: record.timing.totalMs,
  };
  writeFileSync(join(episodeDir, 'game.json'), canonical(record) + '\n');
  writeFileSync(join(episodeDir, 'meta.json'), canonical(meta) + '\n');
  writeFileSync(join(episodeDir, 'replay.json'), canonical({ matches: record.replayMatches }) + '\n');
}

export function writeMultiBatchFile(batchDir: string, batch: Record<string, unknown>): void {
  writeFileSync(join(batchDir, 'batch.json'), canonical(batch) + '\n');
}

const EPISODE_REQUIRED = ['game.json', 'meta.json', 'replay.json'] as const;

/**
 * Deterministic per-episode evidence verification (H01 algorithm, G03 record).
 * Steps: required files → root shape checks (non-null object, non-array) →
 * sidecar equality → fresh Engine re-execution of every logged command →
 * event/state equality → replayMatches recompute → per-actor goal recompute →
 * scenario re-judgement → NPC commandId grammar → turn/command ledger →
 * parse re-check → budget ceiling.
 */
export function verifyMultiEpisode(episodeDir: string): MultiEpisodeVerification {
  const issues: string[] = [];
  for (const name of EPISODE_REQUIRED) {
    if (!existsSync(join(episodeDir, name))) issues.push(`${name} missing`);
  }
  if (issues.length > 0) return { ok: false, issues, record: null };
  const gameRaw = readJsonFile(join(episodeDir, 'game.json'), 'game.json', issues);
  if (!isPlainObject(gameRaw)) {
    issues.push('game.json root is not a non-null object');
    return { ok: false, issues, record: null };
  }
  const record = gameRaw as unknown as MultiRecord;
  const metaRaw = readJsonFile(join(episodeDir, 'meta.json'), 'meta.json', issues);
  const replayRaw = readJsonFile(join(episodeDir, 'replay.json'), 'replay.json', issues);
  if (!isPlainObject(metaRaw)) issues.push('meta.json root is not a non-null object');
  if (!isPlainObject(replayRaw)) issues.push('replay.json root is not a non-null object');
  if (record.schema !== G03_SCHEMA) issues.push(`unexpected schema ${String(record.schema)}`);

  // replay.json / meta.json cross-checks
  if (isPlainObject(replayRaw) && replayRaw.matches !== record.replayMatches) {
    issues.push('replay.json matches does not match game.json');
  }
  if (isPlainObject(metaRaw)) {
    const fields: readonly (readonly [string, unknown])[] = [
      ['episodeId', record.episodeId],
      ['scenarioId', record.scenarioId],
      ['mode', record.mode],
      ['thinking', record.thinking],
      ['stopReason', record.stopReason],
      ['scenarioPass', record.scenarioPass],
      ['replayMatches', record.replayMatches],
      ['totalChatRequests', countChatRequests(record)],
    ];
    for (const [field, expected] of fields) {
      if (metaRaw[field] !== (expected as unknown)) {
        issues.push(`meta.json ${field} does not match game.json`);
      }
    }
    if (canonical(metaRaw.actorOrder) !== canonical(record.actorOrder)) {
      issues.push('meta.json actorOrder does not match game.json');
    }
  }

  // fresh Engine re-execution of the world ledger
  let engine: Engine | null = null;
  try {
    engine = new Engine(record.initialState as WorldState);
  } catch (err) {
    issues.push(`engine rejected initialState: ${msg(err)}`);
  }
  if (engine !== null) {
    const entries: LogEntry[] = Array.isArray(record.commands) ? record.commands : [];
    for (const entry of entries) {
      const id = entry?.command?.commandId ?? '(no id)';
      try {
        const reexec = engine.submit(entry.command);
        if (canonical(reexec) !== canonical(entry.result)) {
          issues.push(`command ${id}: engine replay result mismatch`);
        }
      } catch (err) {
        issues.push(`command ${id}: engine submit threw: ${msg(err)}`);
        break;
      }
    }
    try {
      if (canonical(engine.getEvents()) !== canonical(record.events)) {
        issues.push('engine replay events do not match game.json');
      }
      if (canonical(engine.getState()) !== canonical(record.finalState)) {
        issues.push('engine replay state does not match game.json finalState');
      }
    } catch (err) {
      issues.push(`engine replay threw: ${msg(err)}`);
    }
  }

  // replayMatches recompute
  let recomputedReplay: boolean | null = null;
  try {
    recomputedReplay = canonical(replay(record.initialState as WorldState, Array.isArray(record.events) ? record.events : []))
      === canonical(record.finalState);
  } catch (err) {
    issues.push(`replay threw: ${msg(err)}`);
  }
  if (recomputedReplay !== null && recomputedReplay !== record.replayMatches) {
    issues.push('game.replayMatches contradicts recomputation');
  }

  // per-actor authoritative goal recompute
  for (const [actorId, summary] of Object.entries(record.actors ?? {})) {
    const hunger = (record.finalState as { npcs?: Record<string, { hunger?: unknown }> })?.npcs?.[actorId]?.hunger;
    if (typeof hunger !== 'number') {
      issues.push(`finalState.npcs.${actorId}.hunger is not a number`);
    } else if ((hunger >= GOAL_HUNGER_AT_LEAST) !== summary.goalReached) {
      issues.push(`actors.${actorId}.goalReached contradicts finalState`);
    }
  }

  // scenario re-judgement
  if (record.scenarioId !== null && isMultiScenarioId(record.scenarioId)) {
    const verified: MultiRecord = { ...record, replayMatches: recomputedReplay ?? record.replayMatches };
    const judged = judgeMultiScenario(record.scenarioId, verified);
    if (record.scenarioPass !== null && judged.pass !== record.scenarioPass) {
      issues.push(`scenarioPass contradicts re-judgement (recomputed=${String(judged.pass)}, saved=${String(record.scenarioPass)})`);
    }
  } else if (record.scenarioId !== null) {
    issues.push(`unknown scenarioId ${String(record.scenarioId)}`);
  }

  // NPC commandId grammar: episodeId + ':npc:' + actorId + ':' + round
  const ledger = new Map<string, LogEntry>();
  for (const entry of Array.isArray(record.commands) ? record.commands : []) {
    const id = entry?.command?.commandId;
    if (typeof id === 'string') {
      if (ledger.has(id)) issues.push(`duplicate commandId ${id}`);
      ledger.set(id, entry);
    }
  }
  for (const turn of Array.isArray(record.turns) ? record.turns : []) {
    const step = turn.step;
    if (!step || step.command === undefined || step.command === null) continue; // stop steps carry no command
    const cmd = step.command;
    const id = cmd.commandId;
    const expected = `${record.episodeId}:npc:${turn.actorId}:${String(step.round)}`;
    if (id !== expected) {
      issues.push(`turn ${String(turn.globalTurn)}: commandId ${String(id)} violates the ${record.episodeId}:npc:${turn.actorId}:round grammar`);
    }
    const found = ledger.get(id);
    if (found === undefined) {
      issues.push(`turn ${String(turn.globalTurn)}: command ${String(id)} missing from world ledger`);
    } else if (canonical(found.command) !== canonical(cmd)) {
      issues.push(`turn ${String(turn.globalTurn)}: command ${String(id)} differs from world ledger`);
    }
  }

  // parse re-check on every recorded raw model output
  for (const turn of Array.isArray(record.turns) ? record.turns : []) {
    const step = turn.step;
    if (!step || step.parse?.ok !== true || typeof step.raw !== 'string' || step.raw.length === 0) continue;
    const reparsed = parseAction(step.raw);
    if (!reparsed.ok) {
      issues.push(`turn ${String(turn.globalTurn)}: saved raw output no longer parses`);
      continue;
    }
    if (reparsed.action.type === 'stop') {
      if (step.command !== undefined) issues.push(`turn ${String(turn.globalTurn)}: stop step carries a command`);
    } else if (step.command === undefined) {
      issues.push(`turn ${String(turn.globalTurn)}: parsed ${reparsed.action.type} but no command recorded`);
    } else {
      const expected = reparsed.action.type === 'move'
        ? { type: 'move', payload: { to: reparsed.action.to } }
        : { type: 'eat', payload: {} };
      if (canonical({ type: step.command.type, payload: step.command.payload }) !== canonical(expected)) {
        issues.push(`turn ${String(turn.globalTurn)}: parsed action differs from recorded command`);
      }
    }
  }

  // budget ceiling: no actor may exceed MAX_PROVIDER_CALLS
  for (const [actorId, summary] of Object.entries(record.actors ?? {})) {
    if (summary.providerCalls > MAX_PROVIDER_CALLS) {
      issues.push(`actors.${actorId}.providerCalls ${summary.providerCalls} exceeds budget ${MAX_PROVIDER_CALLS}`);
    }
  }

  return { ok: issues.length === 0, issues, record };
}

export interface MultiCombinationRow {
  episodeId: string;
  scenarioId: MultiScenarioId;
  order: 'ac' | 'ca';
  thinking: boolean;
  planned: boolean;
  valid: boolean;
  pass: boolean;
  interrupted: boolean;
  notRun: boolean;
  issues: string[];
}

export interface MultiRebuiltSummary {
  ok: boolean;
  batchId: string | null;
  rows: MultiCombinationRow[];
  totals: {
    episodes: number;
    passed: number;
    behaviorFailed: number;
    interrupted: number;
    notRun: number;
    totalChatRequests: number;
    replayMismatches: number;
  };
  issues: string[];
}

/** Rebuild the batch summary from disk only (CONTRACTS: 汇总从磁盘重建). */
export function summarizeMultiBatchDir(batchDir: string): MultiRebuiltSummary {
  const issues: string[] = [];
  const rows: MultiCombinationRow[] = [];
  const totals = { episodes: 0, passed: 0, behaviorFailed: 0, interrupted: 0, notRun: 0, totalChatRequests: 0, replayMismatches: 0 };
  const batchRaw = readJsonFile(join(batchDir, 'batch.json'), 'batch.json', issues);
  if (!isPlainObject(batchRaw)) {
    issues.push('batch.json root is not a non-null object');
    return { ok: false, batchId: null, rows, totals, issues };
  }
  const plannedIds = Array.isArray(batchRaw.plannedEpisodes) ? batchRaw.plannedEpisodes.map(String) : [];
  const episodesDir = join(batchDir, 'episodes');
  const runIds = existsSync(episodesDir) ? readdirSync(episodesDir).filter(n => !n.startsWith('.')) : [];
  const seen = new Set<string>();
  for (const episodeId of runIds) {
    seen.add(episodeId);
    const verification = verifyMultiEpisode(join(episodesDir, episodeId));
    const record = verification.record;
    if (record === null) {
      rows.push({
        episodeId, scenarioId: 'm1', order: 'ac', thinking: false,
        planned: plannedIds.includes(episodeId), valid: false, pass: false,
        interrupted: false, notRun: false, issues: verification.issues,
      });
      continue;
    }
    issues.push(...verification.issues.map(i => `${episodeId}: ${i}`));
    const order = record.actorOrder[0] === 'npc_a' ? 'ac' : 'ca';
    const thinking = record.thinking === true;
    const interrupted = record.stopReason === 'interrupted';
    if (interrupted) totals.interrupted += 1;
    else if (record.scenarioPass === true) totals.passed += 1;
    else totals.behaviorFailed += 1;
    if (!record.replayMatches) totals.replayMismatches += 1;
    totals.totalChatRequests += countChatRequests(record);
    totals.episodes += 1;
    rows.push({
      episodeId,
      scenarioId: (record.scenarioId ?? 'm1') as MultiScenarioId,
      order,
      thinking,
      planned: plannedIds.includes(episodeId),
      valid: verification.ok,
      pass: record.scenarioPass === true,
      interrupted,
      notRun: false,
      issues: verification.issues,
    });
  }
  for (const id of plannedIds) {
    if (!seen.has(id)) {
      totals.notRun += 1;
      rows.push({
        episodeId: id, scenarioId: 'm1', order: 'ac', thinking: false,
        planned: true, valid: false, pass: false, interrupted: false, notRun: true,
        issues: ['episode directory missing'],
      });
    }
  }
  return { ok: issues.length === 0, batchId: typeof batchRaw.batchId === 'string' ? batchRaw.batchId : null, rows, totals, issues };
}

export function writeMultiSummary(batchDir: string, summary: Record<string, unknown>): void {
  writeFileSync(join(batchDir, 'summary.json'), canonical(summary) + '\n');
}

/** Convenience: canonical scenario reference steps for assertions. */
export function referenceSteps(id: MultiScenarioId): number {
  return loadMultiScenario(id).expectedReferenceSteps;
}
