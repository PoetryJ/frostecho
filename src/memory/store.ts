/**
 * Event-sourced memory for one observer at a time (D).
 *
 * Layers, kept separate on purpose:
 *   1. raw records      - append-only, one per (observerId, eventId);
 *   2. sourced memories - each record carries sourceEventIds and knowledge time;
 *   3. derived indexes  - promise/social projections rebuilt from raw records;
 *   4. current context  - bounded retrieval with truncation and explicit status.
 *
 * A character only sees what it actually observed. The engine knowing that a
 * request was cancelled does not make a distant NPC know it.
 */
import { createHash } from 'node:crypto';

export type Source = 'engine' | 'player_statement' | 'inference';
export type Authority = 'engine' | 'player' | 'npc' | 'third_party' | 'inference';
export type QueryStatus = 'ok' | 'empty' | 'incomplete';

export const MEMORY_POLICY_VERSION = 'memory-policy/1';

export interface MemoryRecordInput {
  eventId: string;
  observerId: string;
  occurredAt: number;
  observedAt: number;
  kind: string;
  subjectIds: string[];
  payload: unknown;
  source: Source;
  authority: Authority;
  relatedRequestId?: string;
  supersedes?: string[];
  retracts?: string[];
  sourceEventIds?: string[];
}

export interface MemoryRecord extends MemoryRecordInput {
  recordId: string;
  revision: number;
  sourceEventIds: string[];
}

export interface PromiseView {
  promiseId: string;
  fromId: string;
  toId: string;
  text: string;
  status: 'active' | 'cancelled' | 'kept' | 'broken' | 'unresolved';
  lastRevision: number;
  evidenceIds: string[];
  cancelledBy?: string;
  unresolvedReason?: string;
  conflicts?: { byId: string; eventId: string }[];
}

export interface RetrievedItem {
  recordId: string;
  kind: string;
  occurredAt: number;
  observedAt: number;
  subjectIds: string[];
  payload: unknown;
  evidenceIds: string[];
  source: Source;
  authority: Authority;
  stale: boolean;
  score: number;
  effective?: { promiseId: string; status: PromiseView['status'] };
}

export interface QueryResult {
  schema: 'frostecho.memory-query/1';
  observerId: string;
  items: RetrievedItem[];
  evidenceIds: string[];
  memoryPolicyVersion: string;
  memorySnapshotHash: string;
  queryStatus: QueryStatus;
  truncation: { truncated: boolean; omitted: number; reason: string | null };
  promises: PromiseView[];
}

export interface QueryOptions {
  observerId: string;
  now: number;
  kinds?: string[];
  subjectIds?: string[];
  text?: string;
  topK?: number;
  staleAfter?: number;
  goalRef?: string;
}

export class MemoryQueryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MemoryQueryError';
    this.code = code;
  }
}

interface RelationState {
  fromId: string;
  toId: string;
  trust: number;
  grievance: number;
  debt: number;
  evidenceIds: string[];
}

