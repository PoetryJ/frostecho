/**
 * G05-R1 workstream C — episode persistence and independent verification.
 *
 * Verification never trusts saved booleans: it re-executes the command/event
 * ledger (base G04 verifier), replays the world to every checkpoint cursor and
 * recomputes satiety/simTime/food/call counts from turns, then re-judges the
 * frozen expectations. A record whose saved scenarioPass disagrees with the
 * recomputed verdict fails.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { G05_BATCH_SCHEMA, G05_SCHEMA } from '../reactive/contracts';
import { verifyReactiveEpisode, writeReactiveEpisode } from '../reactive/record';
import { replay } from '../engine';
import { readAttemptLedger } from './batch-store';
import { sumAttempts } from './metrics';
import type { G05ScenarioRecord, G05Checkpoint } from './scenarios';

export function saveNeedsEpisode(artifactsRoot: string, batch: string, record: G05ScenarioRecord): string {
  // Same layout as G04: <root>/<batch>/episodes/<episodeId>/{meta,game}.json
  return writeReactiveEpisode(artifactsRoot, batch, record);
}

/** Recompute every checkpoint from the raw event/turn ledgers. */
export function verifyNeedsSemantics(record: G05ScenarioRecord): string[] {
  const issues: string[] = [];
  if (record.schema !== G05_SCHEMA) {
    issues.push(`schema ${String(record.schema)} != ${G05_SCHEMA} (out-of-contract /1 records are not re-judged)`);
    return issues;
  }
  if (record.matrixVersion !== 'g05-r1-t123') issues.push(`matrixVersion ${String(record.matrixVersion)} != g05-r1-t123`);
  if (record.rules?.LOW !== 40 || record.rules?.GOAL !== 70 || record.rules?.DECAY_PER_STEP !== 10) {
    issues.push('frozen rule triple is not LOW=40 GOAL=70 DECAY=10');
  }
  const events = Array.isArray(record.events) ? record.events : [];
  const turns = Object.values(record.cycles ?? {}).flatMap(list => list.flatMap(cycle => cycle.turns));

  // The matrix fixes the initial state: A/C/B kitchen 70, simTime 0, dorm 0.
  const init = record.initialState;
  if ((init.simTime ?? 0) !== 0) issues.push('initial simTime != 0');
  for (const id of ['npc_a', 'npc_b', 'npc_c']) {
    if (init.npcs[id]?.hunger !== 70 || init.npcs[id]?.location !== 'kitchen') {
      issues.push(`initial ${id} is not kitchen/70`);
    }
  }
  if (init.food.dorm !== 0) issues.push('initial dorm food != 0');

  let pass = true;
  // WORKER-C live judging: a model trajectory may legally spend fewer/more
  // decisions than the reference where the reference spent some; checkpoints
  // that must be zero-call stay strictly zero in every mode.
  const liveLooseCalls = record.mode === 'live';
  for (const cp of record.checkpoints ?? []) {
    issues.push(...verifyCheckpoint(record, cp, events, turns));
    for (const [key, value] of Object.entries(cp.expected)) {
      if (liveLooseCalls && key === 'calls' && value > 0) continue;
      if (cp.actual[key as keyof typeof cp.actual] !== value) pass = false;
    }
  }
  if (record.restCycles) {
    for (const [id, before] of Object.entries(record.restCycles.before)) {
      if (record.restCycles.after[id] !== before) {
        pass = false;
        issues.push(`rest100.${id}: cycle count changed during the 100 pumps`);
      }
    }
  }
  // T3 recurring: both actors must have waited on the empty kitchen.
  if (record.scenarioId.endsWith('/t3/recurring')) {
    const waited = new Set(
      (record.transitions ?? [])
        .filter(t => t.to === 'waiting')
        .map(t => t.actorId),
    );
    for (const id of record.actorOrder) {
      if (!waited.has(id)) { pass = false; issues.push(`t3 recurring: ${id} never waited on the empty kitchen`); }
    }
  }
  if (record.scenarioPass !== pass) {
    issues.push(`saved scenarioPass ${String(record.scenarioPass)} != recomputed ${pass}`);
  }
  return issues;
}

function verifyCheckpoint(
  record: G05ScenarioRecord,
  cp: G05Checkpoint,
  events: G05ScenarioRecord['events'],
  turns: { providerCalled: boolean; logCursorAfter: number }[],
): string[] {
  const issues: string[] = [];
  if (!Number.isInteger(cp.logCursor) || cp.logCursor < 0 || cp.logCursor > events.length) {
    return [`checkpoint ${cp.label}: bad logCursor ${String(cp.logCursor)}`];
  }
  const state = replay(record.initialState, events.slice(0, cp.logCursor));
  const expectedActual = {
    simTime: state.simTime ?? 0,
    a: state.npcs.npc_a?.hunger,
    b: state.npcs.npc_b?.hunger,
    c: state.npcs.npc_c?.hunger,
    food: state.food.kitchen,
    calls: turns.filter(t => t.providerCalled && t.logCursorAfter <= cp.commandCursor).length,
  };
  for (const [key, value] of Object.entries(expectedActual)) {
    if (cp.actual[key as keyof typeof cp.actual] !== value) {
      issues.push(`checkpoint ${cp.label}.${key}: saved ${String(cp.actual[key as keyof typeof cp.actual])} != replayed ${String(value)}`);
    }
  }
  return issues;
}

