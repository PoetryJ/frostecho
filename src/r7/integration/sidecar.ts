/**
 * The four-day path must persist the SAME board the CLI persists.
 *
 * `R8Runtime.save` only writes the session plus the R8 domain sidecar; the
 * task board, commitments, council, experience and decision memory live on
 * `GameplayLoop`. A runner that calls only `runtime.save()` therefore loses
 * every promise on restore: the promises silently disappear while the world
 * clock and the NPCs come back. This module is the one save/restore bundle
 * used by the four-day runner and by the tests, and it is byte-for-byte the
 * same file set the CLI (`play-sprint`) writes:
 *
 *   <base>                          session
 *   <base>.tasks.json               task board
 *   <base>.experience.json          experience store
 *   <base>.commitments.json         commitment board
 *   <base>.council.json             council records
 *   <base>.long-term-memory.json    decision memory
 *   <base>.r8.json                  R8 domains + intents + receipts
 */
import { existsSync } from 'node:fs';
import { GameplayLoop } from '../../gameplay-v2/loop';
import type { Commitment } from '../../gameplay-v2/commitments';
import type { ActionIntent } from './action-intent';
import { R8Runtime } from './runtime';

export const FOUR_DAY_SIDECAR_SUFFIXES = ['', '.tasks.json', '.experience.json',
  '.commitments.json', '.council.json', '.long-term-memory.json', '.r8.json'] as const;

export type FourDaySidecarPaths = {
  session: string; tasks: string; experience: string; commitments: string;
  council: string; longTermMemory: string; runtime: string;
};

export function fourDaySidecarPaths(base: string): FourDaySidecarPaths {
  return {
    session: base,
    tasks: `${base}.tasks.json`,
    experience: `${base}.experience.json`,
    commitments: `${base}.commitments.json`,
    council: `${base}.council.json`,
    longTermMemory: `${base}.long-term-memory.json`,
    runtime: `${base}.r8.json`,
  };
}

/** Every file the CLI writes for a Gospel save. Missing ones are a real loss. */
export function requireFourDaySidecars(base: string): FourDaySidecarPaths {
  const paths = fourDaySidecarPaths(base);
  const missing = Object.values(paths).filter(path => !existsSync(path));
  if (missing.length > 0) throw new Error(`missing_four_day_sidecar:${missing.join(',')}`);
  return paths;
}

/**
 * The CLI save order: the gameplay boards first, then the R8 sidecar. Both
 * write the session document; they always describe the same session object.
 */
export function saveFourDaySidecars(runtime: R8Runtime, play: GameplayLoop,
  base: string): FourDaySidecarPaths {
  if (runtime.session !== play.session) {
    throw new Error('four-day save requires one shared session');
  }
  play.save(base);
  runtime.save(base);
  return fourDaySidecarPaths(base);
}

export interface FourDayState {
  runtime: R8Runtime;
  play: GameplayLoop;
}

/** The CLI restore composition: R8 is the authority, boards ride on it. */
export function loadFourDaySidecars(base: string): FourDayState {
  requireFourDaySidecars(base);
  const legacy = GameplayLoop.load(base);
  const runtime = R8Runtime.load(base);
  const play = new GameplayLoop(runtime.session, legacy.board, {
    experience: legacy.experience,
    commitments: legacy.commitments,
    council: legacy.council,
    longTermMemory: legacy.longTermMemory,
    memoryArm: legacy.memoryArm,
    decisionMemoryMode: legacy.decisionMemoryMode,
    decisionMemoryTokenBudget: legacy.decisionMemoryTokenBudget,
  });
  return { runtime, play };
}

export interface CommitmentAudit {
  commitmentId: string;
  goal: string;
  status: string;
  revision: number;
  /** When the last real transition happened (receipt time, not process time). */
  updatedAt: number;
  evidenceEventIds: string[];
  uniqueEvidence: boolean;
  /** Per observer: how many `commitment_fulfilled` records it holds. */
  fulfilRecordsByObserver: Record<string, number>;
  /** Per observer: how many `promise_kept` relation records it holds. */
  promiseKeptByObserver: Record<string, number>;
  /** Applied ledger projections that name this commitment, across all intents. */
  appliedProjections: number;
  settledOnce: boolean;
}

export interface IntentAudit {
  intentId: string;
  actorId: string;
  action: string;
  demandId: string;
  status: string;
  receiptIds: string[];
  claims: number;
  appliedClaims: number;
  /** Applied claims for the same ledger row inside THIS intent. */
  duplicatedTargets: string[];
  /** Terminal transitions recorded for this intent (must be exactly one). */
  settleLogEntries: number;
  projectionOnce: boolean;
}

export interface SettlementAudit {
  schema: 'frostecho.r10.settlement-audit/1';
  clock: number;
  commitments: CommitmentAudit[];
  intents: IntentAudit[];
  pendingIntents: number;
  duplicateDemands: number;
  duplicates: {
    settledTwice: string[];
    projectedTwice: string[];
    duplicateFulfilments: string[];
  };
  ok: boolean;
}