const RELATION_DELTAS: Record<string, { trust?: number; grievance?: number; debt?: number }> = {
  promise_kept: { trust: 0.1 },
  promise_broken: { trust: -0.2, grievance: 0.2 },
  give: { debt: 0.1, trust: 0.05 },
  rescue: { trust: 0.3, debt: 0.2 },
  snatch: { trust: -0.3, grievance: 0.3 },
  // a legitimate retraction is not betrayal; no relation delta
  promise_retract: {},
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

export class MemoryStore {
  private readonly records: MemoryRecord[] = [];
  private readonly byObserver = new Map<string, MemoryRecord[]>();
  private readonly seen = new Set<string>();
  private readonly social = new Map<string, RelationState>();

  policyVersion = MEMORY_POLICY_VERSION;

  append(input: MemoryRecordInput): { record: MemoryRecord; duplicate: boolean } {
    const key = `${input.observerId}\u0000${input.eventId}`;
    if (this.seen.has(key)) {
      const existing = this.byObserver.get(input.observerId)!.find(record => record.eventId === input.eventId)!;
      return { record: existing, duplicate: true };
    }
    const previous = this.byObserver.get(input.observerId)?.length ?? 0;
    const record: MemoryRecord = {
      ...input,
      recordId: `m-${sha256(`${input.observerId}|${input.eventId}`).slice(0, 16)}`,
      revision: previous + 1,
      subjectIds: [...new Set(input.subjectIds)],
      sourceEventIds: [input.eventId],
    };
    this.records.push(record);
    this.seen.add(key);
    if (!this.byObserver.has(input.observerId)) this.byObserver.set(input.observerId, []);
    this.byObserver.get(input.observerId)!.push(record);
    this.applyRelation(record);
    return { record, duplicate: false };
  }

  private applyRelation(record: MemoryRecord): void {
    const delta = RELATION_DELTAS[record.kind];
    if (!delta) return;
    const payload = record.payload as Record<string, unknown> | null;
    const fromId = String(payload?.fromId ?? record.subjectIds[0] ?? '');
    const toId = String(payload?.toId ?? record.subjectIds[1] ?? '');
    if (!fromId || !toId) return;
    const key = `${record.observerId}\u0000${fromId}\u0000${toId}`;
    const state = this.social.get(key) ?? { fromId, toId, trust: 0, grievance: 0, debt: 0, evidenceIds: [] };
    state.trust += delta.trust ?? 0;
    state.grievance += delta.grievance ?? 0;
    state.debt += delta.debt ?? 0;
    state.evidenceIds.push(record.recordId);
    this.social.set(key, state);
  }

  /** Promise projection computed from what this observer has seen by `now`. */
  promises(observerId: string, now: number): PromiseView[] {
    const records = (this.byObserver.get(observerId) ?? [])
      .filter(record => record.observedAt <= now)
      .sort((left, right) => left.occurredAt - right.occurredAt || left.revision - right.revision);
    const views = new Map<string, PromiseView>();
    for (const record of records) {
      const payload = record.payload as Record<string, unknown> | null;
      const promiseId = typeof payload?.promiseId === 'string' ? payload.promiseId : null;
      if (!promiseId) continue;
      if (record.kind === 'promise_made') {
        views.set(promiseId, {
          promiseId,
          fromId: String(payload?.fromId ?? ''),
          toId: String(payload?.toId ?? ''),
          text: String(payload?.text ?? ''),
          status: 'active',
          lastRevision: record.revision,
          evidenceIds: [record.recordId],
        });
        continue;
      }
      const view = views.get(promiseId);
      if (!view) continue;
      view.evidenceIds.push(record.recordId);
      view.lastRevision = record.revision;
      if (record.kind === 'promise_retract') {
        // Only the two parties to the promise may release it: the promisor
        // withdrawing, or the promisee saying it is no longer needed.
        const byId = String(payload?.byId ?? '');
        const authorized = byId === view.fromId || byId === view.toId;
        if (authorized) {
          view.status = 'cancelled';
          view.cancelledBy = byId;
        } else {
          // An unauthorised attempt never overrides a decided promise; it is
          // kept visible as a conflict.
          view.conflicts = [...(view.conflicts ?? []),
            { byId: byId || 'unknown', eventId: record.eventId }];
          if (view.status === 'active') {
            view.status = 'unresolved';
            view.unresolvedReason = `retraction by unauthorised ${byId || 'unknown'}`;
          }
        }
      } else if (record.kind === 'promise_kept') {
        view.status = 'kept';
      } else if (record.kind === 'promise_broken') {
        view.status = 'broken';
      }
    }
    return [...views.values()];
  }

  relation(observerId: string, fromId: string, toId: string): RelationState | null {
    return this.social.get(`${observerId}\u0000${fromId}\u0000${toId}`) ?? null;
  }

  query(options: QueryOptions): QueryResult {
    const { observerId, now } = options;
    if (typeof observerId !== 'string' || observerId.length === 0) {
      throw new MemoryQueryError('missing_observer', 'observerId required');
    }
    if (!Number.isFinite(now)) throw new MemoryQueryError('bad_time', 'now must be finite');
    if (options.topK !== undefined && (!Number.isInteger(options.topK) || options.topK < 0)) {
      throw new MemoryQueryError('bad_topk', 'topK must be a non-negative integer');
    }
    const topK = options.topK ?? 8;
    const promises = this.promises(observerId, now);
    const promiseStatus = new Map(promises.map(view => [view.promiseId, view]));
    const visible = (this.byObserver.get(observerId) ?? []).filter(record => record.observedAt <= now);
    const candidate = visible.filter(record => {
      if (options.kinds && !options.kinds.includes(record.kind)) return false;
      if (options.subjectIds && !options.subjectIds.some(id => record.subjectIds.includes(id))) return false;
      return true;
    });
    const terms = (options.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const scored = candidate.map(record => {
      const haystack = `${record.kind} ${record.subjectIds.join(' ')} ${canonical(record.payload)}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 2;
      if (options.goalRef && record.relatedRequestId === options.goalRef) score += 3;
      const payload = record.payload as Record<string, unknown> | null;
      const promiseId = typeof payload?.promiseId === 'string' ? payload.promiseId : undefined;
      const view = promiseId ? promiseStatus.get(promiseId) : undefined;
      if (view && view.status === 'active' && record.kind === 'promise_made') score += 2;
      if (view && view.status === 'cancelled' && record.kind === 'promise_retract') score += 2;
      // A known-cancelled promise stays retrievable but must not act as a live
      // instruction next to the retraction that cancelled it.
      if (view && view.status !== 'active' && record.kind === 'promise_made') score -= 5;
      score += 1 / (1 + Math.max(0, now - record.observedAt));
      const stale = now - record.observedAt > (options.staleAfter ?? Number.POSITIVE_INFINITY);
      const item: RetrievedItem = {
        recordId: record.recordId,
        kind: record.kind,
        occurredAt: record.occurredAt,
        observedAt: record.observedAt,
        subjectIds: record.subjectIds,
        payload: record.payload,
        evidenceIds: [...record.sourceEventIds, record.recordId],
        source: record.source,
        authority: record.authority,
        stale,
        score: Number(score.toFixed(6)),
        ...(view ? { effective: { promiseId: view.promiseId, status: view.status } } : {}),
      };
      return item;
    });
    // A known retraction must outrank the stale promise it cancels.
    scored.sort((left, right) => right.score - left.score || right.observedAt - left.observedAt);
    const items = scored.slice(0, topK);
    const omitted = scored.length - items.length;
    const evidenceIds = [...new Set(items.flatMap(item => item.evidenceIds))];
    return {
      schema: 'frostecho.memory-query/1',
      observerId,
      items,
      evidenceIds,
      memoryPolicyVersion: this.policyVersion,
      memorySnapshotHash: this.snapshotHash(),
      queryStatus: visible.length === 0 ? 'empty' : omitted > 0 ? 'incomplete' : 'ok',
      truncation: { truncated: omitted > 0, omitted, reason: omitted > 0 ? 'bounded top-K' : null },
      promises,
    };
  }

  snapshotHash(): string {
    const canonicalRecords = this.records
      .map(record => canonical({ ...record, evidence: record.sourceEventIds }))
      .sort();
    return sha256(canonical({ policy: this.policyVersion, records: canonicalRecords }));
  }

  toJSON(): { schema: string; policyVersion: string; records: MemoryRecord[] } {
    return { schema: 'frostecho.memory-store/1', policyVersion: this.policyVersion, records: this.records };
  }

  static fromJSON(value: unknown): MemoryStore {
    if (typeof value !== 'object' || value === null) throw new MemoryQueryError('bad_store', 'store must be an object');
    const doc = value as { schema?: string; policyVersion?: string; records?: MemoryRecord[] };
    if (doc.schema !== 'frostecho.memory-store/1') throw new MemoryQueryError('bad_schema', 'unexpected store schema');
    if (!Array.isArray(doc.records)) throw new MemoryQueryError('bad_records', 'records must be an array');
    const store = new MemoryStore();
    for (const record of doc.records) store.append(record);
    if (doc.policyVersion) store.policyVersion = doc.policyVersion;
    return store;
  }

  /** Rebuild indexes from raw records; must be hash-equivalent to the original. */
  rebuild(): MemoryStore {
    return MemoryStore.fromJSON(JSON.parse(JSON.stringify(this.toJSON())));
  }
}

/**
 * A result produced against an older snapshot must not overwrite a newer
 * decision, and a calibration identity bound to another memory policy must not
 * be reused after the retrieval/compression policy changed.
 */
export interface SnapshotBinding {
  stateVersion: number;
  memorySnapshotHash: string;
  memoryPolicyVersion: string;
}

export function assertCurrentSnapshot(
  result: SnapshotBinding,
  current: SnapshotBinding,
): void {
  if (result.stateVersion !== current.stateVersion) {
    throw new MemoryQueryError('stale_state',
      `result stateVersion ${result.stateVersion} != current ${current.stateVersion}`);
  }
  if (result.memorySnapshotHash !== current.memorySnapshotHash) {
    throw new MemoryQueryError('stale_memory',
      'result memorySnapshotHash does not match the current snapshot');
  }
}

export function assertCalibrationPolicy(
  calibration: { memoryPolicyVersion?: string },
  store: MemoryStore,
): void {
  if (calibration.memoryPolicyVersion !== store.policyVersion) {
    throw new MemoryQueryError('policy_mismatch',
      `calibration memoryPolicyVersion ${String(calibration.memoryPolicyVersion)} != ${store.policyVersion}`);
  }
}

export interface PlanLike {
  planId: string;
  promiseId: string;
  dependencyRevision: number;
  state: 'planned' | 'invalidated';
}

/**
 * Only a change to a promise this plan depends on invalidates it. Rebuilding
 * an index or appending unrelated events does not trigger global replanning.
 */
export function invalidateDependentPlans<T extends PlanLike>(
  plans: T[],
  promiseId: string,
  status: PromiseView['status'],
  revision: number,
): T[] {
  return plans.map(plan => {
    if (plan.promiseId !== promiseId || status === 'active') return plan;
    if (plan.dependencyRevision >= revision && plan.state === 'invalidated') return plan;
    return { ...plan, state: 'invalidated' as const };
  });
}
