/**
 * The ONE bounded-memory projection.
 *
 * `projectMemory` is the only place that decides which of an actor's own records
 * reach the model, in what order, and at what cost. `step.ts` (and through it
 * the CLI, the web bridge, the data collector and the four-day runner) calls
 * this; the evidence scripts read the projection it returns instead of
 * re-deriving the text. That is what keeps "the bytes the budget governs" and
 * "the bytes the encoder receives" the same bytes.
 *
 * Two rules are enforced here, not by the callers:
 *  - the block never exceeds the budget — including the FIRST record. A single
 *    oversized record is trimmed by `fitFact`, and if even its pointer line does
 *    not fit it is omitted and reported, never admitted whole;
 *  - both selection arms (raw-last12 / obligation-first) get the same budget and
 *    the same candidate set; only their order differs.
 */
import type { ObservedFact } from '../../decision/contracts';
import type { MemoryRecord } from '../../memory/store';
import {
  MEMORY_PROJECTION_ID, MEMORY_UNIT_KIND, canonicalJson, compactFact, fitFact,
  renderMemoryBlock, renderMemoryLine, renderMemorySegment, resolveMemoryEncoder,
  resolveTokenCounter,
  sha256Of, utf8Bytes, type FittedFact, type MemoryEncoderPort, type MemoryTruncationRecord,
  type TokenCounter,
} from '../jev/token-budget';

export type MemorySelection = 'raw-last12' | 'obligation-first';

const MEMORY_PRIORITY: Record<string, number> = {
  task_proposed: 100, task_accepted: 100, task_reassigned: 100, task_countered: 100,
  commitment_proposed: 100, commitment_accepted: 100, commitment_change_proposed: 100,
  commitment_change_accepted: 90, commitment_change_rejected: 90, commitment_resumed: 90,
  out_of_stock: 80, stock_restocked: 80, stock_deposited: 80, stock_withdrawn: 80,
  warehouse_stock_observed: 80, restock_rumor: 80, commitment_cancelled: 80,
  commitment_withdrawn: 80, commitment_fulfilled: 80, commitment_declined: 80,
  promise_kept: 70, promise_broken: 70, task_vacated: 70, commitment_action_committed: 70,
};

/** Priority of one record for the next decision; ties break on recency. */
export function memoryPriority(kind: string): number {
  return MEMORY_PRIORITY[kind] ?? 10;
}

/** The record fields the projection reads; structurally a `MemoryRecord`. */
export type MemoryWindowRecord = Pick<MemoryRecord, 'recordId' | 'kind' | 'observedAt'
  | 'occurredAt' | 'authority' | 'speakerId' | 'source' | 'sourceEventIds' | 'subjectIds'
  | 'payload'>;

export interface MemoryCursor {
  /** Records this actor holds (the cursor advances by exactly this much). */
  records: number;
  /** Records that entered the window. */
  keptRecords: number;
  /** Identity of the newest record the actor has; stable across a restore. */
  lastRecordId: string | null;
  lastObservedAt: number | null;
}

export interface MemoryProjection {
  schema: 'frostecho.memory-projection/1';
  projectionId: string;
  actorId: string;
  selection: MemorySelection;
  /** Budget in `unitId` units; 0 is legal and means "nothing may be rendered". */
  budgetUnits: number;
  /** Budget the caller asked for (a negative request is clamped to 0 and shown). */
  budgetRequested: number;
  unitId: string;
  unitKind: typeof MEMORY_UNIT_KIND;
  facts: ObservedFact[];
  /** Exactly the text the renderer puts after `记忆:` (no header, no trailing NL). */
  block: string;
  /** `\n记忆:\n` + block: the segment the encoder receives. */
  segment: string;
  bytes: number;
  segmentBytes: number;
  blockSha256: string;
  segmentSha256: string;
  units: number;
  /**
   * Legacy name of `units`, kept for readers written before the estimate and the
   * tokenizer count were separated. It is ALWAYS an estimate: see `unitKind`.
   */
  tokens: number;
  /** Legacy name of `budgetUnits`, in the same estimated units. */
  budgetTokens: number;
  kept: number;
  dropped: number;
  suppressed: number;
  truncated: boolean;
  truncatedFacts: MemoryTruncationRecord[];
  /** The real tokenizer count, reported separately from `units`. */
  encoder: { id: string | null; tokens: number | null;
    status: 'counted' | 'not-attached' };
  cursor: MemoryCursor;
  relationships: unknown;
}

