/**
 * G05 workstream C — persistence and verification for needs episodes.
 *
 * Layout mirrors the G04 batch layout: <batch>/<episode>/game.json (the saved
 * ReactiveRecord) plus <batch>/batch.json and <batch>/summary.json. The
 * verifier re-uses verifyReactiveEpisode and adds the G05 invariants: the need
 * ledger agrees with the cycles, need cycles are exempt from the generic
 * episode budget but bounded by NEED_DECISION_BUDGET, and metabolism lines up
 * with the TimeAdvanced ledger.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  G05_BATCH_SCHEMA, G05_SCHEMA, NEED_DECISION_BUDGET, NEED_HUNGER_AT_LEAST, NEED_PERIOD_MIN,
  type ReactiveRecord,
} from '../reactive/contracts';
import { RULES } from '../types';
import { verifyReactiveEpisode, writeReactiveEpisode } from '../reactive/record';

export interface NeedsBatchFile {
  schema: typeof G05_BATCH_SCHEMA;
  batchId: string;
  createdAt: string;
  mode: 'reference' | 'fixture' | 'live';
  episodes: string[]; // episode directories in run order
}

export interface NeedsSummaryFile {
  schema: 'frostecho.g05.summary/1';
  batchId: string;
  mode: 'reference' | 'fixture' | 'live';
  totals: {
    episodes: number;
    scenarioPass: number;
    httpCalls: number;
    referenceDecisions: number;
    interrupted: number;
    needsGranted: number;
    needsSatisfied: number;
    needsExpired: number;
    simMinutes: number;
  };
  perEpisode: {
    id: string;
    totalCalls: number;
    httpCalls: number;
    interrupted: boolean;
    scenarioPass: boolean;
    simTime: number;
    needs: { granted: number; satisfied: number; expired: number; stopped: number; pending: number };
  }[];
}

export function saveNeedsEpisode(artifactsRoot: string, batch: string, record: ReactiveRecord): string {
  // Same layout as G04: <root>/<batch>/episodes/<episodeId>/{meta,game}.json
  return writeReactiveEpisode(artifactsRoot, batch, record);
}

export function saveNeedsBatch(batchDir: string, batch: NeedsBatchFile, summary: NeedsSummaryFile): void {
  writeFileSync(join(batchDir, 'batch.json'), `${JSON.stringify(batch, null, 2)}\n`);
  writeFileSync(join(batchDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

export interface NeedsVerifyResult {
  ok: boolean;
  issues: string[];
  episodes: number;
  httpCalls: number;
}

export function verifyNeedsBatch(batchDir: string): NeedsVerifyResult {
  const issues: string[] = [];
  const batch = JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8')) as NeedsBatchFile;
  if (batch.schema !== G05_BATCH_SCHEMA) issues.push(`batch schema ${batch.schema} != ${G05_BATCH_SCHEMA}`);
  const summary = JSON.parse(readFileSync(join(batchDir, 'summary.json'), 'utf8')) as NeedsSummaryFile;

  let httpCalls = 0;
  const episodesDir = join(batchDir, 'episodes');
  const present = new Set(readdirSync(episodesDir));
  for (const episodeId of batch.episodes) {
    if (!present.has(episodeId)) { issues.push(`missing episode dir ${episodeId}`); continue; }
    const base = verifyReactiveEpisode(join(episodesDir, episodeId));
    issues.push(...base.issues.map(i => `${episodeId}: ${i}`));
    if (base.record === null) continue;
    issues.push(...verifyNeedsSemantics(base.record).map(i => `${episodeId}: ${i}`));
    httpCalls += base.record.mode === 'live' ? Object.values(base.record.actors).reduce((s, a) => s + a.providerCalls, 0) : 0;
  }
  if (summary.totals.episodes !== batch.episodes.length) issues.push('summary episodes mismatch');
  if (summary.totals.httpCalls !== httpCalls) issues.push(`summary httpCalls ${summary.totals.httpCalls} != ${httpCalls}`);
  return { ok: issues.length === 0, issues, episodes: batch.episodes.length, httpCalls };
}

/** G05 semantics on top of the G04 record verification. */
export function verifyNeedsSemantics(record: ReactiveRecord): string[] {
  const issues: string[] = [];
  if (record.schema !== G05_SCHEMA) { issues.push(`schema ${record.schema} != ${G05_SCHEMA}`); return issues; }
  const needs = record.needs ?? [];
  if (record.needPolicy === undefined) issues.push('needPolicy missing');

  // Need cycles are visible as cycles whose reason starts with 'need cycle'.
  for (const [actorId, cycles] of Object.entries(record.cycles)) {
    let autoCalls = 0;
    let needCalls = 0;
    for (const cycle of cycles) {
      const calls = cycle.turns.filter(t => t.providerCalled).length;
      if ((cycle.reason ?? '').startsWith('need cycle')) needCalls += calls; else autoCalls += calls;
    }
    if (autoCalls > 10) issues.push(`${actorId}: autonomous calls ${autoCalls} exceed the episode budget`);
    // Every need cycle must belong to a granted need of this actor.
    if (needCalls > 0 && !needs.some(n => n.actorId === actorId)) {
      issues.push(`${actorId}: need cycles without a granted need`);
    }
  }

  for (const cycles of Object.values(record.cycles)) {
    for (const cycle of cycles) {
      const reason = cycle.reason ?? '';
      if (!reason.startsWith('need cycle')) continue;
      const m = /period (\d+)/.exec(reason);
      if (m === null) { issues.push(`unparsable need cycle reason: ${reason}`); continue; }
    }
  }

  for (const need of needs) {
    if (need.decisionsUsed > NEED_DECISION_BUDGET) {
      issues.push(`${need.actorId} period ${need.period}: decisionsUsed ${need.decisionsUsed} > ${NEED_DECISION_BUDGET}`);
    }
    if (need.period < 1 || !Number.isInteger(need.period)) issues.push(`bad period ${need.period}`);
    if (need.atSimTime !== need.period * NEED_PERIOD_MIN) {
      issues.push(`${need.actorId}: atSimTime ${need.atSimTime} != ${need.period}×${NEED_PERIOD_MIN}`);
    }
    if (need.outcome === 'pending') {
      // Pending is only acceptable when the episode was interrupted for other reasons.
      if (record.stopReason !== 'interrupted') issues.push(`${need.actorId}: pending need in a ${record.stopReason} episode`);
    }
  }

  // Period budget: at most one grant per actor per period.
  const seen = new Set<string>();
  for (const need of needs) {
    const key = `${need.actorId}:${need.period}`;
    if (seen.has(key)) issues.push(`duplicate grant ${key}`);
    seen.add(key);
  }

  // Metabolism ledger: TimeAdvanced events must reconstruct simTime, and each
  // HungerChanged must move +1 per crossed boundary per NPC (clamped).
  const timeEvents = record.events.filter(e => e.type === 'TimeAdvanced') as { before: number; after: number }[];
  let simTime = record.initialState.simTime ?? 0;
  const hunger = { ...Object.fromEntries(Object.entries(record.initialState.npcs).map(([id, npc]) => [id, npc.hunger])) } as Record<string, number>;
  for (const event of timeEvents) {
    if (event.before !== simTime) { issues.push(`TimeAdvanced before ${event.before} != running ${simTime}`); break; }
    const crossed = Math.floor(event.after / RULES.METABOLISM_INTERVAL_MIN) - Math.floor(event.before / RULES.METABOLISM_INTERVAL_MIN);
    for (const npcId of Object.keys(hunger)) {
      hunger[npcId] = Math.min(RULES.HUNGER_MAX, hunger[npcId] + crossed);
    }
    simTime = event.after;
  }
  if ((record.finalState.simTime ?? 0) !== simTime) issues.push(`final simTime ${record.finalState.simTime} != replayed ${simTime}`);
  for (const [npcId, value] of Object.entries(hunger)) {
    // Eating (and only eating) can add on top of metabolic hunger; stops/moves cannot.
    if ((record.finalState.npcs[npcId]?.hunger ?? value) < value) {
      issues.push(`${npcId}: final hunger below the metabolic floor ${value}`);
    }
  }

  // One-shot grants at most a single need across the whole episode.
  if (record.needPolicy === 'one-shot') {
    const grantedActors = needs.map(n => n.actorId);
    if (needs.length > 2) issues.push(`one-shot granted ${needs.length} needs`);
    for (const actorId of new Set(grantedActors)) {
      const own = needs.filter(n => n.actorId === actorId);
      if (own.length > 1) issues.push(`one-shot granted ${own.length} needs to ${actorId}`);
    }
  }

  // Need eligibility: hunger at the granting boundary must be at/above the
  // gate. Metabolic replay from the initial state gives the exact floor (eats
  // only raise it, so a grant below the floor is provably illegal).
  for (const need of needs) {
    let simTime = record.initialState.simTime ?? 0;
    let hunger = record.initialState.npcs[need.actorId]?.hunger ?? 0;
    for (const event of record.events) {
      if (event.type === 'TimeAdvanced') {
        const crossed = Math.floor((event as { after: number }).after / RULES.METABOLISM_INTERVAL_MIN)
          - Math.floor((event as { before: number }).before / RULES.METABOLISM_INTERVAL_MIN);
        if (crossed > 0) hunger = Math.min(RULES.HUNGER_MAX, hunger + crossed);
        simTime = (event as { after: number }).after;
        if (simTime >= need.atSimTime) break;
      } else if (event.type === 'HungerChanged' && (event as { npcId: string }).npcId === need.actorId && simTime < need.atSimTime) {
        hunger = (event as { after: number }).after;
      }
    }
    if (hunger < NEED_HUNGER_AT_LEAST) {
      issues.push(`${need.actorId}: need granted at hunger floor ${hunger} < ${NEED_HUNGER_AT_LEAST}`);
    }
  }
  return issues;
}