function countByObserver(runtime: R8Runtime, kind: string,
  matches: (payload: Record<string, unknown>) => boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const actorId of runtime.session.npcIds) {
    const records = runtime.session.memories.get(actorId)?.toJSON().records ?? [];
    counts[actorId] = records.filter(record => record.observerId === actorId
      && record.kind === kind
      && matches((record.payload as Record<string, unknown> | null) ?? {})).length;
  }
  return counts;
}

/**
 * Re-derive the two R10 claims from the persisted state alone:
 *   - every promise is settled at most once (one real fulfilment record per
 *     observer, one evidence id, at most one applied commitment projection);
 *   - every intent is projected at most once (one terminal log entry, and no
 *     ledger row applied twice).
 */
export function auditSettlement(runtime: R8Runtime, play: GameplayLoop): SettlementAudit {
  const settleLogEntries = new Map<string, number>();
  for (const entry of runtime.workLog) {
    settleLogEntries.set(entry.intentId, (settleLogEntries.get(entry.intentId) ?? 0) + 1);
  }
  const appliedClaimsByTarget = new Map<string, number>();
  const intents: IntentAudit[] = [];
  for (const intent of runtime.intents.values() as IterableIterator<ActionIntent>) {
    const applied = intent.projections.filter(claim => claim.applied);
    const inside = new Map<string, number>();
    for (const claim of applied) {
      const target = `${claim.kind}:${claim.id}`;
      inside.set(target, (inside.get(target) ?? 0) + 1);
      appliedClaimsByTarget.set(target, (appliedClaimsByTarget.get(target) ?? 0) + 1);
    }
    const duplicatedTargets = [...inside.entries()].filter(([, count]) => count > 1)
      .map(([target]) => target).sort();
    const logs = settleLogEntries.get(intent.intentId) ?? 0;
    intents.push({
      intentId: intent.intentId, actorId: intent.actorId,
      action: String(intent.candidate.parameters.action ?? ''),
      demandId: intent.demandId ?? '', status: intent.status,
      receiptIds: [...intent.receiptIds],
      claims: intent.projections.length, appliedClaims: applied.length,
      duplicatedTargets, settleLogEntries: logs,
      projectionOnce: duplicatedTargets.length === 0 && logs <= 1,
    });
  }
  intents.sort((left, right) => left.intentId.localeCompare(right.intentId));

  const commitments: CommitmentAudit[] = play.commitments.all().map((row: Commitment) => {
    const fulfilRecordsByObserver = countByObserver(runtime, 'commitment_fulfilled',
      payload => payload.commitmentId === row.commitmentId);
    // The relation record carries `promiseId` (`cm-<commitmentId>`), not the
    // commitment id, so match both spellings rather than counting zero forever.
    const promiseId = `cm-${row.commitmentId}`;
    const promiseKeptByObserver = countByObserver(runtime, 'promise_kept',
      payload => payload.promiseId === promiseId || payload.promiseId === row.commitmentId
        || (payload.confirmation as Record<string, unknown> | undefined)?.promiseId === promiseId);
    const uniqueEvidence = new Set(row.evidenceEventIds).size === row.evidenceEventIds.length;
    const appliedProjections = appliedClaimsByTarget.get(`commitment:${row.commitmentId}`) ?? 0;
    const settledOnce = uniqueEvidence && appliedProjections <= 1
      && Object.values(fulfilRecordsByObserver).every(count => count <= 1)
      && Object.values(promiseKeptByObserver).every(count => count <= 1);
    return {
      commitmentId: row.commitmentId, goal: row.goal, status: row.status,
      revision: row.revision, updatedAt: row.updatedAt,
      evidenceEventIds: [...row.evidenceEventIds],
      uniqueEvidence, fulfilRecordsByObserver, promiseKeptByObserver,
      appliedProjections, settledOnce,
    };
  }).sort((left, right) => left.commitmentId.localeCompare(right.commitmentId));

  const settledTwice = intents.filter(intent => intent.settleLogEntries > 1)
    .map(intent => intent.intentId);
  const projectedTwice = [...appliedClaimsByTarget.entries()]
    .filter(([, count]) => count > 1).map(([target]) => target).sort();
  const duplicateFulfilments = commitments.filter(commitment => !commitment.settledOnce)
    .map(commitment => commitment.commitmentId);
  const pendingIntents = [...runtime.intents.values()]
    .filter(intent => intent.status === 'working').length;

  return {
    schema: 'frostecho.r10.settlement-audit/1',
    clock: runtime.world.simTime,
    commitments, intents, pendingIntents,
    duplicateDemands: runtime.duplicateDemands.length,
    duplicates: { settledTwice, projectedTwice, duplicateFulfilments },
    ok: settledTwice.length === 0 && projectedTwice.length === 0
      && duplicateFulfilments.length === 0
      && intents.every(intent => intent.projectionOnce),
  };
}