export interface MemoryProjectionInput {
  actorId: string;
  /** ALL records of this actor, in observation order. */
  records: readonly MemoryWindowRecord[];
  topK?: number;
  selection?: MemorySelection;
  budgetUnits?: number;
  counter?: TokenCounter;
  encoder?: MemoryEncoderPort | null;
  /**
   * Event ids already carried by another prompt channel (an applicable
   * experience note): a record whose evidence is owned there is not billed
   * again as a memory entry.
   */
  excludeEventIds?: readonly string[];
  relationships?: unknown;
}

/** One stored record as the actor may see it, with its provenance intact. */
export function factOf(actorId: string, record: MemoryWindowRecord): ObservedFact {
  return {
    eventId: record.sourceEventIds[0] ?? record.recordId,
    observerId: actorId,
    // When THIS actor learned it, not when the event happened.
    simTime: record.observedAt,
    subjectIds: record.subjectIds.length > 0 ? [...record.subjectIds] : [actorId],
    kind: record.kind,
    payload: {
      ...((record.payload as Record<string, unknown> | undefined) ?? {}),
      occurredAt: record.occurredAt,
      authority: record.authority,
      speakerId: record.speakerId ?? null,
      sourceEventIds: [...record.sourceEventIds],
    },
    // Provenance is carried, never forced: a player statement stays a player
    // statement and an inference stays an inference.
    source: record.source === 'player_statement' ? 'player_statement'
      : record.source === 'inference' ? 'inference' : 'engine',
  };
}

interface Candidate { record: MemoryWindowRecord; index: number; fact: ObservedFact }

/**
 * Order the candidates exactly as the arm says, then fill the window greedily in
 * that order. Room is reserved for the records further down the order (their
 * compact identity line), so a single long obligation cannot erase every other
 * fact; the top-priority record still gets whatever detail fits.
 */
function select(candidates: readonly Candidate[], topK: number, budgetUnits: number,
  counter: TokenCounter):
  { chosen: { candidate: Candidate; fitted: FittedFact }[]; omitted: MemoryTruncationRecord[] } {
  const chosen: { candidate: Candidate; fitted: FittedFact }[] = [];
  const omitted: MemoryTruncationRecord[] = [];
  if (budgetUnits <= 0) {
    for (const candidate of candidates.slice(0, topK)) {
      const compact = compactFact(candidate.fact, counter);
      if (compact.truncation) omitted.push({ ...compact.truncation, level: 'omitted' });
    }
    return { chosen, omitted };
  }
  const admitted: ObservedFact[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (chosen.length >= topK) break;
    const candidate = candidates[index];
    const remaining = budgetUnits - counter.count(renderMemoryBlock(admitted));
    if (remaining <= 0) {
      const compact = compactFact(candidate.fact, counter);
      if (compact.truncation) omitted.push(compact.truncation);
      continue;
    }
    // 1. A record that fits whole is admitted whole: the common case must not
    //    pay for trimming, and no admitted record is ever evicted for news.
    const whole = counter.count(renderMemoryBlock([...admitted, candidate.fact]));
    if (whole <= budgetUnits) {
      chosen.push({ candidate, fitted: { fact: candidate.fact, truncation: null,
        units: whole } });
      admitted.push(candidate.fact);
      continue;
    }
    // 2. A record that does not fit whole is TRIMMED, not admitted as-is.
    const compact = compactFact(candidate.fact, counter);
    const minimum = counter.count(renderMemoryBlock([...admitted, compact.fact]));
    if (minimum > budgetUnits) {
      // Even its pointer line does not fit: omitted, and reported as such.
      if (compact.truncation) omitted.push({ ...compact.truncation, level: 'omitted' });
      continue;
    }
    // Room is reserved for the records further down the order (their pointer
    // line + one join newline), capped at two thirds of what is left, so one
    // long obligation cannot erase every other fact. Two guards keep the
    // reservation honest: it never takes the CURRENT record below its identity
    // line, and it is dropped entirely when it could not buy a single slot
    // anyway (spending identity fields on nothing).
    let slotsLeft = topK - chosen.length - 1;
    let reserve = 0;
    let largestLater = 0;
    for (let later = index + 1; later < candidates.length && slotsLeft > 0; later += 1) {
      const compactLater = compactFact(candidates[later].fact, counter).units + 1;
      largestLater = Math.max(largestLater, compactLater);
      reserve += compactLater;
      slotsLeft -= 1;
      if (reserve >= Math.floor(remaining * 2 / 3)) break;
    }
    reserve = Math.min(reserve, Math.floor(remaining * 2 / 3));
    const reservedCap = budgetUnits - reserve;
    const cap = reservedCap >= minimum && reserve >= largestLater
      ? reservedCap : budgetUnits;
    const fitted = fitFact(candidate.fact, cap, counter, admitted);
    if (!fitted) {
      if (compact.truncation) omitted.push({ ...compact.truncation, level: 'omitted' });
      continue;
    }
    chosen.push({ candidate, fitted });
    admitted.push(fitted.fact);
  }
  // Belt and braces: the block is the billed object, so the LAST admitted (the
  // lowest-priority) record goes if the joined block still exceeds the budget.
  while (chosen.length > 0
    && counter.count(renderMemoryBlock(chosen.map(entry => entry.fitted.fact))) > budgetUnits) {
    const dropped = chosen.pop()!;
    if (dropped.fitted.truncation) omitted.push({ ...dropped.fitted.truncation, level: 'omitted' });
  }
  return { chosen, omitted };
}