export interface NeedsVerifyResult {
  ok: boolean;
  issues: string[];
  episodes: number;
  httpCalls: number;
  /** Present when the batch carries a live plan: ledger cross-checks. */
  costs?: {
    httpAttempts: number;
    unresolvedAttempts: number;
    budgetBlocked: number;
    knownTokenSum: number;
    usageUnknownCount: number;
    totalTokens: number | null;
  };
}

interface NeedsBatchFile {
  schema: string;
  episodes: string[];
  notRun?: string[];
}

interface NeedsSummaryFile {
  totals: {
    episodes: number;
    httpCalls: number;
    scenarioPass: number;
    httpAttempts?: number;
    unresolvedAttempts?: number;
    budgetBlocked?: number;
    knownTokenSum?: number;
    usageUnknownCount?: number;
    totalTokens?: number | null;
  };
}

export function verifyNeedsBatch(batchDir: string): NeedsVerifyResult {
  const issues: string[] = [];
  const batch = JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8')) as NeedsBatchFile;
  if (batch.schema !== G05_BATCH_SCHEMA) issues.push(`batch schema ${batch.schema} != ${G05_BATCH_SCHEMA}`);
  const summary = JSON.parse(readFileSync(join(batchDir, 'summary.json'), 'utf8')) as NeedsSummaryFile;

  let httpCalls = 0;
  let scenarioPass = 0;
  const episodesDir = join(batchDir, 'episodes');
  const present = new Set(readdirSync(episodesDir));
  for (const episodeId of batch.episodes) {
    if (!present.has(episodeId)) { issues.push(`missing episode dir ${episodeId}`); continue; }
    const base = verifyReactiveEpisode(join(episodesDir, episodeId));
    issues.push(...base.issues.map(i => `${episodeId}: ${i}`));
    if (base.record === null) continue;
    const record = base.record as G05ScenarioRecord;
    issues.push(...verifyNeedsSemantics(record).map(i => `${episodeId}: ${i}`));
    // HTTP calls come from actual transport records, never from the mode flag.
    httpCalls += Object.values(record.cycles).flatMap(list => list.flatMap(c => c.turns))
      .filter(t => t.step?.transport !== undefined && t.step?.transport !== null).length;
    if (record.scenarioPass === true) scenarioPass += 1;
  }
  // Summary is rebuilt from disk; any disagreement is an issue.
  if (summary.totals.episodes !== batch.episodes.length) issues.push('summary episodes mismatch');
  if (summary.totals.httpCalls !== httpCalls) issues.push(`summary httpCalls ${summary.totals.httpCalls} != ${httpCalls}`);
  if (summary.totals.scenarioPass !== scenarioPass) issues.push(`summary scenarioPass ${summary.totals.scenarioPass} != ${scenarioPass}`);
  // G05-live batches: cross-check the durable attempt ledger. Requests counted
  // from transports must equal finished attempts; unresolved begins (crash
  // during a request) and local denials are reported, never silently dropped.
  let costs: NeedsVerifyResult['costs'];
  if (existsSync(join(batchDir, 'plan.json'))) {
    const ledger = readAttemptLedger(batchDir);
    const summed = sumAttempts(ledger);
    costs = {
      httpAttempts: summed.httpAttempts,
      unresolvedAttempts: summed.unresolvedAttempts,
      budgetBlocked: summed.budgetBlocked,
      knownTokenSum: summed.knownTokenSum,
      usageUnknownCount: summed.usageUnknownCount,
      totalTokens: summed.totalTokens,
    };
    if (summed.httpAttempts !== httpCalls) {
      issues.push(`attempt ledger has ${summed.httpAttempts} finished requests != ${httpCalls} recorded transports`);
    }
    if (summary.totals.httpAttempts !== undefined && summary.totals.httpAttempts !== summed.httpAttempts) {
      issues.push(`summary httpAttempts ${String(summary.totals.httpAttempts)} != ledger ${summed.httpAttempts}`);
    }
    if (summary.totals.budgetBlocked !== undefined && summary.totals.budgetBlocked !== summed.budgetBlocked) {
      issues.push(`summary budgetBlocked ${String(summary.totals.budgetBlocked)} != ledger ${summed.budgetBlocked}`);
    }
    if (summary.totals.knownTokenSum !== undefined && summary.totals.knownTokenSum !== summed.knownTokenSum) {
      issues.push(`summary knownTokenSum ${String(summary.totals.knownTokenSum)} != ledger ${summed.knownTokenSum}`);
    }
    if (summary.totals.usageUnknownCount !== undefined && summary.totals.usageUnknownCount !== summed.usageUnknownCount) {
      issues.push(`summary usageUnknownCount ${String(summary.totals.usageUnknownCount)} != ledger ${summed.usageUnknownCount}`);
    }
    if (summed.unresolvedAttempts > 0) {
      issues.push(`${summed.unresolvedAttempts} attempt(s) began without a finish (unresolved; slot conservatively spent)`);
    }
  }
  return { ok: issues.length === 0, issues, episodes: batch.episodes.length, httpCalls, ...(costs !== undefined ? { costs } : {}) };
}