export function projectMemory(input: MemoryProjectionInput): MemoryProjection {
  const counter = resolveTokenCounter(input.counter);
  const encoder = resolveMemoryEncoder(input.encoder);
  const topK = Math.max(0, Math.floor(input.topK ?? 12));
  const selection: MemorySelection = input.selection ?? 'obligation-first';
  const budgetRequested = Number.isFinite(input.budgetUnits) ? Number(input.budgetUnits) : 0;
  const budgetUnits = Math.max(0, Math.floor(budgetRequested));

  const all = [...input.records].filter(record => record !== null && record !== undefined);
  const occupied = new Set(input.excludeEventIds ?? []);
  const records = occupied.size === 0 ? all
    : all.filter(record => !record.sourceEventIds.some(id => occupied.has(id)));
  const suppressed = all.length - records.length;

  const indexed: Candidate[] = records.map((record, index) => ({ record, index,
    fact: factOf(input.actorId, record) }));
  const ordered = selection === 'raw-last12'
    ? indexed.slice(Math.max(0, indexed.length - topK)).reverse()
    : [...indexed].sort((left, right) =>
      memoryPriority(right.record.kind) - memoryPriority(left.record.kind)
      || right.index - left.index
      || left.record.recordId.localeCompare(right.record.recordId));

  const { chosen, omitted } = select(ordered, topK, budgetUnits, counter);
  chosen.sort((left, right) => left.candidate.index - right.candidate.index);
  const facts = chosen.map(entry => entry.fitted.fact);
  const truncations = chosen.map(entry => entry.fitted.truncation)
    .filter((entry): entry is MemoryTruncationRecord => entry !== null);
  const block = renderMemoryBlock(facts);
  const segment = facts.length === 0 ? '' : renderMemorySegment(facts);
  const units = counter.count(block);
  const last = all.length > 0 ? all[all.length - 1] : null;
  return {
    schema: 'frostecho.memory-projection/1',
    projectionId: MEMORY_PROJECTION_ID,
    actorId: input.actorId,
    selection,
    budgetUnits,
    budgetRequested,
    unitId: counter.id,
    unitKind: MEMORY_UNIT_KIND,
    facts,
    block,
    segment,
    bytes: utf8Bytes(block),
    segmentBytes: utf8Bytes(segment),
    blockSha256: sha256Of(block),
    segmentSha256: sha256Of(segment),
    units,
    tokens: units,
    budgetTokens: budgetUnits,
    kept: facts.length,
    dropped: records.length - facts.length,
    suppressed,
    truncated: truncations.length > 0 || omitted.length > 0,
    truncatedFacts: [...truncations, ...omitted],
    encoder: encoder === null
      ? { id: null, tokens: null, status: 'not-attached' }
      : { id: encoder.id, tokens: encoder.count(block), status: 'counted' },
    cursor: {
      records: all.length,
      keptRecords: facts.length,
      lastRecordId: last?.recordId ?? null,
      lastObservedAt: last?.observedAt ?? null,
    },
    relationships: input.relationships ?? {},
  };
}

/** Stable identity of a projection for evidence: rule, counter, budget, bytes. */
export function projectionIdentity(projection: MemoryProjection): string {
  return sha256Of(canonicalJson({ projectionId: projection.projectionId,
    selection: projection.selection, budget: projection.budgetUnits,
    unitId: projection.unitId, blockSha256: projection.blockSha256,
    kept: projection.kept }));
}
